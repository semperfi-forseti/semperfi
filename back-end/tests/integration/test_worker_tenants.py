import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import db
from app.connectors.base import ConnectorResult
from app.evidence import evidence_service
from app.models import Base, ConnectorRun, Evidence, JobExecution, OutboxEvent
from app.services import connector_runs, outbox
from app.workers import tasks


@pytest.fixture
async def worker_store(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'workers.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(connector_runs, "SessionLocal", factory)
    monkeypatch.setattr(outbox, "SessionLocal", factory)
    monkeypatch.setattr(db, "SessionLocal", factory)
    connector = SimpleNamespace(execute=AsyncMock(return_value=ConnectorResult(
        "isolated-source", "v1", {"source": "isolated"}, {"name": "Isolated result"}, [])))
    monkeypatch.setattr(connector_runs, "get_connector", Mock(return_value=connector))
    queue = Mock()
    monkeypatch.setattr(tasks.process_connector_run, "apply_async", queue)
    verify = Mock(return_value=True)
    monkeypatch.setattr(evidence_service, "verify_remote_hash", verify)
    yield SimpleNamespace(factory=factory, tenant=uuid4(), other_tenant=uuid4(),
                          connector=connector, queue=queue, verify=verify)
    await engine.dispose()


async def add_run(store, *, job_tenant=None):
    run = ConnectorRun(tenant_id=store.tenant, connector_id="brasilapi", status="queued",
                       purpose="Isolated test", correlation_id="worker-test",
                       request_hash="a" * 64, request_payload={"kind": "cnpj", "value": "isolated"},
                       job_id=str(uuid4()))
    job = JobExecution(tenant_id=job_tenant or store.tenant, job_id=run.job_id,
                       task_name="process_connector_run", queue="default", status="queued",
                       attempts=0, correlation_id="worker-test")
    async with store.factory() as session:
        session.add_all([run, job])
        await session.commit()
    return run, job


async def add_evidence(store, **changes):
    values = dict(tenant_id=store.tenant, original_filename="isolated.pdf", mime_type="application/pdf",
                  size_bytes=4, sha256="a" * 64, source_type="manual_upload",
                  collection_method="manual_upload", collected_at=datetime.now(UTC),
                  storage_bucket="isolated-bucket", storage_key="isolated-key",
                  storage_version_id="isolated-version", validation_status="preserved")
    item = Evidence(**{**values, **changes})
    async with store.factory() as session:
        session.add(item)
        await session.commit()
    return item


async def test_connector_wrong_tenant_does_not_execute_or_mutate(worker_store):
    store = worker_store
    run, job = await add_run(store)
    result = await connector_runs.execute_connector_run(str(run.id), str(store.other_tenant))
    assert result["status"] == "not_queued"
    store.connector.execute.assert_not_awaited()
    async with store.factory() as session:
        assert (await session.get(ConnectorRun, run.id)).status == "queued"
        assert (await session.get(JobExecution, job.id)).attempts == 0


async def test_completed_connector_is_not_repeated_on_redelivery(worker_store):
    store = worker_store
    run, job = await add_run(store)
    result = await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    duplicate = await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    assert result["status"] == "completed"
    assert duplicate["status"] == "not_queued"
    store.connector.execute.assert_awaited_once()
    assert store.connector.execute.await_args.args[1].tenant_id == str(store.tenant)
    async with store.factory() as session:
        assert (await session.get(ConnectorRun, run.id)).normalized_result == {"name": "Isolated result"}
        saved_job = await session.get(JobExecution, job.id)
        assert (saved_job.status, saved_job.attempts) == ("completed", 1)


async def test_concurrent_deliveries_call_connector_once(worker_store):
    store = worker_store
    run, _ = await add_run(store)
    results = await asyncio.gather(
        connector_runs.execute_connector_run(str(run.id), str(store.tenant)),
        connector_runs.execute_connector_run(str(run.id), str(store.tenant)),
    )
    assert {result["status"] for result in results} == {"completed", "not_queued"}
    store.connector.execute.assert_awaited_once()


async def test_job_lookup_cannot_update_another_tenant(worker_store):
    store = worker_store
    run, job = await add_run(store, job_tenant=store.other_tenant)
    await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    async with store.factory() as session:
        saved_job = await session.get(JobExecution, job.id)
        assert (saved_job.status, saved_job.attempts) == ("queued", 0)


async def test_connector_failure_is_recorded_without_exception_details(worker_store):
    store = worker_store
    run, job = await add_run(store)
    store.connector.execute.side_effect = RuntimeError("private provider details")
    result = await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    assert result["status"] == "failed"
    assert "private" not in str(result)
    async with store.factory() as session:
        saved_run = await session.get(ConnectorRun, run.id)
        saved_job = await session.get(JobExecution, job.id)
        assert (saved_run.status, saved_run.error_code) == ("failed", "RuntimeError")
        assert (saved_job.status, saved_job.attempts) == ("failed", 1)


async def test_cancelled_attempt_rolls_back_claim_for_retry(worker_store):
    store = worker_store
    run, job = await add_run(store)
    store.connector.execute.side_effect = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    async with store.factory() as session:
        assert (await session.get(ConnectorRun, run.id)).status == "queued"
        assert (await session.get(JobExecution, job.id)).attempts == 0
    store.connector.execute.side_effect = None
    result = await connector_runs.execute_connector_run(str(run.id), str(store.tenant))
    assert result["status"] == "completed"


async def test_evidence_wrong_tenant_does_not_access_storage(worker_store):
    store = worker_store
    item = await add_evidence(store)
    with pytest.raises(ValueError, match="não encontrada"):
        await tasks._verify_stored_evidence(str(item.id), item.sha256, str(store.other_tenant))
    store.verify.assert_not_called()
    result = await tasks._verify_stored_evidence(str(item.id), item.sha256, str(store.tenant))
    assert result["verified"] is True
    store.verify.assert_called_once_with("isolated-bucket", "isolated-key", "isolated-version", item.sha256)


@pytest.mark.parametrize("changes", [{"storage_version_id": None}, {"validation_status": "pending"}])
async def test_unpreserved_evidence_is_not_verified(worker_store, changes):
    store = worker_store
    item = await add_evidence(store, **changes)
    with pytest.raises(ValueError, match="não encontrada"):
        await tasks._verify_stored_evidence(str(item.id), item.sha256, str(store.tenant))
    store.verify.assert_not_called()


async def test_outbox_propagates_committed_tenant_and_publishes_once(worker_store):
    store = worker_store
    run, _ = await add_run(store)
    async with store.factory() as session:
        event = await outbox.enqueue_outbox(session, tenant_id=store.tenant, topic="connector.run",
                                           payload={"run_id": str(run.id), "job_id": run.job_id},
                                           correlation_id="worker-test")
        assert event.payload["tenant_id"] == str(store.tenant)
        await session.commit()
    assert await outbox.dispatch_pending_outbox() == {"delivered": 1, "rejected": 0}
    store.queue.assert_called_once_with(args=[str(run.id)], kwargs={"tenant_id": str(store.tenant)},
                                        task_id=run.job_id, queue="default")
    assert await outbox.dispatch_pending_outbox() == {"delivered": 0, "rejected": 0}
    async with store.factory() as session:
        assert (await session.get(OutboxEvent, event.id)).published_at is not None


async def test_legacy_outbox_column_supplies_tenant_but_invalid_events_stay_unpublished(worker_store):
    store = worker_store
    run, _ = await add_run(store)
    payload = {"run_id": str(run.id), "job_id": run.job_id}
    async with store.factory() as session:
        session.add_all([
            OutboxEvent(tenant_id=store.tenant, topic="connector.run", payload=payload, correlation_id="legacy"),
            OutboxEvent(tenant_id=None, topic="connector.run", payload=payload, correlation_id="unscoped"),
            OutboxEvent(tenant_id=store.tenant, topic="connector.run", payload={**payload, "tenant_id": str(store.other_tenant)}, correlation_id="conflicting"),
        ])
        await session.commit()
    assert await outbox.dispatch_pending_outbox() == {"delivered": 1, "rejected": 2}
    assert store.queue.call_count == 1
    assert store.queue.call_args.kwargs["kwargs"] == {"tenant_id": str(store.tenant)}
    async with store.factory() as session:
        unpublished = list((await session.scalars(select(OutboxEvent).where(OutboxEvent.published_at.is_(None)))).all())
        assert {event.correlation_id for event in unpublished} == {"unscoped", "conflicting"}
        assert {event.topic for event in unpublished} == {"connector.run.rejected"}
    assert await outbox.dispatch_pending_outbox() == {"delivered": 0, "rejected": 0}


async def test_invalid_and_unknown_events_cannot_starve_later_connector_messages(worker_store):
    store = worker_store
    run, _ = await add_run(store)
    now = datetime.now(UTC)
    malformed = {"run_id": "invalid", "job_id": run.job_id, "original": "must remain unchanged"}
    async with store.factory() as session:
        unrelated = OutboxEvent(tenant_id=store.tenant, topic="another.topic", payload={"keep": True},
                                correlation_id="unrelated", created_at=now - timedelta(days=2))
        invalid = OutboxEvent(tenant_id=store.tenant, topic="connector.run", payload=malformed,
                              correlation_id="invalid", created_at=now - timedelta(days=1))
        valid = OutboxEvent(tenant_id=store.tenant, topic="connector.run",
                            payload={"run_id": str(run.id), "job_id": run.job_id},
                            correlation_id="valid", created_at=now)
        session.add_all([unrelated, invalid, valid])
        await session.commit()
    assert await outbox.dispatch_pending_outbox(limit=1) == {"delivered": 0, "rejected": 1}
    assert await outbox.dispatch_pending_outbox(limit=1) == {"delivered": 1, "rejected": 0}
    store.queue.assert_called_once()
    async with store.factory() as session:
        saved_invalid = await session.get(OutboxEvent, invalid.id)
        assert saved_invalid.topic == "connector.run.rejected"
        assert saved_invalid.payload == malformed
        assert saved_invalid.published_at is None
        saved_unrelated = await session.get(OutboxEvent, unrelated.id)
        assert saved_unrelated.topic == "another.topic"
        assert saved_unrelated.payload == {"keep": True}
        assert saved_unrelated.published_at is None
        assert (await session.get(OutboxEvent, valid.id)).published_at is not None


async def test_broker_failure_keeps_outbox_pending_for_retry(worker_store):
    store = worker_store
    run, _ = await add_run(store)
    async with store.factory() as session:
        event = await outbox.enqueue_outbox(session, tenant_id=store.tenant, topic="connector.run",
                                           payload={"run_id": str(run.id), "job_id": run.job_id},
                                           correlation_id="worker-test")
        await session.commit()
    store.queue.side_effect = RuntimeError("isolated broker unavailable")
    with pytest.raises(RuntimeError, match="broker unavailable"):
        await outbox.dispatch_pending_outbox()
    async with store.factory() as session:
        assert (await session.get(OutboxEvent, event.id)).published_at is None
    store.queue.side_effect = None
    assert await outbox.dispatch_pending_outbox() == {"delivered": 1, "rejected": 0}


@pytest.mark.parametrize("tenant", [None, "invalid"])
async def test_enqueue_rejects_missing_or_invalid_tenant(worker_store, tenant):
    async with worker_store.factory() as session:
        with pytest.raises(ValueError, match="TENANT_CONTEXT"):
            await outbox.enqueue_outbox(session, tenant_id=tenant, topic="connector.run", payload={}, correlation_id="test")
        assert not session.new


async def test_enqueue_rejects_conflicting_payload_tenant(worker_store):
    store = worker_store
    async with store.factory() as session:
        with pytest.raises(ValueError, match="INVALID_TENANT_CONTEXT"):
            await outbox.enqueue_outbox(session, tenant_id=store.tenant, topic="connector.run",
                                       payload={"tenant_id": str(store.other_tenant)}, correlation_id="test")
        assert not session.new


@pytest.mark.parametrize("payload", [None, [], {}, {"run_id": "invalid", "job_id": str(uuid4())},
                                    {"run_id": str(uuid4()), "job_id": None}])
async def test_enqueue_rejects_invalid_connector_identifiers(worker_store, payload):
    async with worker_store.factory() as session:
        with pytest.raises(ValueError, match="INVALID_CONNECTOR_MESSAGE"):
            await outbox.enqueue_outbox(session, tenant_id=worker_store.tenant, topic="connector.run",
                                       payload=payload, correlation_id="test")
        assert not session.new
