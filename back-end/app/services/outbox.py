from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from app.db import SessionLocal
from app.models import OutboxEvent
from app.services.worker_context import require_tenant_id


def _connector_message(tenant_id: uuid.UUID | None, payload: dict) -> tuple[uuid.UUID, str, str]:
    tenant = require_tenant_id(tenant_id)
    if not isinstance(payload, dict):
        raise ValueError("INVALID_CONNECTOR_MESSAGE")
    if "tenant_id" in payload and require_tenant_id(payload["tenant_id"]) != tenant:
        raise ValueError("INVALID_TENANT_CONTEXT")
    try:
        run_id, job_id = str(uuid.UUID(str(payload["run_id"]))), str(uuid.UUID(str(payload["job_id"])))
    except (KeyError, ValueError, TypeError, AttributeError) as exc:
        raise ValueError("INVALID_CONNECTOR_MESSAGE") from exc
    return tenant, run_id, job_id


async def enqueue_outbox(
    session,
    *,
    tenant_id: uuid.UUID | None,
    topic: str,
    payload: dict,
    correlation_id: str,
) -> OutboxEvent:
    if topic == "connector.run":
        tenant_id, run_id, job_id = _connector_message(tenant_id, payload)
        payload = {**payload, "tenant_id": str(tenant_id), "run_id": run_id, "job_id": job_id}
    event = OutboxEvent(
        tenant_id=tenant_id,
        topic=topic,
        payload=payload,
        correlation_id=correlation_id,
        created_at=datetime.now(UTC),
    )
    session.add(event)
    return event


async def dispatch_pending_outbox(limit: int = 50) -> dict:
    from app.workers.tasks import process_connector_run

    delivered = rejected = 0
    async with SessionLocal() as session:
        events = list(
            (
                await session.scalars(
                    select(OutboxEvent)
                    .where(OutboxEvent.published_at.is_(None), OutboxEvent.topic == "connector.run")
                    .order_by(OutboxEvent.created_at, OutboxEvent.id)
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        for event in events:
            # The persisted tenant column is authoritative. Older outbox
            # rows need not carry a redundant tenant in their payload.
            try:
                tenant, run_id, job_id = _connector_message(event.tenant_id, event.payload)
            except ValueError:
                # Quarantine, never delete or mark as delivered. Keeping the
                # original payload allows review/correction, while poison
                # events no longer fill every subsequent dispatch batch.
                event.topic = "connector.run.rejected"
                rejected += 1
                continue
            process_connector_run.apply_async(
                args=[run_id],
                kwargs={"tenant_id": str(tenant)},
                task_id=job_id,
                queue="default",
            )
            event.published_at = datetime.now(UTC)
            delivered += 1
        await session.commit()
    return {"delivered": delivered, "rejected": rejected}


def dispatch_pending_outbox_sync(limit: int = 50) -> dict:
    return asyncio.run(dispatch_pending_outbox(limit))
