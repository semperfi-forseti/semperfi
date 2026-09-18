from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from app.db import SessionLocal
from app.models import OutboxEvent


async def enqueue_outbox(
    session,
    *,
    tenant_id: uuid.UUID | None,
    topic: str,
    payload: dict,
    correlation_id: str,
) -> OutboxEvent:
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

    delivered = 0
    async with SessionLocal() as session:
        events = list(
            (
                await session.scalars(
                    select(OutboxEvent)
                    .where(OutboxEvent.published_at.is_(None))
                    .order_by(OutboxEvent.created_at)
                    .limit(limit)
                )
            ).all()
        )
        for event in events:
            if event.topic == "connector.run":
                process_connector_run.apply_async(
                    args=[event.payload["run_id"]],
                    task_id=event.payload["job_id"],
                    queue="default",
                )
                event.published_at = datetime.now(UTC)
                delivered += 1
        await session.commit()
    return {"delivered": delivered}


def dispatch_pending_outbox_sync(limit: int = 50) -> dict:
    return asyncio.run(dispatch_pending_outbox(limit))
