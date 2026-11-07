"""Real API/database/worker flow; only the external sources and broker are mocked."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import investigations
from app.connectors import osint_tools
from app.db import get_db
from app.models import AuditEvent, Base, ConnectorRun, JobExecution, OutboxEvent
from app.security import Principal, get_current_principal
from app.services import connector_runs, outbox
from app.workers.tasks import process_connector_run


@pytest.fixture
async def tools_api(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tools.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(principal=Principal(
        uuid4(), uuid4(), "isolated@example.invalid", "Isolated operator",
        frozenset({"investigator"}), datetime.now(UTC), "test",
    ))

    async def principal():
        return state.principal

    async def session():
        async with factory() as item:
            yield item

    app = FastAPI()
    app.include_router(investigations.router, prefix="/v1")
    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_principal] = principal
    monkeypatch.setattr(investigations.rate_limiter, "allow", AsyncMock(return_value=True))
    monkeypatch.setattr(connector_runs, "SessionLocal", factory)
    monkeypatch.setattr(outbox, "SessionLocal", factory)
    monkeypatch.setattr(osint_tools.OsintToolsConnector, "_json", AsyncMock(
        side_effect=AssertionError("An isolated test must not contact a public provider."),
    ))
    monkeypatch.setattr(osint_tools.SafeHttpClient, "public_head", AsyncMock(
        side_effect=AssertionError("An isolated test must not contact a public target."),
    ))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield SimpleNamespace(client=client, app=app, factory=factory, state=state)
    await engine.dispose()


def query_body(tool="dns", value="EXAMPLE.COM.", **overrides):
    return {
        "connector_id": "osint_tools", "payload": {"tool": tool, "value": value, "authorized": True},
        "purpose": "Conferir registros públicos autorizados", "legal_basis": "contrato",
        "authorization_reference": "authorization-not-for-public-summary",
        "scope_codes": ["digital_defensive"], "risk_level": "low", **overrides,
    }


async def assert_no_queued_work(api):
    async with api.factory() as session:
        for table in (ConnectorRun, JobExecution, OutboxEvent):
            assert await session.scalar(select(func.count()).select_from(table)) == 0


async def test_api_outbox_worker_and_reloaded_history_preserve_result(tools_api, monkeypatch):
    api = tools_api
    source = AsyncMock(return_value={"Status": 0, "Answer": [
        {"name": "example.com.", "type": 16, "TTL": 60, "data": '"informação autorizada"'},
    ]})
    monkeypatch.setattr(osint_tools.OsintToolsConnector, "_json", source)
    response = await api.client.post("/v1/osint/runs", json=query_body())
    assert response.status_code == 202, response.text
    queued = response.json()
    assert queued["status"] == "queued"
    assert "raw_snapshot" not in queued
    source.assert_not_awaited()

    async with api.factory() as session:
        run = await session.get(ConnectorRun, UUID(queued["run_id"]))
        event = await session.scalar(select(OutboxEvent))
        job = await session.scalar(select(JobExecution))
        assert run.request_payload["value"] == "example.com"
        assert run.request_payload["authorized"] is True
        assert run.request_payload["authorization_reference"] == query_body()["authorization_reference"]
        assert run.request_payload["legal_basis"] == query_body()["legal_basis"]
        assert run.request_payload["risk_level"] == "low"
        assert run.request_hash == connector_runs.request_hash(run.request_payload)
        assert event.tenant_id == run.tenant_id == api.state.principal.tenant_id
        assert event.payload == {"run_id": str(run.id), "job_id": queued["job_id"], "tenant_id": str(run.tenant_id)}
        assert event.published_at is None
        assert job.status == "queued" and job.attempts == 0

    publish = Mock()
    monkeypatch.setattr(process_connector_run, "apply_async", publish)
    assert await outbox.dispatch_pending_outbox() == {"delivered": 1, "rejected": 0}
    publish.assert_called_once_with(
        args=[queued["run_id"]], kwargs={"tenant_id": str(api.state.principal.tenant_id)},
        task_id=queued["job_id"], queue="default",
    )
    # This is the same async worker function invoked by the Celery task.
    assert await connector_runs.execute_connector_run(
        *publish.call_args.kwargs["args"], **publish.call_args.kwargs["kwargs"],
    ) == {"status": "completed", "run_id": queued["run_id"]}
    assert source.await_count == len(osint_tools.DNS_TYPES)

    # A fresh HTTP client and fresh DB dependency session do not retain browser state.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test") as reload_client:
        history = await reload_client.get("/v1/osint/runs?connector_id=osint_tools")
        detail = await reload_client.get(f"/v1/osint/runs/{queued['run_id']}")
    assert history.status_code == detail.status_code == 200
    summary = history.json()[0]
    assert summary["id"] == queued["run_id"]
    assert summary["status"] == "completed" and summary["target"] == "example.com"
    assert summary["tool"] == "dns" and summary["normalized_result"] is None
    assert "raw_snapshot" not in summary and "request_payload" not in summary
    assert query_body()["authorization_reference"] not in history.text
    saved = detail.json()
    assert saved["raw_snapshot"]["data"]["records"]["TXT"]["answers"][0]["data"] == '"informação autorizada"'
    assert saved["raw_snapshot"] == saved["normalized_result"]
    assert saved["response_hash"] == connector_runs.request_hash(saved["raw_snapshot"])
    assert saved["created_at"] and saved["error_code"] is None
    assert saved["purpose"] == query_body()["purpose"]
    assert saved["legal_basis"] == query_body()["legal_basis"]
    assert saved["limitations"] and saved["raw_snapshot"]["partial"] is False
    assert query_body()["authorization_reference"] not in detail.text
    async with api.factory() as session:
        job = await session.scalar(select(JobExecution))
        assert job.status == "completed" and job.attempts == 1
        assert (await session.scalar(select(OutboxEvent))).published_at is not None
        assert await session.scalar(select(AuditEvent).where(AuditEvent.action == "osint.run.queue"))

    assert await outbox.dispatch_pending_outbox() == {"delivered": 0, "rejected": 0}
    assert (await connector_runs.execute_connector_run(queued["run_id"], str(api.state.principal.tenant_id)))["status"] == "not_queued"
    assert source.await_count == len(osint_tools.DNS_TYPES)


@pytest.mark.parametrize("payload", [
    {"tool": "dns", "value": "localhost", "authorized": True},
    {"tool": "headers", "value": "https://127.0.0.1/", "authorized": True},
    {"tool": "ip", "value": "10.0.0.1", "authorized": True},
    {"tool": "dns", "value": "example.com", "authorized": False},
    {"tool": "unknown", "value": "example.com", "authorized": True},
    {"tool": [], "value": "example.com", "authorized": True},
])
async def test_invalid_targets_and_missing_consent_never_enqueue(tools_api, payload):
    response = await tools_api.client.post("/v1/osint/runs", json=query_body(payload=payload))
    assert response.status_code == 422, response.text
    await assert_no_queued_work(tools_api)


@pytest.mark.parametrize("tool,value", [
    ("dns", "example.com"), ("domain", "example.com"), ("crt", "example.com"),
    ("headers", "https://example.com/"),
])
async def test_network_tools_require_declared_digital_scope(tools_api, tool, value):
    response = await tools_api.client.post("/v1/osint/runs", json=query_body(tool, value, scope_codes=[]))
    assert response.status_code == 422, response.text
    await assert_no_queued_work(tools_api)


@pytest.mark.parametrize("roles", [frozenset(), frozenset({"unknown"}), frozenset({"auditor"})])
async def test_read_only_or_unknown_roles_cannot_enqueue(tools_api, roles):
    tools_api.state.principal = replace(tools_api.state.principal, roles=roles)
    response = await tools_api.client.post("/v1/osint/runs", json=query_body())
    assert response.status_code == 403, response.text
    await assert_no_queued_work(tools_api)


async def test_other_tenant_cannot_read_or_execute_queued_run(tools_api):
    api = tools_api
    result = await api.client.post("/v1/osint/runs", json=query_body())
    assert result.status_code == 202
    run_id = result.json()["run_id"]
    original = api.state.principal
    api.state.principal = replace(original, tenant_id=uuid4(), user_id=uuid4())
    assert (await api.client.get("/v1/osint/runs?connector_id=osint_tools")).json() == []
    assert (await api.client.get(f"/v1/osint/runs/{run_id}")).status_code == 404
    assert (await connector_runs.execute_connector_run(run_id, str(api.state.principal.tenant_id)))["status"] == "not_queued"
    async with api.factory() as session:
        run = await session.get(ConnectorRun, UUID(run_id))
        assert run.status == "queued" and run.tenant_id == original.tenant_id
    api.state.principal = replace(original, roles=frozenset({"auditor"}))
    assert (await api.client.get(f"/v1/osint/runs/{run_id}")).status_code == 200
    api.state.principal = replace(original, roles=frozenset({"unknown"}))
    assert (await api.client.get(f"/v1/osint/runs/{run_id}")).status_code == 403
    assert (await api.client.get("/v1/osint/runs?connector_id=osint_tools")).status_code == 403


async def test_missing_provider_credentials_persists_failure_without_empty_success(tools_api, monkeypatch):
    api = tools_api
    monkeypatch.setattr(osint_tools.get_settings(), "urlhaus_auth_key", None)
    queued = await api.client.post("/v1/osint/runs", json=query_body("urlthreat", "https://example.com/"))
    assert queued.status_code == 202, queued.text
    run_id = queued.json()["run_id"]
    assert (await connector_runs.execute_connector_run(run_id, str(api.state.principal.tenant_id)))["status"] == "failed"
    detail = (await api.client.get(f"/v1/osint/runs/{run_id}")).json()
    assert detail["status"] == "failed"
    assert detail["error_code"] == "ProviderNotConfigured"
    assert detail["raw_snapshot"] is None and detail["normalized_result"] is None
    assert detail["response_hash"] is None
    history = (await api.client.get("/v1/osint/runs?connector_id=osint_tools")).json()
    assert history[0]["status"] == "failed" and history[0]["tool"] == "urlthreat"
    async with api.factory() as session:
        job = await session.scalar(select(JobExecution))
        assert job.status == "failed" and job.error_code == "ProviderNotConfigured"


async def test_provider_exception_detail_is_not_exposed_in_history(tools_api, monkeypatch):
    monkeypatch.setattr(osint_tools.OsintToolsConnector, "execute", AsyncMock(
        side_effect=RuntimeError("private-provider-key=never-expose-this"),
    ))
    queued = await tools_api.client.post("/v1/osint/runs", json=query_body())
    run_id = queued.json()["run_id"]
    await connector_runs.execute_connector_run(run_id, str(tools_api.state.principal.tenant_id))
    response = await tools_api.client.get(f"/v1/osint/runs/{run_id}")
    assert response.json()["error_code"] == "RuntimeError"
    assert "private-provider-key" not in response.text and "never-expose-this" not in response.text


async def test_offset_pagination_orders_history_and_does_not_mix_connectors(tools_api):
    api = tools_api
    identifiers = []
    async with api.factory() as session:
        for index in range(5):
            row = ConnectorRun(
                tenant_id=api.state.principal.tenant_id, connector_id="osint_tools", status="queued",
                purpose="Consulta autorizada de teste", correlation_id="pagination-test", request_hash="a" * 64,
                request_payload={"tool": "dns", "value": f"sample{index}.example.com"},
                created_at=datetime.now(UTC) - timedelta(days=index),
            )
            session.add(row)
            await session.flush()
            identifiers.append(str(row.id))
        session.add(ConnectorRun(
            tenant_id=api.state.principal.tenant_id, connector_id="brasilapi", status="queued",
            purpose="Consulta autorizada de outra fonte", correlation_id="pagination-test", request_hash="b" * 64,
        ))
        await session.commit()
    for offset, expected in ((0, identifiers[:2]), (2, identifiers[2:4]), (4, identifiers[4:]), (6, [])):
        result = await api.client.get(f"/v1/osint/runs?connector_id=osint_tools&limit=2&offset={offset}")
        assert result.status_code == 200
        assert [item["id"] for item in result.json()] == expected
    for offset in (-1, 1000001):
        assert (await api.client.get(f"/v1/osint/runs?connector_id=osint_tools&offset={offset}")).status_code == 422


@pytest.mark.parametrize("environment,expected", [("development", "completed"), ("production", "queued")])
async def test_wait_executes_inline_only_in_development(tools_api, monkeypatch, environment, expected):
    monkeypatch.setattr(investigations.settings, "environment", environment)
    source = AsyncMock(return_value={"Status": 0})
    monkeypatch.setattr(osint_tools.OsintToolsConnector, "_json", source)
    response = await tools_api.client.post("/v1/osint/runs?wait=true", json=query_body())
    assert response.status_code == 202, response.text
    assert response.json()["status"] == expected
    if environment == "production":
        source.assert_not_awaited()
    else:
        assert source.await_count == len(osint_tools.DNS_TYPES)
        assert response.json()["raw_snapshot"]["tool"] == "dns"
