from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditEvent
from app.security.auth import Principal, mask_ip


def _canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def digest(previous_hash: str | None, payload: dict) -> str:
    return hashlib.sha256(f"{previous_hash or ''}|{_canonical(payload)}".encode()).hexdigest()


def _timestamp(value: datetime) -> str:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(UTC).isoformat()


async def append_audit(
    session: AsyncSession,
    principal: Principal,
    request: Request | None,
    *,
    action: str,
    resource_type: str,
    resource_id: str | uuid.UUID | None,
    result: str = "success",
    correlation_id: str,
    metadata_safe: dict | None = None,
) -> AuditEvent:
    previous = await session.scalar(
        select(AuditEvent).where(AuditEvent.tenant_id == principal.tenant_id).order_by(AuditEvent.occurred_at.desc()).limit(1)
    )
    occurred_at = datetime.now(UTC)
    data = {
        "tenant_id": str(principal.tenant_id), "actor_id": str(principal.user_id), "action": action,
        "resource_type": resource_type, "resource_id": str(resource_id) if resource_id else None,
        "result": result, "correlation_id": correlation_id, "occurred_at": _timestamp(occurred_at),
        "metadata_safe": metadata_safe or {},
    }
    event = AuditEvent(
        tenant_id=principal.tenant_id,
        actor_id=principal.user_id,
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id) if resource_id else None,
        result=result,
        correlation_id=correlation_id,
        masked_ip=mask_ip(request.client.host) if request and request.client else None,
        user_agent=(request.headers.get("user-agent", "")[:512] if request else None),
        occurred_at=occurred_at,
        previous_hash=previous.event_hash if previous else None,
        event_hash=digest(previous.event_hash if previous else None, data),
        metadata_safe=metadata_safe or {},
    )
    session.add(event)
    return event


async def verify_chain(session: AsyncSession, tenant_id: uuid.UUID) -> dict:
    rows = list((await session.scalars(select(AuditEvent).where(AuditEvent.tenant_id == tenant_id).order_by(AuditEvent.occurred_at.asc()))).all())
    prior: str | None = None
    for index, event in enumerate(rows):
        data = {
            "tenant_id": str(event.tenant_id), "actor_id": str(event.actor_id) if event.actor_id else None,
            "action": event.action, "resource_type": event.resource_type, "resource_id": event.resource_id,
            "result": event.result, "correlation_id": event.correlation_id,
            "occurred_at": _timestamp(event.occurred_at), "metadata_safe": event.metadata_safe or {},
        }
        expected = digest(prior, data)
        if event.previous_hash != prior or event.event_hash != expected:
            return {"valid": False, "checked": index + 1, "broken_event_id": str(event.id)}
        prior = event.event_hash
    return {"valid": True, "checked": len(rows), "head_hash": prior}
