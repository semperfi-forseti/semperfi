from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import investigations
from app.db import get_db
from app.models import AuditEvent, Base, ConnectorRun, OutboxEvent
from app.security import Principal, get_current_principal


@pytest.fixture
async def history_api(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'history.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(principal=Principal(uuid4(), uuid4(), "isolated@example.invalid", "Isolated user",
                                               frozenset({"administrator"}), datetime.now(UTC), "test"))

    async def principal():
        return state.principal

    async def session():
        async with factory() as item:
            yield item

    app = FastAPI()
    app.include_router(investigations.router, prefix="/v1")
    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_principal] = principal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield SimpleNamespace(client=client, factory=factory, state=state)
    await engine.dispose()


async def saved_run(api, *, tenant=None, connector="brasilapi", kind="cnpj", age=0, status="completed"):
    run = ConnectorRun(tenant_id=tenant or api.state.principal.tenant_id, connector_id=connector,
                       status=status, purpose="Isolated company research", correlation_id="history-test",
                       request_hash="a" * 64,
                       request_payload={"kind": kind, "value": "isolated", "authorization_reference": "private-authorization"},
                       normalized_result={"name": f"Isolated {kind}"}, raw_snapshot={"extra": "private-raw"},
                       limitations=["Confirm at source"], created_at=datetime.now(UTC) - timedelta(days=age))
    async with api.factory() as session:
        session.add(run)
        await session.commit()
    return run


async def test_history_is_tenant_scoped_and_omits_raw_requests(history_api):
    api = history_api
    own = await saved_run(api)
    other = await saved_run(api, tenant=uuid4())
    result = await api.client.get("/v1/osint/runs")
    assert result.status_code == 200, result.text
    assert [row["id"] for row in result.json()] == [str(own.id)]
    row = result.json()[0]
    assert row["normalized_result"] == {"name": "Isolated cnpj"}
    assert row["limitations"] == ["Confirm at source"]
    assert row["purpose"] == "Isolated company research"
    assert row["created_at"]
    assert "request_payload" not in row and "raw_snapshot" not in row
    assert "private-authorization" not in result.text and "private-raw" not in result.text
    assert (await api.client.get(f"/v1/osint/runs/{other.id}")).status_code == 404
    detail = await api.client.get(f"/v1/osint/runs/{own.id}")
    assert detail.status_code == 200
    assert detail.json()["raw_snapshot"] == {"extra": "private-raw"}
    assert "request_payload" not in detail.json()
    async with api.factory() as session:
        audit = await session.scalar(select(AuditEvent).where(AuditEvent.action == "osint.run.list"))
        assert audit.tenant_id == api.state.principal.tenant_id
        assert audit.metadata_safe["count"] == 1


async def test_history_filters_kind_connector_and_limits_newest_first(history_api):
    api = history_api
    older = await saved_run(api, age=2)
    newer = await saved_run(api, age=1, status="queued")
    await saved_run(api, kind="cep")
    await saved_run(api, connector="rdap_dns", kind="cnpj")
    result = await api.client.get("/v1/osint/runs?connector_id=brasilapi&kind=cnpj")
    assert result.status_code == 200
    assert [row["id"] for row in result.json()] == [str(newer.id), str(older.id)]
    limited = await api.client.get("/v1/osint/runs?connector_id=brasilapi&kind=cnpj&limit=1")
    assert [row["id"] for row in limited.json()] == [str(newer.id)]
    assert limited.json()[0]["status"] == "queued"


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "connector_id=unknown", "kind=cnpj%27%20OR%201=1", "kind=unknown"])
async def test_history_rejects_invalid_filters(history_api, query):
    assert (await history_api.client.get(f"/v1/osint/runs?{query}")).status_code == 422


@pytest.mark.parametrize("roles", [frozenset(), frozenset({"unknown"})])
async def test_unknown_roles_cannot_read_history_or_detail(history_api, roles):
    api = history_api
    item = await saved_run(api)
    api.state.principal = replace(api.state.principal, roles=roles)
    assert (await api.client.get("/v1/osint/runs")).status_code == 403
    assert (await api.client.get(f"/v1/osint/runs/{item.id}")).status_code == 403


async def test_auditor_can_review_persisted_history_but_cannot_enqueue_research(history_api, monkeypatch):
    api = history_api
    item = await saved_run(api)
    api.state.principal = replace(api.state.principal, roles=frozenset({"auditor"}))
    response = await api.client.get("/v1/osint/runs?connector_id=brasilapi&kind=cnpj")
    assert response.status_code == 200
    assert response.json()[0]["id"] == str(item.id)
    detail = await api.client.get(f"/v1/osint/runs/{item.id}")
    assert detail.status_code == 200
    monkeypatch.setattr(investigations.rate_limiter, "allow", AsyncMock(return_value=True))
    attempt = await api.client.post("/v1/osint/runs", json={
        "connector_id": "brasilapi", "payload": {"kind": "cnpj", "value": "00000000000191"},
        "purpose": "Isolated research request", "legal_basis": "autorizacao",
        "authorization_reference": "isolated-test",
    })
    assert attempt.status_code == 403
    async with api.factory() as session:
        assert list((await session.scalars(select(ConnectorRun.id))).all()) == [item.id]
        assert await session.scalar(select(OutboxEvent.id)) is None
