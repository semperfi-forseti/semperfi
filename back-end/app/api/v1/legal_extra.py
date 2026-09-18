from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import (
    AppointmentCreate,
    DeadlineCreate,
    DemoImport,
    FinancialEntryCreate,
    IntimationCreate,
)
from app.audit import append_audit
from app.db import get_db
from app.models import Appointment, Client, Deadline, FinancialEntry, Intimation, LegalProcess
from app.policies import PolicyContext, policy_engine
from app.security import Principal, cipher, get_current_principal

router = APIRouter(tags=["Legal core"])


async def _cid(session: AsyncSession, principal: Principal, request: Request, action: str) -> str:
    cid = correlation_id(request); decision = await policy_engine.evaluate(session, principal, PolicyContext(action=action), cid)
    if decision.effect != "allow": raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    return cid


async def _row(session: AsyncSession, model, tenant_id: uuid.UUID, item_id: uuid.UUID):
    item = await session.scalar(select(model).where(model.id == item_id, model.tenant_id == tenant_id, model.deleted_at.is_(None)))
    if not item: raise HTTPException(status_code=404, detail="Registro não encontrado.")
    return item


def _serialize(item):
    return {column.name: getattr(item, column.name) for column in item.__table__.columns if column.name not in {"content_ciphertext", "document_ciphertext", "email_ciphertext", "phone_ciphertext", "address_ciphertext"}}


@router.get("/deadlines")
async def list_deadlines(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "deadline.list"); rows = list((await session.scalars(select(Deadline).where(Deadline.tenant_id == principal.tenant_id, Deadline.deleted_at.is_(None)).order_by(Deadline.due_date))).all())
    await append_audit(session, principal, request, action="deadline.list", resource_type="deadline", resource_id=None, correlation_id=cid); await session.commit(); return [_serialize(x) for x in rows]


@router.patch("/deadlines/{deadline_id}")
async def update_deadline(deadline_id: uuid.UUID, body: DeadlineCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "deadline.update"); item = await _row(session, Deadline, principal.tenant_id, deadline_id)
    for key, value in body.model_dump().items(): setattr(item, key, value)
    item.updated_by = principal.user_id; await append_audit(session, principal, request, action="deadline.update", resource_type="deadline", resource_id=item.id, correlation_id=cid); await session.commit(); return _serialize(item)


@router.delete("/deadlines/{deadline_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_deadline(deadline_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "deadline.delete"); item = await _row(session, Deadline, principal.tenant_id, deadline_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"; await append_audit(session, principal, request, action="deadline.delete", resource_type="deadline", resource_id=item.id, correlation_id=cid); await session.commit()


@router.get("/appointments")
async def list_appointments(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "appointment.list"); rows = list((await session.scalars(select(Appointment).where(Appointment.tenant_id == principal.tenant_id, Appointment.deleted_at.is_(None)).order_by(Appointment.appointment_date))).all())
    await append_audit(session, principal, request, action="appointment.list", resource_type="appointment", resource_id=None, correlation_id=cid); await session.commit(); return [_serialize(x) for x in rows]


@router.patch("/appointments/{appointment_id}")
async def update_appointment(appointment_id: uuid.UUID, body: AppointmentCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "appointment.update"); item = await _row(session, Appointment, principal.tenant_id, appointment_id)
    for key, value in body.model_dump().items(): setattr(item, key, value)
    item.updated_by = principal.user_id; await append_audit(session, principal, request, action="appointment.update", resource_type="appointment", resource_id=item.id, correlation_id=cid); await session.commit(); return _serialize(item)


@router.delete("/appointments/{appointment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_appointment(appointment_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "appointment.delete"); item = await _row(session, Appointment, principal.tenant_id, appointment_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"; await append_audit(session, principal, request, action="appointment.delete", resource_type="appointment", resource_id=item.id, correlation_id=cid); await session.commit()


@router.get("/intimations")
async def list_intimations(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "intimation.list"); rows = list((await session.scalars(select(Intimation).where(Intimation.tenant_id == principal.tenant_id, Intimation.deleted_at.is_(None)).order_by(Intimation.received_at.desc()))).all())
    await append_audit(session, principal, request, action="intimation.list", resource_type="intimation", resource_id=None, correlation_id=cid); await session.commit(); return [{**_serialize(x), "content": cipher.decrypt(x.content_ciphertext)} for x in rows]


@router.patch("/intimations/{intimation_id}")
async def update_intimation(intimation_id: uuid.UUID, body: IntimationCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "intimation.update"); item = await _row(session, Intimation, principal.tenant_id, intimation_id)
    item.source, item.intimation_type, item.process_id, item.received_at, item.confidence, item.status, item.content_ciphertext = body.source, body.intimation_type, body.process_id, body.received_at, body.confidence, body.status, cipher.encrypt(body.content) or ""
    item.updated_by = principal.user_id; await append_audit(session, principal, request, action="intimation.update", resource_type="intimation", resource_id=item.id, correlation_id=cid); await session.commit(); return {**_serialize(item), "content": body.content}


@router.delete("/intimations/{intimation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_intimation(intimation_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "intimation.delete"); item = await _row(session, Intimation, principal.tenant_id, intimation_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"; await append_audit(session, principal, request, action="intimation.delete", resource_type="intimation", resource_id=item.id, correlation_id=cid); await session.commit()


@router.get("/financial-entries")
async def list_financial_entries(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "financial.list"); rows = list((await session.scalars(select(FinancialEntry).where(FinancialEntry.tenant_id == principal.tenant_id, FinancialEntry.deleted_at.is_(None)).order_by(FinancialEntry.entry_date.desc()))).all())
    await append_audit(session, principal, request, action="financial.list", resource_type="financial_entry", resource_id=None, correlation_id=cid); await session.commit(); return [_serialize(x) for x in rows]


@router.patch("/financial-entries/{entry_id}")
async def update_financial_entry(entry_id: uuid.UUID, body: FinancialEntryCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "financial.update"); item = await _row(session, FinancialEntry, principal.tenant_id, entry_id)
    for key, value in body.model_dump().items(): setattr(item, key, value)
    item.updated_by = principal.user_id; await append_audit(session, principal, request, action="financial.update", resource_type="financial_entry", resource_id=item.id, correlation_id=cid); await session.commit(); return _serialize(item)


@router.delete("/financial-entries/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_financial_entry(entry_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "financial.delete"); item = await _row(session, FinancialEntry, principal.tenant_id, entry_id)
    item.deleted_at, item.deleted_by, item.deletion_reason = datetime.now(UTC), principal.user_id, "Solicitação de usuário"; await append_audit(session, principal, request, action="financial.delete", resource_type="financial_entry", resource_id=item.id, correlation_id=cid); await session.commit()


@router.post("/imports/frontend-demo", status_code=status.HTTP_202_ACCEPTED)
async def import_frontend_demo(body: DemoImport, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _cid(session, principal, request, "frontend_demo.import")
    payload = body.payload
    if not isinstance(payload.get("clients", []), list) or not isinstance(payload.get("processes", []), list): raise HTTPException(status_code=422, detail="Estrutura de exportação do frontend inválida.")
    client_ids: dict[str, uuid.UUID] = {}; process_ids: dict[str, uuid.UUID] = {}
    for row in payload.get("clients", []):
        client = Client(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, kind=row.get("type", "PF"), name=row.get("name", "Sem nome"), document_ciphertext=cipher.encrypt(row.get("document")), document_fingerprint=cipher.fingerprint(row.get("document")), email_ciphertext=cipher.encrypt(row.get("email")), phone_ciphertext=cipher.encrypt(row.get("phone")), address_ciphertext=cipher.encrypt(row.get("address")), responsible=row.get("responsible"), status=row.get("status", "active"), notes=row.get("notes"))
        session.add(client); await session.flush(); client_ids[str(row.get("id"))] = client.id
    for row in payload.get("processes", []):
        mapped_client = client_ids.get(str(row.get("clientId")))
        if not mapped_client: continue
        process = LegalProcess(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, client_id=mapped_client, number=row.get("number", "SEM-NUMERO"), court=row.get("court"), area=row.get("area"), phase=row.get("phase"), status=row.get("status", "active"), responsible=row.get("responsible"), claim_value=row.get("value"), notes=row.get("notes"))
        session.add(process); await session.flush(); process_ids[str(row.get("id"))] = process.id
    for row in payload.get("deadlines", []):
        mapped = process_ids.get(str(row.get("processId")))
        if mapped and row.get("date"):
            session.add(Deadline(tenant_id=principal.tenant_id, created_by=principal.user_id, updated_by=principal.user_id, process_id=mapped, title=row.get("title", "Prazo importado"), due_date=datetime.fromisoformat(row["date"]).date(), deadline_type=row.get("type", "other"), responsible=row.get("responsible"), status=row.get("status", "pending"), notes=row.get("notes")))
    await append_audit(session, principal, request, action="frontend_demo.import", resource_type="import", resource_id=None, correlation_id=cid, metadata_safe={"clients": len(client_ids), "processes": len(process_ids)})
    await session.commit(); return {"status": "imported", "clients": len(client_ids), "processes": len(process_ids)}
