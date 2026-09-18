from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from datetime import UTC, datetime

from app.workers.celery_app import celery_app


@celery_app.task(name="app.workers.tasks.process_connector_run", bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_kwargs={"max_retries": 3})
def process_connector_run(self, run_id: str) -> dict:
    from app.services.connector_runs import execute_connector_run_sync
    return execute_connector_run_sync(run_id)


@celery_app.task(name="app.workers.tasks.verify_evidence_integrity")
def verify_evidence_integrity(evidence_id: str, sha256: str) -> dict:
    return asyncio.run(_verify_stored_evidence(evidence_id, sha256))


async def _verify_stored_evidence(evidence_id: str, expected_hash: str) -> dict:
    from app.db import SessionLocal
    from app.evidence import evidence_service
    from app.models import Evidence

    async with SessionLocal() as session:
        item = await session.get(Evidence, uuid.UUID(evidence_id))
        if not item or not item.storage_bucket or not item.storage_key:
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
def run_supervised_agent(agent_run_id: str, agent_type: str) -> dict:
    return {"agent_run_id": agent_run_id, "agent_type": agent_type, "status": "pending_human_review", "limitations": ["Nenhuma conclusão jurídica autônoma é produzida."], "output_hash": hashlib.sha256(json.dumps({"id": agent_run_id, "type": agent_type}).encode()).hexdigest()}


@celery_app.task(name="app.workers.tasks.dispatch_outbox_events")
def dispatch_outbox_events() -> dict:
    from app.services.outbox import dispatch_pending_outbox_sync

    return dispatch_pending_outbox_sync()
