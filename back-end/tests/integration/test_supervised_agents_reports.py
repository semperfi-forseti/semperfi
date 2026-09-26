import hashlib
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.agents.providers import AgentDraft, AISettings, ProviderUnavailable
from app.api.v1 import evidence, investigations, reports
from app.db import get_db
from app.models import (
    Base,
    Client,
    ConnectorRun,
    Entity,
    EntityIdentifier,
    Evidence,
    Investigation,
    Report,
)
from app.security import Principal, get_current_principal
from app.services import agent_runs


@pytest.fixture
async def isolated_api(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'agents.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(principal=Principal(uuid4(), uuid4(), "isolated@example.invalid", "Teste isolado",
                                               frozenset({"administrator"}), datetime.now(UTC), "test"))
    async def principal():
        return state.principal
    async def session():
        async with factory() as item:
            yield item
    app = FastAPI()
    app.include_router(reports.router, prefix="/v1")
    app.include_router(evidence.router, prefix="/v1")
    app.include_router(investigations.router, prefix="/v1")
    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_principal] = principal
    provider = SimpleNamespace(model_name="isolated-local-model", generate=AsyncMock(return_value=AgentDraft(
        facts=["Alegação fornecida no texto."], inferences=[], recommendations=[], evidence_ids=[], limitations=[], confidence=0.2)))
    monkeypatch.setattr(reports, "get_agent_provider", lambda: provider)
    monkeypatch.setattr(agent_runs, "get_agent_provider", lambda: provider)
    monkeypatch.setattr(agent_runs, "SessionLocal", factory)
    monkeypatch.setattr(reports, "get_ai_settings", lambda: AISettings(_env_file=None, ai_provider="ollama", ollama_model=provider.model_name))
    queue = Mock(return_value=SimpleNamespace(id="isolated-job"))
    monkeypatch.setattr(reports.run_supervised_agent, "apply_async", queue)
    monkeypatch.setattr(investigations.rate_limiter, "allow", AsyncMock(return_value=True))
    # Every transport/storage operation must be explicitly mocked by its test.
    stage = AsyncMock(side_effect=AssertionError("No real upload staging in tests"))
    monkeypatch.setattr(evidence.evidence_service, "stage_upload", stage)
    for method in ("store_bytes", "store_original", "presigned_download", "verify_remote_hash"):
        monkeypatch.setattr(evidence.evidence_service, method, Mock(side_effect=AssertionError("No real cofre in tests")))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as client:
        yield SimpleNamespace(client=client, factory=factory, state=state, provider=provider, queue=queue, stage=stage)
    await engine.dispose()


def run_body(**overrides):
    return {"agent_type": "timeline", "input_safe": {"text": "Texto para análise isolada."},
            "purpose": "Revisão de documento de teste", "legal_basis": "autorizacao", "authorization_reference": "test-001", **overrides}


def report_body(**overrides):
    return {"title": "Relatório isolado", "body": {"object": "Documento de teste"},
            "purpose": "Revisão de documento de teste", "legal_basis": "autorizacao", "authorization_reference": "test-001", **overrides}


async def add_investigation(api, *, tenant=None, status="em_coleta"):
    case = Investigation(tenant_id=tenant or api.state.principal.tenant_id, title="Investigação isolada", category="other",
                         objective="Teste", purpose="Teste isolado", legal_basis="autorizacao", authorization_reference="test-001",
                         proportionality_assessment="Teste isolado", status=status)
    async with api.factory() as session:
        session.add(case)
        await session.commit()
    return case


async def add_evidence(api, *, tenant=None, investigation=None, preserved=False, **values):
    item = Evidence(tenant_id=tenant or api.state.principal.tenant_id, investigation_id=investigation,
                    original_filename="isolated.pdf", mime_type="application/pdf", size_bytes=4, sha256="a" * 64,
                    source_type="manual_upload", collection_method="manual_upload", collected_at=datetime.now(UTC),
                    storage_bucket="isolated-bucket" if preserved else None, storage_key="isolated-key" if preserved else None,
                    storage_version_id="isolated-version" if preserved else None, validation_status="preserved" if preserved else "pending", **values)
    async with api.factory() as session:
        session.add(item)
        await session.commit()
    return item


async def test_queued_run_is_persisted_before_dispatch_and_reviewable_only_in_own_tenant(isolated_api):
    api = isolated_api
    response = await api.client.post("/v1/agents/runs", json=run_body())
    assert response.status_code == 202, response.text
    run_id = response.json()["agent_run_id"]
    assert (await api.client.get(f"/v1/agents/runs/{run_id}")).json()["status"] == "queued"
    tenant_id = str(api.state.principal.tenant_id)
    api.queue.assert_called_once_with(args=[run_id, "timeline", tenant_id])
    result = await agent_runs.execute_agent_run(run_id, tenant_id)
    assert result["status"] == "pending_human_review"
    row = (await api.client.get(f"/v1/agents/runs/{run_id}")).json()
    assert row["model_name"] == "isolated-local-model"
    assert row["requires_human_review"] is True
    assert row["output"]["classification"] == "draft_assistance"
    assert row["output"]["limitations"]
    assert len((await api.client.get("/v1/agents/runs?limit=100")).json()) == 1
    assert (await agent_runs.execute_agent_run(run_id, tenant_id))["status"] == "not_queued"
    assert api.provider.generate.await_count == 1
    api.state.principal = replace(api.state.principal, tenant_id=uuid4())
    assert (await api.client.get(f"/v1/agents/runs/{run_id}")).status_code == 404
    assert (await api.client.get("/v1/agents/runs")).json() == []
    assert (await agent_runs.execute_agent_run(run_id, str(api.state.principal.tenant_id)))["status"] == "not_queued"


async def test_status_contract_and_role_checks(isolated_api):
    api = isolated_api
    response = await api.client.get("/v1/agents/status")
    assert response.json() == {"provider": "ollama", "enabled": True, "model": "isolated-local-model", "requires_human_review": True}
    api.state.principal = replace(api.state.principal, roles=frozenset({"client"}))
    for path in ("/v1/agents/status", "/v1/agents/runs", f"/v1/agents/runs/{uuid4()}"):
        assert (await api.client.get(path)).status_code == 403
    assert (await api.client.post("/v1/agents/runs", json=run_body())).status_code == 403


async def test_queue_failure_and_provider_failure_are_persisted_without_private_details(isolated_api):
    api = isolated_api
    api.queue.side_effect = RuntimeError("private-broker-password")
    response = await api.client.post("/v1/agents/runs", json=run_body())
    assert response.status_code == 503
    run_id = response.json()["detail"]["agent_run_id"]
    row = (await api.client.get(f"/v1/agents/runs/{run_id}")).json()
    assert row["status"] == "failed" and "private" not in str(row["output"])
    api.queue.side_effect = None
    response = await api.client.post("/v1/agents/runs", json=run_body())
    run_id = response.json()["agent_run_id"]
    api.provider.generate.side_effect = ProviderUnavailable("private-host-and-input")
    result = await agent_runs.execute_agent_run(run_id, str(api.state.principal.tenant_id))
    assert result["error_code"] == "PROVIDER_UNAVAILABLE"
    row = (await api.client.get(f"/v1/agents/runs/{run_id}")).json()
    assert row["status"] == "failed" and "private" not in str(row["output"])


@pytest.mark.parametrize("resource", ["agents/runs", "reports"])
@pytest.mark.parametrize("relation", ["foreign", "missing", "other_investigation", "archived"])
async def test_agent_and_report_references_are_tenant_and_investigation_scoped(isolated_api, resource, relation):
    api = isolated_api
    case = await add_investigation(api, status="archived" if relation == "archived" else "em_coleta")
    item = await add_evidence(api, tenant=uuid4() if relation == "foreign" else None,
                              investigation=None if relation == "other_investigation" else case.id)
    evidence_id = uuid4() if relation == "missing" else item.id
    fields = {"investigation_id": str(case.id)}
    if resource == "reports":
        body = report_body(**fields, evidence_ids=[str(evidence_id)])
    else:
        body = run_body(**fields, input_safe={"text": "Texto de teste", "evidence_ids": [str(evidence_id)]})
    response = await api.client.post(f"/v1/{resource}", json=body)
    assert response.status_code == (409 if relation == "archived" else 404), response.text
    api.queue.assert_not_called()


async def test_references_are_revalidated_after_model_execution(isolated_api):
    api = isolated_api
    case = await add_investigation(api)
    response = await api.client.post("/v1/agents/runs", json=run_body(investigation_id=str(case.id)))
    run_id = response.json()["agent_run_id"]
    original = api.provider.generate.return_value
    async def archive_during_generation(*args):
        async with api.factory() as session:
            item = await session.get(Investigation, case.id)
            item.status = "archived"
            await session.commit()
        return original
    api.provider.generate.side_effect = archive_during_generation
    result = await agent_runs.execute_agent_run(run_id, str(api.state.principal.tenant_id))
    assert result["status"] == "failed" and result["error_code"] == "INVALID_REFERENCES"


async def test_report_approval_hashes_pdf_and_download_is_versioned_and_tenant_scoped(isolated_api, monkeypatch):
    api = isolated_api
    item = await add_evidence(api, preserved=True)
    response = await api.client.post("/v1/reports", json=report_body(evidence_ids=[str(item.id)]))
    assert response.status_code == 201, response.text
    report_id = response.json()["report_id"]
    pdf = b"%PDF-isolated-test"
    monkeypatch.setattr(reports, "build_pdf_bytes", Mock(return_value=pdf))
    store = Mock(return_value={"key": "report-key", "version_id": "report-version"})
    monkeypatch.setattr(reports.evidence_service, "store_bytes", store)
    response = await api.client.post(f"/v1/reports/{report_id}/approve")
    assert response.status_code == 200, response.text
    assert store.call_args.kwargs["sha256"] == hashlib.sha256(pdf).hexdigest()
    assert (await api.client.post(f"/v1/reports/{report_id}/approve")).status_code == 200
    assert store.call_count == 1
    signer = Mock(return_value="https://isolated.invalid/report")
    monkeypatch.setattr(reports.evidence_service, "presigned_download", signer)
    assert (await api.client.get(f"/v1/reports/{report_id}/download")).status_code == 200
    assert signer.call_args.args[1:] == ("report-key", "report-version")
    api.state.principal = replace(api.state.principal, tenant_id=uuid4())
    assert (await api.client.get(f"/v1/reports/{report_id}/download")).status_code == 404
    assert (await api.client.post(f"/v1/reports/{report_id}/approve")).status_code == 404
    assert signer.call_count == 1


@pytest.mark.parametrize("problem", ["unpreserved", "foreign_reference", "unversioned_storage"])
async def test_report_cannot_become_final_with_invalid_preservation(isolated_api, monkeypatch, problem):
    api = isolated_api
    item = await add_evidence(api, preserved=problem != "unpreserved")
    response = await api.client.post("/v1/reports", json=report_body(evidence_ids=[str(item.id)]))
    report_id = response.json()["report_id"]
    if problem == "foreign_reference":
        async with api.factory() as session:
            row = await session.get(Evidence, item.id)
            row.tenant_id = uuid4()
            await session.commit()
    monkeypatch.setattr(reports, "build_pdf_bytes", Mock(return_value=b"%PDF-isolated"))
    store = Mock(return_value={"key": "report-key", "version_id": None})
    monkeypatch.setattr(reports.evidence_service, "store_bytes", store)
    response = await api.client.post(f"/v1/reports/{report_id}/approve")
    assert response.status_code == {"unpreserved": 409, "foreign_reference": 404, "unversioned_storage": 503}[problem]
    async with api.factory() as session:
        assert (await session.scalar(select(Report).where(Report.id == UUID(report_id)))).status == "DRAFT"


@pytest.mark.parametrize("problem", ["foreign", "missing", "archived"])
async def test_upload_rejects_invalid_investigation_before_staging(isolated_api, problem):
    api = isolated_api
    case = await add_investigation(api, tenant=uuid4() if problem == "foreign" else None, status="archived" if problem == "archived" else "em_coleta")
    response = await api.client.post("/v1/evidences/uploads", data={"investigation_id": str(uuid4() if problem == "missing" else case.id),
        "purpose": "Teste de vínculo", "legal_basis": "autorizacao", "authorization_reference": "test-001"},
        files={"file": ("isolated.pdf", b"%PDF-isolated", "application/pdf")})
    assert response.status_code == (409 if problem == "archived" else 404), response.text
    api.stage.assert_not_awaited()


async def test_evidence_download_requires_preservation_own_tenant_and_recent_mfa(isolated_api, monkeypatch):
    api = isolated_api
    item = await add_evidence(api, preserved=True)
    signer = Mock(return_value="https://isolated.invalid/evidence")
    monkeypatch.setattr(evidence.evidence_service, "presigned_download", signer)
    assert (await api.client.get(f"/v1/evidences/{item.id}/download")).status_code == 200
    signer.assert_called_once_with("isolated-bucket", "isolated-key", "isolated-version")
    original = api.state.principal
    api.state.principal = replace(original, tenant_id=uuid4())
    assert (await api.client.get(f"/v1/evidences/{item.id}/download")).status_code == 404
    api.state.principal = replace(original, mfa_verified_at=datetime.now(UTC) - timedelta(days=1))
    assert (await api.client.get(f"/v1/evidences/{item.id}/download")).status_code == 403
    api.state.principal = original
    unpreserved = await add_evidence(api)
    assert (await api.client.get(f"/v1/evidences/{unpreserved.id}/download")).status_code == 409
    assert (await api.client.post(f"/v1/evidences/{unpreserved.id}/attest")).status_code == 409
    assert signer.call_count == 1


@pytest.mark.parametrize("audit_fails", [False, True])
async def test_finalize_keeps_original_until_commit_and_is_idempotent(isolated_api, monkeypatch, tmp_path, audit_fails):
    api = isolated_api
    stage_file = tmp_path / "isolated.pdf"
    stage_file.write_bytes(b"%PDF")
    item = await add_evidence(api, metadata_json={"staged_path": str(stage_file)})
    store = Mock(return_value={"bucket": "isolated-bucket", "key": "isolated-key", "version_id": "isolated-version",
                              "etag": "test-etag", "retain_until": datetime.now(UTC) + timedelta(days=1)})
    monkeypatch.setattr(evidence.evidence_service, "store_original", store)
    cleanup = Mock(side_effect=lambda staged: stage_file.unlink())
    monkeypatch.setattr(evidence.evidence_service, "cleanup_stage", cleanup)
    if audit_fails:
        monkeypatch.setattr(evidence, "append_evidence_event", AsyncMock(side_effect=RuntimeError("isolated transaction failure")))
    response = await api.client.post(f"/v1/evidences/{item.id}/finalize")
    if audit_fails:
        assert response.status_code == 500
        assert stage_file.exists()
        cleanup.assert_not_called()
        async with api.factory() as session:
            row = await session.get(Evidence, item.id)
            assert row.storage_key is None and row.metadata_json["staged_path"] == str(stage_file)
    else:
        assert response.status_code == 200, response.text
        assert not stage_file.exists()
        repeat = await api.client.post(f"/v1/evidences/{item.id}/finalize")
        assert repeat.status_code == 200 and repeat.json() == response.json()
        assert store.call_count == 1 and cleanup.call_count == 1


def connector_body(case_id, entity_id, connector="brasilapi", **payload):
    return {"investigation_id": str(case_id) if case_id else None, "target_entity_id": str(entity_id),
            "connector_id": connector, "payload": payload, "purpose": "Consulta isolada autorizada",
            "legal_basis": "autorizacao", "authorization_reference": "test-001", "scope_codes": ["digital_defensive"]}


@pytest.mark.parametrize("connector,entity_type,value,field,extra", [
    ("brasilapi", "company", "00000000000191", "value", {"kind": "cnpj"}),
    ("datajud", "process", "0000001-91.2024.8.26.0001", "process_number", {"tribunal_alias": "tjsp"}),
    ("rdap_dns", "domain", "example.invalid", "domain", {"authorized": True}),
    ("transparency", "person", "00000000191", "document", {"dataset": "ceis", "name": "Texto obsoleto"}),
])
async def test_connector_uses_protected_primary_identifier_not_browser_display_name(isolated_api, connector, entity_type, value, field, extra):
    api = isolated_api
    case = await add_investigation(api)
    response = await api.client.post(f"/v1/investigations/{case.id}/entities", json={"entity_type": entity_type,
        "display_name": "Nome de exibição não é identificador", "identifiers": [{"type": "document", "value": value, "primary": True}]})
    assert response.status_code == 201, response.text
    entity_id = response.json()["id"]
    response = await api.client.post("/v1/osint/runs", json=connector_body(case.id, entity_id, connector, **{field: "nome incorreto", **extra}))
    assert response.status_code == 202, response.text
    async with api.factory() as session:
        row = await session.get(ConnectorRun, UUID(response.json()["run_id"]))
        assert row.request_payload[field] == value
        if connector == "transparency": assert "name" not in row.request_payload
        stored = await session.scalar(select(EntityIdentifier).where(EntityIdentifier.entity_id == UUID(entity_id)))
        assert stored.is_primary is True
    detail = await api.client.get(f"/v1/investigations/{case.id}")
    assert value not in detail.text


@pytest.mark.parametrize("problem", ["foreign", "other_case", "deleted_entity", "archived_case", "no_case", "wrong_type", "missing_identifier"])
async def test_connector_rejects_invalid_entity_without_queueing(isolated_api, problem):
    api = isolated_api
    case = await add_investigation(api, status="archived" if problem == "archived_case" else "em_coleta")
    other = await add_investigation(api) if problem == "other_case" else case
    entity = Entity(tenant_id=uuid4() if problem == "foreign" else api.state.principal.tenant_id, investigation_id=other.id,
                    entity_type="person" if problem == "wrong_type" else "company", display_name="Alvo isolado",
                    verification_status="deleted" if problem == "deleted_entity" else "preliminary")
    async with api.factory() as session:
        session.add(entity)
        await session.commit()
    response = await api.client.post("/v1/osint/runs", json=connector_body(None if problem == "no_case" else case.id, entity.id, kind="cnpj"))
    expected = 409 if problem == "archived_case" else (422 if problem in {"no_case", "wrong_type", "missing_identifier"} else 404)
    assert response.status_code == expected, response.text
    async with api.factory() as session:
        assert (await session.scalars(select(ConnectorRun))).all() == []


async def test_connector_rate_limit_is_enforced_before_queueing(isolated_api, monkeypatch):
    api = isolated_api
    monkeypatch.setattr(investigations.rate_limiter, "allow", AsyncMock(return_value=False))
    response = await api.client.post("/v1/osint/runs", json=connector_body(uuid4(), uuid4(), kind="cnpj"))
    assert response.status_code == 429


@pytest.mark.parametrize("reference", ["evidence", "entity"])
async def test_finding_rejects_foreign_links_on_create_and_update(isolated_api, reference):
    api = isolated_api
    case = await add_investigation(api)
    foreign_evidence = await add_evidence(api, tenant=uuid4())
    foreign_entity = Entity(tenant_id=uuid4(), investigation_id=case.id, entity_type="company", display_name="Alvo externo")
    async with api.factory() as session:
        session.add(foreign_entity)
        await session.commit()
    body = {"title": "Achado de teste", "statement": "Declaração de teste", "source_name": "Teste", "method": "manual", "collected_at": datetime.now(UTC).isoformat()}
    path = f"/v1/investigations/{case.id}/findings"
    bad_field = {"evidence_id": str(foreign_evidence.id)} if reference == "evidence" else {"entity_id": str(foreign_entity.id)}
    assert (await api.client.post(path, json={**body, **bad_field})).status_code == 404
    if reference == "evidence":
        response = await api.client.post(path, json=body)
        assert response.status_code == 201
        assert (await api.client.patch(f"/v1/findings/{response.json()['id']}", json=bad_field)).status_code == 404


async def test_investigation_rejects_foreign_client_and_readonly_mutations(isolated_api):
    api = isolated_api
    foreign_client = Client(tenant_id=uuid4(), kind="PF", name="Registro isolado")
    async with api.factory() as session:
        session.add(foreign_client)
        await session.commit()
    body = {"title": "Investigação de teste", "category": "other", "objective": "Análise documental isolada para verificar autorização dos vínculos.",
            "purpose": "Teste de referência", "legal_basis": "autorizacao", "authorization_reference": "test-001",
            "proportionality_assessment": "Escopo de teste restrito", "scope_codes": ["proof_digital"], "client_id": str(foreign_client.id)}
    assert (await api.client.post("/v1/investigations", json=body)).status_code == 404
    api.state.principal = replace(api.state.principal, roles=frozenset({"auditor"}))
    assert (await api.client.post("/v1/investigations", json={**body, "client_id": None})).status_code == 403
