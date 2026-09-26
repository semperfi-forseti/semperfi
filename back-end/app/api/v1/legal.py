from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TypeVar

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import (
    AppointmentCreate,
    ClientCreate,
    ClientRead,
    DeadlineCreate,
    FinancialEntryCreate,
    IntimationCreate,
    ProcessCreate,
    ProcessMovementCreate,
    ProcessRead,
)
from app.audit import append_audit
from app.db import get_db
from app.models import (
    Appointment,
    Client,
    Deadline,
    FinancialEntry,
    Intimation,
    LegalProcess,
    ProcessMovement,
)
from app.policies import PolicyContext, policy_engine
from app.security import Principal, cipher, get_current_principal

router = APIRouter(tags=["Legal core"])
T = TypeVar("T")


def _mask_document(value: str | None) -> str | None:
    if not value:
        return None
    digits = "".join(char for char in value if char.isdigit())
    return f"***.***.***-{digits[-2:]}" if len(digits) == 11 else f"**.***.***/****-{digits[-2:]}"


async def _policy(session: AsyncSession, principal: Principal, request: Request, action: str) -> str:
    cid = correlation_id(request)
    decision = await policy_engine.evaluate(session, principal, PolicyContext(action=action), cid)
    if decision.effect != "allow":
        raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    return cid


async def _record(session: AsyncSession, principal: Principal, request: Request, action: str, resource: str, resource_id: uuid.UUID | None, cid: str) -> None:
    await append_audit(session, principal, request, action=action, resource_type=resource, resource_id=resource_id, correlation_id=cid)


async def _get(session: AsyncSession, model: type[T], tenant_id: uuid.UUID, item_id: uuid.UUID) -> T:
    item = await session.scalar(select(model).where(model.id == item_id, model.tenant_id == tenant_id, model.deleted_at.is_(None)))
    if not item:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return item


async def _validate_links(
    session: AsyncSession, tenant_id: uuid.UUID,
    client_id: uuid.UUID | None = None, process_id: uuid.UUID | None = None,
) -> LegalProcess | None:
    """A foreign key alone does not establish tenant ownership or active state."""
    if client_id is not None:
        await _get(session, Client, tenant_id, client_id)
    process = await _get(session, LegalProcess, tenant_id, process_id) if process_id else None
    if process and client_id is not None and process.client_id != client_id:
        raise HTTPException(status_code=422, detail="O processo selecionado não pertence ao cliente informado.")
    return process


@router.get("/clients", response_model=list[ClientRead])
async def list_clients(
    request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)
):
    cid = await _policy(session, principal, request, "client.list")
    rows = list((await session.scalars(select(Client).where(Client.tenant_id == principal.tenant_id, Client.deleted_at.is_(None)).order_by(Client.name))).all())
    await _record(session, principal, request, "client.list", "client", None, cid); await session.commit()
    return [ClientRead(id=row.id, kind=row.kind, name=row.name, document_masked=_mask_document(cipher.decrypt(row.document_ciphertext)), responsible=row.responsible, status=row.status, created_at=row.created_at) for row in rows]


@router.post("/clients", response_model=ClientRead, status_code=status.HTTP_201_CREATED)
async def create_client(
    body: ClientCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)
):
    cid = await _policy(session, principal, request, "client.create")
    item = Client(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, kind=body.kind, name=body.name, document_ciphertext=cipher.encrypt(body.document), document_fingerprint=cipher.fingerprint(body.document), email_ciphertext=cipher.encrypt(body.email), phone_ciphertext=cipher.encrypt(body.phone), address_ciphertext=cipher.encrypt(body.address), responsible=body.responsible, status=body.status, notes=body.notes)
    session.add(item); await session.flush(); await _record(session, principal, request, "client.create", "client", item.id, cid); await session.commit(); await session.refresh(item)
    return ClientRead(id=item.id, kind=item.kind, name=item.name, document_masked=_mask_document(body.document), responsible=item.responsible, status=item.status, created_at=item.created_at)


@router.get("/clients/{client_id}")
async def get_client(client_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "client.read"); item = await _get(session, Client, principal.tenant_id, client_id)
    await _record(session, principal, request, "client.read", "client", item.id, cid); await session.commit()
    return {"id": item.id, "kind": item.kind, "name": item.name, "document": cipher.decrypt(item.document_ciphertext), "email": cipher.decrypt(item.email_ciphertext), "phone": cipher.decrypt(item.phone_ciphertext), "address": cipher.decrypt(item.address_ciphertext), "responsible": item.responsible, "status": item.status, "notes": item.notes}


@router.patch("/clients/{client_id}")
async def update_client(client_id: uuid.UUID, body: ClientCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "client.update"); item = await _get(session, Client, principal.tenant_id, client_id)
    for key, value in {"kind": body.kind, "name": body.name, "responsible": body.responsible, "status": body.status, "notes": body.notes}.items(): setattr(item, key, value)
    item.document_ciphertext, item.document_fingerprint = cipher.encrypt(body.document), cipher.fingerprint(body.document)
    item.email_ciphertext, item.phone_ciphertext, item.address_ciphertext = cipher.encrypt(body.email), cipher.encrypt(body.phone), cipher.encrypt(body.address)
    item.updated_by = principal.user_id; await _record(session, principal, request, "client.update", "client", item.id, cid); await session.commit()
    return {"id": item.id, "updated": True}


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client(client_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "client.delete"); item = await _get(session, Client, principal.tenant_id, client_id)
    has_process = await session.scalar(select(LegalProcess.id).where(LegalProcess.client_id == item.id, LegalProcess.tenant_id == principal.tenant_id, LegalProcess.deleted_at.is_(None)).limit(1))
    if has_process: raise HTTPException(status_code=409, detail="Cliente possui processos ativos e não pode ser excluído.")
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"
    await _record(session, principal, request, "client.delete", "client", item.id, cid); await session.commit()


@router.get("/processes", response_model=list[ProcessRead])
async def list_processes(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.list")
    rows = list((await session.scalars(select(LegalProcess).where(LegalProcess.tenant_id == principal.tenant_id, LegalProcess.deleted_at.is_(None)).order_by(LegalProcess.number))).all())
    await _record(session, principal, request, "process.list", "process", None, cid); await session.commit()
    return [ProcessRead.model_validate(row) for row in rows]


@router.post("/processes", response_model=ProcessRead, status_code=status.HTTP_201_CREATED)
async def create_process(body: ProcessCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.create"); await _get(session, Client, principal.tenant_id, body.client_id)
    item = LegalProcess(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, **body.model_dump())
    session.add(item); await session.flush(); await _record(session, principal, request, "process.create", "process", item.id, cid); await session.commit(); await session.refresh(item)
    return ProcessRead.model_validate(item)


@router.get("/processes/{process_id}")
async def get_process(process_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.read"); item = await _get(session, LegalProcess, principal.tenant_id, process_id)
    movements = list((await session.scalars(select(ProcessMovement).where(ProcessMovement.process_id == item.id, ProcessMovement.tenant_id == principal.tenant_id, ProcessMovement.deleted_at.is_(None)).order_by(ProcessMovement.occurred_on.desc()))).all())
    await _record(session, principal, request, "process.read", "process", item.id, cid); await session.commit()
    return {"process": ProcessRead.model_validate(item), "movements": [{"id": m.id, "occurred_on": m.occurred_on, "type": m.movement_type, "description": m.description, "source": m.source} for m in movements]}


@router.post("/processes/{process_id}/movements", status_code=status.HTTP_201_CREATED)
async def create_process_movement(process_id: uuid.UUID, body: ProcessMovementCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.update")
    await _get(session, LegalProcess, principal.tenant_id, process_id)
    item = ProcessMovement(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, process_id=process_id, **body.model_dump())
    session.add(item)
    await session.flush()
    await _record(session, principal, request, "process.movement.create", "process_movement", item.id, cid)
    await session.commit()
    return {"id": item.id, "occurred_on": item.occurred_on, "type": item.movement_type, "description": item.description, "source": item.source, "source_reference": item.source_reference, "payload": item.payload}


@router.patch("/process-movements/{movement_id}")
async def update_process_movement(movement_id: uuid.UUID, body: ProcessMovementCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.update")
    item = await _get(session, ProcessMovement, principal.tenant_id, movement_id)
    await _get(session, LegalProcess, principal.tenant_id, item.process_id)
    values = body.model_dump()
    if (item.payload or {}).get("_intimation_launch"):
        values["payload"] = {**body.payload, "intimationId": item.payload["intimationId"],
                             "_intimation_launch": item.payload["_intimation_launch"]}
        values["source_reference"] = item.source_reference
    for key, value in values.items():
        setattr(item, key, value)
    item.updated_by = principal.user_id
    await _record(session, principal, request, "process.movement.update", "process_movement", item.id, cid)
    await session.commit()
    return {"id": item.id, "occurred_on": item.occurred_on, "type": item.movement_type, "description": item.description, "source": item.source, "source_reference": item.source_reference, "payload": item.payload}


@router.delete("/process-movements/{movement_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_process_movement(movement_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.update")
    item = await _get(session, ProcessMovement, principal.tenant_id, movement_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"
    await _record(session, principal, request, "process.movement.delete", "process_movement", item.id, cid)
    await session.commit()


@router.patch("/processes/{process_id}")
async def update_process(process_id: uuid.UUID, body: ProcessCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.update"); item = await _get(session, LegalProcess, principal.tenant_id, process_id)
    await _validate_links(session, principal.tenant_id, client_id=body.client_id)
    for key, value in body.model_dump().items(): setattr(item, key, value)
    item.updated_by = principal.user_id; await _record(session, principal, request, "process.update", "process", item.id, cid); await session.commit(); return {"id": item.id, "updated": True}


@router.delete("/processes/{process_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_process(process_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "process.delete"); item = await _get(session, LegalProcess, principal.tenant_id, process_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"
    await _record(session, principal, request, "process.delete", "process", item.id, cid); await session.commit()


@router.post("/deadlines", status_code=status.HTTP_201_CREATED)
async def create_deadline(body: DeadlineCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "deadline.create"); await _get(session, LegalProcess, principal.tenant_id, body.process_id)
    item = Deadline(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, **body.model_dump())
    session.add(item); await session.flush(); await _record(session, principal, request, "deadline.create", "deadline", item.id, cid); await session.commit(); return {"id": item.id, "status": item.status}


@router.post("/appointments", status_code=status.HTTP_201_CREATED)
async def create_appointment(body: AppointmentCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "appointment.create")
    await _validate_links(session, principal.tenant_id, body.client_id, body.process_id)
    item = Appointment(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, **body.model_dump())
    session.add(item); await session.flush(); await _record(session, principal, request, "appointment.create", "appointment", item.id, cid); await session.commit(); return {"id": item.id, "status": item.status}


@router.post("/intimations", status_code=status.HTTP_201_CREATED)
async def create_intimation(body: IntimationCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "intimation.create")
    if body.process_id: await _get(session, LegalProcess, principal.tenant_id, body.process_id)
    item = Intimation(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, source=body.source, intimation_type=body.intimation_type, process_id=body.process_id, received_at=body.received_at, confidence=body.confidence, status=body.status, content_ciphertext=cipher.encrypt(body.content) or "")
    session.add(item); await session.flush(); await _record(session, principal, request, "intimation.create", "intimation", item.id, cid); await session.commit(); return {"id": item.id, "status": item.status}


@router.post("/financial-entries", status_code=status.HTTP_201_CREATED)
async def create_financial_entry(body: FinancialEntryCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "financial.create")
    await _validate_links(session, principal.tenant_id, body.client_id, body.process_id)
    item = FinancialEntry(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, **body.model_dump())
    session.add(item); await session.flush(); await _record(session, principal, request, "financial.create", "financial_entry", item.id, cid); await session.commit(); return {"id": item.id, "status": item.status}
