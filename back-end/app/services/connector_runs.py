from __future__ import annotations

import asyncio
import hashlib
import json
import uuid

from sqlalchemy import select

from app.connectors import ConnectorContext, get_connector
from app.db import SessionLocal
from app.models import ConnectorRun, JobExecution


def request_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


async def execute_connector_run(run_id: str) -> dict:
    async with SessionLocal() as session:
        run = await session.get(ConnectorRun, uuid.UUID(run_id))
        if not run:
            return {"status": "missing"}
        run.status = "running"
        job = await session.scalar(select(JobExecution).where(JobExecution.job_id == run.job_id)) if run.job_id else None
        if job: job.status, job.attempts = "running", job.attempts + 1
        await session.commit()
        try:
            connector = get_connector(run.connector_id)
            result = await connector.execute(run.request_payload, ConnectorContext(tenant_id=str(run.tenant_id), actor_id="system", correlation_id=run.correlation_id, purpose=run.purpose, authorization_reference=run.request_payload.get("authorization_reference", ""), allowed_scopes=set(run.request_payload.get("scope_codes", []))))
            run.raw_snapshot = result.raw
            run.normalized_result = result.normalized
            run.response_hash = request_hash(result.raw)
            run.limitations = result.limitations
            run.status = "completed"
            if job: job.status, job.result_summary = "completed", {"connector": run.connector_id, "source": result.source_name}
            await session.commit()
            return {"status": "completed", "run_id": run_id}
        except Exception as exc:  # boundary: store code, never leak internals to API
            run.status, run.error_code = "failed", type(exc).__name__
            if job: job.status, job.error_code = "failed", type(exc).__name__
            await session.commit()
            return {"status": "failed", "run_id": run_id}


def execute_connector_run_sync(run_id: str) -> dict:
    return asyncio.run(execute_connector_run(run_id))
