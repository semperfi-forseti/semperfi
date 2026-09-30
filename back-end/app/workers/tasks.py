from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from app.services.worker_context import require_tenant_id, set_worker_tenant_context
from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.process_connector_run", bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_kwargs={"max_retries": 3})
def process_connector_run(self, run_id: str, tenant_id: str | None = None) -> dict:
    from app.services.connector_runs import execute_connector_run_sync
    try:
        tenant = require_tenant_id(tenant_id)
    except ValueError as exc:
        return {"run_id": run_id, "status": "failed", "error_code": str(exc)}
    return execute_connector_run_sync(run_id, str(tenant))


@celery_app.task(name="app.workers.tasks.verify_evidence_integrity")
def verify_evidence_integrity(evidence_id: str, sha256: str, tenant_id: str | None = None) -> dict:
    return asyncio.run(_verify_stored_evidence(evidence_id, sha256, tenant_id))


async def _verify_stored_evidence(evidence_id: str, expected_hash: str, tenant_id: str | None = None) -> dict:
    from app.db import SessionLocal
    from app.evidence import evidence_service
    from app.models import Evidence

    tenant, identifier = require_tenant_id(tenant_id), uuid.UUID(evidence_id)
    async with SessionLocal() as session:
        await set_worker_tenant_context(session, tenant)
        item = await session.scalar(select(Evidence).where(Evidence.id == identifier, Evidence.tenant_id == tenant))
        if not item or not item.storage_bucket or not item.storage_key or not item.storage_version_id or item.validation_status not in {"preserved", "validated"}:
            raise ValueError("Evidência preservada não encontrada.")
        if item.sha256 != expected_hash:
            raise ValueError("Hash solicitado difere do hash registrado.")
        verified = await asyncio.to_thread(
            evidence_service.verify_remote_hash, item.storage_bucket, item.storage_key,
            item.storage_version_id, item.sha256,
        )
    return {"evidence_id": evidence_id, "sha256": expected_hash, "verified": verified,
            "at": datetime.now(UTC).isoformat()}


@celery_app.task(name="app.workers.tasks.run_supervised_agent")
def run_supervised_agent(agent_run_id: str, agent_type: str, tenant_id: str | None = None) -> dict:
    from app.services.agent_runs import execute_agent_run_sync
    if not tenant_id:
        return {"agent_run_id": agent_run_id, "status": "failed", "error_code": "TENANT_CONTEXT_REQUIRED"}
    return execute_agent_run_sync(agent_run_id, tenant_id)


@celery_app.task(name="app.workers.tasks.dispatch_outbox_events")
def dispatch_outbox_events() -> dict:
    from app.services.outbox import dispatch_pending_outbox_sync

    return dispatch_pending_outbox_sync()
