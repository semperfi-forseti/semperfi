from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest

from app import db
from app.services import connector_runs
from app.services.worker_context import set_worker_tenant_context
from app.workers import tasks


@pytest.mark.parametrize("tenant", [None, "invalid"])
async def test_missing_or_invalid_tenant_fails_before_opening_database(monkeypatch, tenant):
    factory = Mock(side_effect=AssertionError("Database must not be opened"))
    monkeypatch.setattr(db, "SessionLocal", factory)
    monkeypatch.setattr(connector_runs, "SessionLocal", factory)
    with pytest.raises(ValueError, match="TENANT_CONTEXT"):
        await connector_runs.execute_connector_run(str(uuid4()), tenant)
    with pytest.raises(ValueError, match="TENANT_CONTEXT"):
        await tasks._verify_stored_evidence(str(uuid4()), "a" * 64, tenant)
    factory.assert_not_called()


async def test_postgres_context_is_transaction_local_and_parameterized():
    tenant = uuid4()
    session = AsyncMock()
    session.bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))
    await set_worker_tenant_context(session, tenant)
    statement, parameters = session.execute.await_args.args
    assert str(statement) == "SELECT set_config('app.tenant_id', :tenant_id, true)"
    assert parameters == {"tenant_id": str(tenant)}


async def test_connector_context_precedes_claim_and_provider_work(monkeypatch):
    calls = []
    tenant = uuid4()
    session = AsyncMock()
    session.bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    async def execute(statement, parameters=None):
        calls.append(str(statement))
        return SimpleNamespace(rowcount=0)

    session.execute.side_effect = execute
    factory = Mock()
    factory.return_value.__aenter__ = AsyncMock(return_value=session)
    factory.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(connector_runs, "SessionLocal", factory)
    provider = Mock(side_effect=AssertionError("Provider must not be accessed"))
    monkeypatch.setattr(connector_runs, "get_connector", provider)
    await connector_runs.execute_connector_run(str(uuid4()), str(tenant))
    assert len(calls) == 2
    assert calls[0].startswith("SELECT set_config")
    assert calls[1].startswith("UPDATE connector_runs")
    assert "connector_runs.tenant_id" in calls[1]
    session.scalar.assert_not_awaited()
    provider.assert_not_called()


async def test_evidence_context_precedes_lookup(monkeypatch):
    calls = []
    session = AsyncMock()
    session.bind = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    async def set_context(statement, parameters):
        calls.append(str(statement))

    async def lookup(statement):
        calls.append(str(statement))
        return None

    session.execute.side_effect = set_context
    session.scalar.side_effect = lookup
    factory = Mock()
    factory.return_value.__aenter__ = AsyncMock(return_value=session)
    factory.return_value.__aexit__ = AsyncMock(return_value=False)
    monkeypatch.setattr(db, "SessionLocal", factory)
    with pytest.raises(ValueError, match="não encontrada"):
        await tasks._verify_stored_evidence(str(uuid4()), "a" * 64, str(uuid4()))
    assert calls[0].startswith("SELECT set_config")
    assert "evidences.tenant_id" in calls[1]


def test_legacy_celery_message_fails_closed_without_tenant(monkeypatch):
    execute = Mock(side_effect=AssertionError("Unscoped message must not execute"))
    monkeypatch.setattr(connector_runs, "execute_connector_run_sync", execute)
    result = tasks.process_connector_run.run(str(uuid4()))
    assert result["error_code"] == "TENANT_CONTEXT_REQUIRED"
    execute.assert_not_called()


def test_celery_task_passes_tenant_to_service(monkeypatch):
    execute = Mock(return_value={"status": "completed"})
    monkeypatch.setattr(connector_runs, "execute_connector_run_sync", execute)
    run_id, tenant_id = str(uuid4()), str(uuid4())
    assert tasks.process_connector_run.run(run_id, tenant_id=tenant_id)["status"] == "completed"
    execute.assert_called_once_with(run_id, tenant_id)
