from __future__ import annotations

import hashlib
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.legal import _policy, _record, _validate_links
from app.api.v1.schemas import IntimationLaunch
from app.db import get_db
from app.models import Appointment, Deadline, Intimation, ProcessMovement
from app.security import Principal, get_current_principal

router = APIRouter(tags=["Legal core"])


def launch_id(intimation_id: uuid.UUID, resource: str) -> uuid.UUID:
    # Stable primary keys are a final duplicate guard, including concurrent retries.
    return uuid.uuid5(intimation_id, f"semperfi:intimation-launch:{resource}")


def _result(item: Intimation, movement: ProcessMovement, already_launched: bool) -> dict:
    marker = movement.payload["_intimation_launch"]
    return {
        "intimation_id": item.id,
        "process_id": movement.process_id,
        "movement_id": movement.id,
        "deadline_id": marker["deadline_id"],
        "appointment_id": marker["appointment_id"],
        "status": item.status,
        "already_launched": already_launched,
    }


@router.post("/intimations/{intimation_id}/launch", status_code=status.HTTP_201_CREATED)
async def launch_intimation(
    intimation_id: uuid.UUID, body: IntimationLaunch, request: Request, response: Response,
    session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal),
):
    cid = await _policy(session, principal, request, "intimation.update")
    await _policy(session, principal, request, "process.update")
    if body.deadline:
        await _policy(session, principal, request, "deadline.create")
    if body.appointment:
        await _policy(session, principal, request, "appointment.create")
    item = await session.scalar(select(Intimation).where(
        Intimation.id == intimation_id,
        Intimation.tenant_id == principal.tenant_id,
        Intimation.deleted_at.is_(None),
    ).with_for_update())
    if item is None:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")

    digest = hashlib.sha256(json.dumps(
        body.model_dump(mode="json"), sort_keys=True, ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    movement_id = launch_id(item.id, "movement")
    existing = await session.scalar(select(ProcessMovement).where(
        ProcessMovement.id == movement_id,
        ProcessMovement.tenant_id == principal.tenant_id,
    ))
    if existing is not None:
        marker = (existing.payload or {}).get("_intimation_launch", {})
        if existing.deleted_at is not None or marker.get("request_hash") != digest:
            raise HTTPException(status_code=409, detail="Esta intimação já foi lançada. Revise os registros existentes antes de alterar o lançamento.")
        response.status_code = status.HTTP_200_OK
        return _result(item, existing, True)
    if item.process_id is None:
        raise HTTPException(status_code=409, detail="Associe a intimação a um processo antes de lançar.")
    if item.status not in {"received", "triage", "associated", "recebida", "triagem", "associada"}:
        raise HTTPException(status_code=409, detail="A intimação precisa estar recebida, em triagem ou associada para lançar.")
    process = await _validate_links(session, principal.tenant_id, process_id=item.process_id)
    # The client is inherited from the selected process, never accepted independently.
    await _validate_links(session, principal.tenant_id, client_id=process.client_id)

    # PostgreSQL holds the row lock; the conditional update also protects SQLite.
    claimed = await session.execute(update(Intimation).where(
        Intimation.id == item.id,
        Intimation.tenant_id == principal.tenant_id,
        Intimation.deleted_at.is_(None),
        Intimation.status == item.status,
    ).values(status="concluded", updated_by=principal.user_id))
    if claimed.rowcount != 1:
        raise HTTPException(status_code=409, detail="Esta intimação foi alterada. Atualize a tela antes de tentar novamente.")

    common = {"tenant_id": principal.tenant_id, "created_by": principal.user_id, "updated_by": principal.user_id}
    deadline_id = launch_id(item.id, "deadline") if body.deadline else None
    appointment_id = launch_id(item.id, "appointment") if body.appointment else None
    movement = ProcessMovement(
        **common, id=movement_id, process_id=process.id,
        **body.movement.model_dump(), source="manual", source_reference=str(item.id),
        payload={"intimationId": str(item.id), "_intimation_launch": {
            "request_hash": digest,
            "deadline_id": str(deadline_id) if deadline_id else None,
            "appointment_id": str(appointment_id) if appointment_id else None,
        }},
    )
    session.add(movement)
    if body.deadline:
        session.add(Deadline(**common, id=deadline_id, process_id=process.id,
                             **body.deadline.model_dump(), status="pending"))
    if body.appointment:
        session.add(Appointment(**common, id=appointment_id, process_id=process.id,
                                client_id=process.client_id,
                                **body.appointment.model_dump(), status="confirmed"))
    await session.flush()
    for resource, resource_id in [("process_movement", movement_id), ("deadline", deadline_id), ("appointment", appointment_id)]:
        if resource_id:
            await _record(session, principal, request, f"{resource}.create", resource, resource_id, cid)
    await _record(session, principal, request, "intimation.launch", "intimation", item.id, cid)
    await session.commit()
    return _result(item, movement, False)
