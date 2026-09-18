from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EvidenceEvent


def _hash(previous_hash: str | None, data: dict) -> str:
    return hashlib.sha256(f"{previous_hash or ''}|{json.dumps(data, sort_keys=True, default=str, ensure_ascii=False)}".encode()).hexdigest()


async def append_evidence_event(session: AsyncSession, *, evidence_id: uuid.UUID, tenant_id: uuid.UUID, actor_id: uuid.UUID | None, event_type: str, details: dict) -> EvidenceEvent:
    previous = await session.scalar(select(EvidenceEvent).where(EvidenceEvent.evidence_id == evidence_id).order_by(EvidenceEvent.created_at.desc()).limit(1))
    payload = {"evidence_id": str(evidence_id), "tenant_id": str(tenant_id), "actor_id": str(actor_id) if actor_id else None, "event_type": event_type, "details": details, "at": datetime.now(UTC).isoformat()}
    event = EvidenceEvent(evidence_id=evidence_id, tenant_id=tenant_id, actor_id=actor_id, event_type=event_type, details=details, previous_hash=previous.event_hash if previous else None, event_hash=_hash(previous.event_hash if previous else None, payload))
    session.add(event)
    return event
