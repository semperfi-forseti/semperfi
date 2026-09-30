from __future__ import annotations

import asyncio
import hashlib
import json
import uuid

from sqlalchemy import select, update

from app.connectors import ConnectorContext, get_connector
from app.db import SessionLocal
from app.models import ConnectorRun, JobExecution
from app.services.worker_context import require_tenant_id, set_worker_tenant_context


def request_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


async def execute_connector_run(run_id: str, tenant_id: str | None = None) -> dict:
    tenant, identifier = require_tenant_id(tenant_id), uuid.UUID(run_id)
    async with SessionLocal() as session:
        await set_worker_tenant_context(session, tenant)
        # Keep the claim and result in one transaction. A crash rolls the claim
        # back; concurrent/redelivered messages cannot repeat a completed run.
        claimed = await session.execute(
            update(ConnectorRun).where(
                ConnectorRun.id == identifier,
                ConnectorRun.tenant_id == tenant,
                ConnectorRun.status == "queued",
            ).values(status="running")
        )
        if not claimed.rowcount:
            return {"status": "not_queued", "run_id": run_id}
        run = await session.scalar(select(ConnectorRun).where(ConnectorRun.id == identifier, ConnectorRun.tenant_id == tenant))
        job = await session.scalar(select(JobExecution).where(JobExecution.job_id == run.job_id, JobExecution.tenant_id == tenant)) if run.job_id else None
        if job: job.status, job.attempts = "running", job.attempts + 1
        try:
            connector = get_connector(run.connector_id)
            result = await connector.execute(run.request_payload, ConnectorContext(tenant_id=str(tenant), actor_id="system", correlation_id=run.correlation_id, purpose=run.purpose, authorization_reference=run.request_payload.get("authorization_reference", ""), allowed_scopes=set(run.request_payload.get("scope_codes", []))))
            response_hash = request_hash(result.raw)
        except Exception as exc:  # boundary: store code, never leak internals to API
            run.status, run.error_code = "failed", type(exc).__name__
            if job: job.status, job.error_code = "failed", type(exc).__name__
            await session.commit()
            return {"status": "failed", "run_id": run_id}
        run.raw_snapshot = result.raw
        run.normalized_result = result.normalized
        run.response_hash = response_hash
        run.limitations = result.limitations
        run.status, run.error_code = "completed", None
        if job:
            job.status, job.error_code = "completed", None
            job.result_summary = {"connector": run.connector_id, "source": result.source_name}
        # Database failures propagate to Celery, whose retry gets a fresh
        # transaction and RLS context. They must not become provider failures.
        await session.commit()
        return {"status": "completed", "run_id": run_id}


def execute_connector_run_sync(run_id: str, tenant_id: str | None = None) -> dict:
    return asyncio.run(execute_connector_run(run_id, tenant_id))
