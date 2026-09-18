from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.audit import append_audit, verify_chain
from app.db import get_db
from app.models import AuditEvent
from app.policies import PolicyContext, policy_engine
from app.security import Principal, get_current_principal, require_recent_mfa

router = APIRouter(tags=["Audit"])


@router.get("/audit-events")
async def list_audit_events(request: Request, limit: int = 100, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    if not principal.has_any_role("administrator", "manager", "auditor"): raise HTTPException(status_code=403, detail="Acesso de auditoria restrito.")
    cid = correlation_id(request); decision = await policy_engine.evaluate(session, principal, PolicyContext(action="audit.read"), cid)
    if decision.effect != "allow": raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    rows = list((await session.scalars(select(AuditEvent).where(AuditEvent.tenant_id == principal.tenant_id).order_by(AuditEvent.occurred_at.desc()).limit(min(limit, 500)))).all())
    await append_audit(session, principal, request, action="audit.read", resource_type="audit_event", resource_id=None, correlation_id=cid); await session.commit()
    return [{"id": item.id, "action": item.action, "resource_type": item.resource_type, "resource_id": item.resource_id, "result": item.result, "correlation_id": item.correlation_id, "occurred_at": item.occurred_at, "event_hash": item.event_hash} for item in rows]


@router.post("/audit-events/verify-chain")
async def verify_audit_chain(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    if not principal.has_any_role("administrator", "auditor"): raise HTTPException(status_code=403, detail="Verificação restrita.")
    cid = correlation_id(request); result = await verify_chain(session, principal.tenant_id)
    await append_audit(session, principal, request, action="audit.verify_chain", resource_type="audit_ledger", resource_id=None, correlation_id=cid, metadata_safe={"valid": result["valid"], "checked": result["checked"]}); await session.commit(); return result
