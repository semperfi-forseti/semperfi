"""Persisted investigation workspaces and server-authored report drafts.

Every request uses a fresh database session. Fixtures are isolated from the
operational database and never invoke external providers or object storage.
"""

from dataclasses import replace
from datetime import UTC, date, datetime
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import frontend, investigation_reports, investigations, reports
from app.db import get_db
from app.models import (
    AuditEvent,
    Base,
    ConnectorRun,
    Entity,
    EntityRelation,
    Evidence,
    Finding,
    Investigation,
    InvestigationScope,
    Report,
)
from app.reports import build_pdf_bytes, canonical_hash
from app.security import Principal, get_current_principal


@pytest.fixture
async def workspace_api(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'workspace.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    state = SimpleNamespace(principal=Principal(
        uuid4(), uuid4(), "isolated@example.invalid", "Responsável autenticado",
        frozenset({"administrator"}), datetime.now(UTC), "test",
    ))

    async def principal():
        return state.principal

    async def session():
        async with factory() as item:
            yield item

    app = FastAPI()
    for router in (investigations.router, investigation_reports.router, frontend.router, reports.router):
        app.include_router(router, prefix="/v1")
    app.dependency_overrides[get_db] = session
    app.dependency_overrides[get_current_principal] = principal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield SimpleNamespace(client=client, factory=factory, state=state)
    await engine.dispose()


def investigation_body(**changes):
    return {
        "title": "Diligências de documentação", "category": "other",
        "objective": "Verificar a documentação fornecida de forma restrita e registrar sua origem para revisão humana.",
        "hypothesis": "Hipótese ainda não confirmada.", "purpose": "Conferência documental isolada",
        "legal_basis": "autorizacao", "authorization_reference": "isolated-001",
        "proportionality_assessment": "Apenas documentação abrangida pela autorização.",
        "scope_codes": ["proof_digital"], "risk_level": "low",
        "operational_owner": "Equipe de diligências", "priority": "critical", "deadline": "2026-10-17",
        "questions": ["Qual é a origem do registro?", "Há documentação para revisão?"],
        "expected_result": "Relatório revisável com proveniência e limitações.", **changes,
    }


def finding_body(**changes):
    return {
        "title": "Achado documentado", "statement": "Declaração de teste ainda não validada.",
        "source_name": "Fonte isolada", "method": "Consulta autorizada",
        "collected_at": datetime.now(UTC).isoformat(), "limitations": ["Revisão humana pendente"],
        **changes,
    }


async def create_case(api, **changes):
    response = await api.client.post("/v1/investigations", json=investigation_body(**changes))
    assert response.status_code == 201, response.text
    return response.json()


async def saved_entity(api, case_id, **changes):
    values = {
        "tenant_id": api.state.principal.tenant_id, "investigation_id": UUID(case_id),
        "entity_type": "company", "display_name": "Entidade documental", "aliases": ["Nome anterior"],
        **changes,
    }
    item = Entity(**values)
    async with api.factory() as session:
        session.add(item)
        await session.commit()
    return item


async def saved_run(api, case_id, **changes):
    values = {
        "tenant_id": api.state.principal.tenant_id, "investigation_id": UUID(case_id),
        "connector_id": "osint_tools", "status": "completed", "purpose": "Conferência isolada de origem",
        "correlation_id": "isolated-correlation", "request_hash": "a" * 64,
        "response_hash": "b" * 64, "request_payload": {"tool": "dns", "value": "example.org"},
        "raw_snapshot": {"tool": "dns", "target": "example.org", "data": {"records": ["original completo " * 100]}},
        "normalized_result": {"summary": "Resumo de exibição"}, "limitations": ["Fonte pública"],
        **changes,
    }
    item = ConnectorRun(**values)
    async with api.factory() as session:
        session.add(item)
        await session.commit()
    return item


async def test_investigation_fields_survive_new_sessions_and_bootstrap(workspace_api):
    api = workspace_api
    body = investigation_body(priority="critica")
    created = await create_case(api, priority="critica")
    assert created["owner_id"] == str(api.state.principal.user_id)
    fields = ("operational_owner", "deadline", "questions", "expected_result", "hypothesis")
    detail = await api.client.get(f"/v1/investigations/{created['id']}")
    listing = await api.client.get("/v1/investigations")
    assert detail.status_code == listing.status_code == 200
    for result in (created, detail.json(), listing.json()[0]):
        assert {key: result[key] for key in fields} == {key: body[key] for key in fields}
        assert result["priority"] == "critical"
        assert result["scope_codes"] == ["proof_digital"]
    async with api.factory() as session:
        stored = await session.get(Investigation, UUID(created["id"]))
        assert stored.deadline == date(2026, 10, 17)
        assert stored.questions == body["questions"]
        assert stored.operational_owner != str(stored.owner_id)
    response = await api.client.get("/v1/frontend/bootstrap")
    assert response.status_code == 200, response.text
    row = response.json()["data"]["investigations"][0]
    assert row["owner"] == body["operational_owner"]
    assert row["priority"] == "critica"
    assert row["deadline"] == body["deadline"]
    assert row["questions"] == body["questions"]
    assert row["expected"] == body["expected_result"]


async def test_omitted_fields_receive_honest_defaults_and_entity_aliases_persist(workspace_api):
    api = workspace_api
    body = investigation_body()
    for key in ("operational_owner", "priority", "deadline", "questions", "expected_result"):
        body.pop(key)
    response = await api.client.post("/v1/investigations", json=body)
    assert response.status_code == 201, response.text
    case = response.json()
    assert case["priority"] == "medium" and case["questions"] == []
    assert case["deadline"] is case["operational_owner"] is case["expected_result"] is None
    aliases = ["Razão social anterior", "Designação comercial"]
    response = await api.client.post(f"/v1/investigations/{case['id']}/entities", json={
        "entity_type": "company", "display_name": "Documentação Ltda.", "aliases": aliases,
    })
    assert response.status_code == 201, response.text
    entity_id = response.json()["id"]
    assert response.json()["aliases"] == aliases
    detail = (await api.client.get(f"/v1/investigations/{case['id']}")).json()
    assert detail["entities"][0]["aliases"] == aliases
    bootstrap = (await api.client.get("/v1/frontend/bootstrap")).json()["data"]
    assert bootstrap["osintEntities"][0]["aliases"] == aliases
    async with api.factory() as session:
        assert (await session.get(Entity, UUID(entity_id))).aliases == aliases


@pytest.mark.parametrize("extra", [
    {"priority": "urgent"}, {"deadline": "2026-02-31"}, {"questions": [""]},
    {"questions": ["Q"] * 51}, {"operational_owner": "x" * 161},
    {"expected_result": "x" * 4001}, {"browser_only": "must not disappear silently"},
])
async def test_invalid_investigation_fields_are_rejected_without_partial_writes(workspace_api, extra):
    api = workspace_api
    response = await api.client.post("/v1/investigations", json=investigation_body(**extra))
    assert response.status_code == 422
    async with api.factory() as session:
        assert (await session.scalars(select(Investigation))).all() == []


async def test_workspace_reads_exclude_foreign_or_deleted_children(workspace_api):
    api = workspace_api
    case = await create_case(api)
    visible = await saved_entity(api, case["id"])
    peer = await saved_entity(api, case["id"], display_name="Outra entidade autorizada")
    foreign = await saved_entity(api, case["id"], tenant_id=uuid4(), display_name="Segredo de outra organização")
    deleted = await saved_entity(api, case["id"], verification_status="deleted")
    async with api.factory() as session:
        for target, tenant in ((peer, api.state.principal.tenant_id), (foreign, api.state.principal.tenant_id),
                               (deleted, api.state.principal.tenant_id), (peer, uuid4())):
            session.add(EntityRelation(tenant_id=tenant, investigation_id=UUID(case["id"]),
                source_entity_id=visible.id, target_entity_id=target.id, relation_type="documental"))
        await session.commit()
    detail = (await api.client.get(f"/v1/investigations/{case['id']}")).json()
    assert {row["id"] for row in detail["entities"]} == {str(visible.id), str(peer.id)}
    assert len(detail["relations"]) == 1
    response = await api.client.get("/v1/frontend/bootstrap")
    data = response.json()["data"]
    assert {row["id"] for row in data["osintEntities"]} == {str(visible.id), str(peer.id)}
    assert len(data["osintRelations"]) == 1
    assert foreign.display_name not in response.text
    api.state.principal = replace(api.state.principal, tenant_id=uuid4())
    assert (await api.client.get("/v1/investigations")).json() == []
    assert (await api.client.get(f"/v1/investigations/{case['id']}")).status_code == 404


async def test_finding_link_and_full_original_survive_reload_and_review(workspace_api):
    api = workspace_api
    case = await create_case(api)
    entity = await saved_entity(api, case["id"])
    run = await saved_run(api, case["id"], target_entity_id=entity.id)
    response = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(
        connector_run_id=str(run.id), entity_id=str(entity.id),
    ))
    assert response.status_code == 201, response.text
    finding_id = response.json()["id"]
    assert response.json()["connector_run_id"] == str(run.id)
    review = await api.client.patch(f"/v1/findings/{finding_id}", json={"human_validated": True})
    assert review.status_code == 200, review.text
    assert review.json()["connector_run_id"] == str(run.id)
    detail = (await api.client.get(f"/v1/investigations/{case['id']}")).json()
    assert detail["findings"][0]["connector_run_id"] == str(run.id)
    data = (await api.client.get("/v1/frontend/bootstrap")).json()["data"]
    assert data["osintFindings"][0]["runId"] == str(run.id)
    original = await api.client.get(f"/v1/osint/runs/{run.id}")
    assert original.status_code == 200
    assert original.json()["raw_snapshot"] == run.raw_snapshot
    assert len(str(original.json()["raw_snapshot"])) > 500
    async with api.factory() as session:
        assert (await session.get(Finding, UUID(finding_id))).connector_run_id == run.id


@pytest.mark.parametrize("problem,expected", [
    ("foreign", 404), ("other_investigation", 404), ("unattached", 404), ("missing", 404),
    ("queued", 409), ("running", 409), ("failed", 409), ("error_code", 409), ("other_entity", 422),
])
async def test_finding_rejects_invalid_collection_reference(workspace_api, problem, expected):
    api = workspace_api
    case = await create_case(api)
    entity = await saved_entity(api, case["id"])
    values = {"target_entity_id": entity.id}
    if problem == "foreign":
        values["tenant_id"] = uuid4()
    elif problem == "other_investigation":
        values["investigation_id"] = UUID((await create_case(api, title="Autre dossier"))["id"])
    elif problem == "unattached":
        values["investigation_id"] = None
    elif problem in {"queued", "running", "failed"}:
        values["status"] = problem
    elif problem == "error_code":
        values["error_code"] = "UPSTREAM_FAILURE"
    elif problem == "other_entity":
        values["target_entity_id"] = (await saved_entity(api, case["id"])).id
    run = await saved_run(api, case["id"], **values)
    response = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(
        connector_run_id=str(uuid4() if problem == "missing" else run.id), entity_id=str(entity.id),
    ))
    assert response.status_code == expected, response.text
    async with api.factory() as session:
        assert (await session.scalars(select(Finding))).all() == []


@pytest.mark.parametrize("replacement", ["another", "null"])
async def test_finding_collection_provenance_cannot_be_reassigned_or_cleared(workspace_api, replacement):
    api = workspace_api
    case = await create_case(api)
    run = await saved_run(api, case["id"])
    created = await api.client.post(f"/v1/investigations/{case['id']}/findings",
        json=finding_body(connector_run_id=str(run.id)))
    assert created.status_code == 201, created.text
    finding_id = created.json()["id"]
    other = await saved_run(api, case["id"])
    response = await api.client.patch(f"/v1/findings/{finding_id}",
        json={"connector_run_id": str(other.id) if replacement == "another" else None})
    assert response.status_code == 422
    async with api.factory() as session:
        assert (await session.get(Finding, UUID(finding_id))).connector_run_id == run.id


async def test_review_revalidates_the_persisted_collection_link(workspace_api):
    api = workspace_api
    case = await create_case(api)
    run = await saved_run(api, case["id"])
    created = await api.client.post(f"/v1/investigations/{case['id']}/findings",
        json=finding_body(connector_run_id=str(run.id)))
    assert created.status_code == 201, created.text
    async with api.factory() as session:
        stored_run = await session.get(ConnectorRun, run.id)
        stored_run.tenant_id = uuid4()
        await session.commit()
    response = await api.client.patch(f"/v1/findings/{created.json()['id']}", json={"human_validated": True})
    assert response.status_code == 404
    async with api.factory() as session:
        assert (await session.get(Finding, UUID(created.json()["id"]))).human_validated is False


async def test_report_draft_is_a_persisted_snapshot_with_idempotent_retry(workspace_api):
    api = workspace_api
    case = await create_case(api)
    entity = await saved_entity(api, case["id"])
    await saved_entity(api, case["id"], verification_status="deleted", display_name="Entidade removida")
    await saved_entity(api, case["id"], tenant_id=uuid4(), display_name="Entidade externa")
    run = await saved_run(api, case["id"], target_entity_id=entity.id)
    created = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(
        connector_run_id=str(run.id), entity_id=str(entity.id),
    ))
    assert created.status_code == 201, created.text
    evidence = Evidence(tenant_id=api.state.principal.tenant_id, investigation_id=UUID(case["id"]),
        original_filename="documentação.pdf", mime_type="application/pdf", size_bytes=4, sha256="c" * 64,
        source_type="manual_upload", collection_method="manual_upload", collected_at=datetime.now(UTC),
        validation_status="pending")
    async with api.factory() as session:
        session.add(evidence)
        await session.commit()
    path = f"/v1/investigations/{case['id']}/report-draft"
    command = {"request_id": str(uuid4())}
    first = await api.client.post(path, json=command)
    assert first.status_code == 201, first.text
    receipt = first.json()
    assert receipt["status"] == "DRAFT" and receipt["version"] == 1
    async with api.factory() as session:
        stored = await session.get(Report, UUID(receipt["report_id"]))
        assert stored.evidence_ids == [str(evidence.id)]
        assert stored.body["investigation"]["questions"] == investigation_body()["questions"]
        assert stored.body["investigation"]["responsible"] == case["operational_owner"]
        assert stored.body["entities"] == [{"id": str(entity.id), "name": entity.display_name, "type": "company", "aliases": entity.aliases,
            "verification": "preliminary", "confidence": 0.0}]
        assert stored.body["findings"][0]["connector_run_id"] == str(run.id)
        assert stored.body["findings"][0]["reviewed"] is False
        assert stored.body["collections"][0]["response_hash"] == run.response_hash
        assert stored.body["evidence"][0]["sha256"] == evidence.sha256
        assert stored.body["evidence"][0]["status"] == "pending"
        assert stored.storage_key is None and stored.approved_by is None
        expected_hash = canonical_hash({"title": stored.title, "body": stored.body, "evidence_ids": stored.evidence_ids})
        assert stored.content_hash == receipt["content_hash"] == expected_hash
        # A retry after the underlying investigation changes must return the
        # same recorded snapshot; a fresh command can deliberately create another.
        original = await session.get(Investigation, UUID(case["id"]))
        original.objective = "Objetivo revisado no banco após emissão do primeiro rascunho."
        await session.commit()
    retry = await api.client.post(path, json=command)
    assert retry.status_code == 201 and retry.json() == receipt
    listing = await api.client.get(f"/v1/reports?investigation_id={case['id']}")
    assert listing.status_code == 200 and len(listing.json()) == 1
    assert listing.json()[0]["body"]["object"] == case["objective"]
    async with api.factory() as session:
        audits = (await session.scalars(select(AuditEvent).where(AuditEvent.action == "report.create"))).all()
        assert len(audits) == 1
        assert audits[0].metadata_safe["source"] == "database"
    revised = await api.client.post(path, json={"request_id": str(uuid4())})
    assert revised.status_code == 201
    assert revised.json()["report_id"] != receipt["report_id"]
    assert revised.json()["content_hash"] != receipt["content_hash"]


@pytest.mark.parametrize("injected", [
    {"body": {"object": "Texto inventado no navegador"}}, {"evidence_ids": [str(uuid4())]},
    {"content_hash": "d" * 64}, {"status": "FINAL"}, {"title": "Título não persistido"},
])
async def test_report_draft_rejects_browser_authored_content(workspace_api, injected):
    api = workspace_api
    case = await create_case(api)
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft",
        json={"request_id": str(uuid4()), **injected})
    assert response.status_code == 422
    async with api.factory() as session:
        assert (await session.scalars(select(Report))).all() == []


@pytest.mark.parametrize("problem,expected", [
    ("foreign", 404), ("missing", 404), ("deleted", 404),
    ("auditor", 403), ("unknown", 403), ("client", 403), ("high_risk_analyst", 403),
])
async def test_report_draft_enforces_tenant_access_and_policy(workspace_api, problem, expected):
    api = workspace_api
    case = await create_case(api, risk_level="high" if problem == "high_risk_analyst" else "low")
    if problem == "foreign":
        api.state.principal = replace(api.state.principal, tenant_id=uuid4())
    elif problem == "deleted":
        async with api.factory() as session:
            stored = await session.get(Investigation, UUID(case["id"]))
            stored.status = "deleted"
            await session.commit()
    elif problem in {"auditor", "unknown", "client", "high_risk_analyst"}:
        role = "analyst" if problem == "high_risk_analyst" else problem
        api.state.principal = replace(api.state.principal, roles=frozenset({role}))
    case_id = str(uuid4()) if problem == "missing" else case["id"]
    response = await api.client.post(f"/v1/investigations/{case_id}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == expected, response.text
    async with api.factory() as session:
        assert (await session.scalars(select(Report))).all() == []


@pytest.mark.parametrize("roles", [frozenset(), frozenset({"client"}), frozenset({"unknown"})])
async def test_unrecognized_roles_cannot_read_the_investigation_workspace(workspace_api, roles):
    api = workspace_api
    case = await create_case(api)
    api.state.principal = replace(api.state.principal, roles=roles)
    for path in ("/v1/investigations", f"/v1/investigations/{case['id']}", "/v1/frontend/bootstrap"):
        response = await api.client.get(path)
        assert response.status_code == 403, response.text


async def test_auditor_can_reload_but_not_mutate_investigation_records(workspace_api):
    api = workspace_api
    case = await create_case(api)
    api.state.principal = replace(api.state.principal, roles=frozenset({"auditor"}))
    assert (await api.client.get(f"/v1/investigations/{case['id']}")).status_code == 200
    assert (await api.client.get("/v1/frontend/bootstrap")).status_code == 200
    assert (await api.client.post("/v1/investigations", json=investigation_body())).status_code == 403
    assert (await api.client.post(f"/v1/investigations/{case['id']}/entities",
        json={"entity_type": "company", "display_name": "Entidade"})).status_code == 403
    assert (await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body())).status_code == 403


async def test_report_records_only_authorized_relations_and_saved_scope(workspace_api):
    api = workspace_api
    case = await create_case(api)
    source = await saved_entity(api, case["id"])
    target = await saved_entity(api, case["id"], display_name="Destino documentado")
    foreign = await saved_entity(api, case["id"], tenant_id=uuid4(), display_name="Nome de outro tenant")
    deleted = await saved_entity(api, case["id"], verification_status="deleted")
    other_case = await create_case(api, title="Outro caso")
    elsewhere = await saved_entity(api, other_case["id"])
    async with api.factory() as session:
        for destination, tenant, provenance in (
            (target, api.state.principal.tenant_id, {"note": "Vínculo salvo e pendente de revisão"}),
            (foreign, api.state.principal.tenant_id, {"note": "Não incluir outro tenant"}),
            (deleted, api.state.principal.tenant_id, {"note": "Não incluir removida"}),
            (elsewhere, api.state.principal.tenant_id, {"note": "Não incluir outro caso"}),
            (target, uuid4(), {"note": "Não incluir relação externa"}),
        ):
            session.add(EntityRelation(
                tenant_id=tenant, investigation_id=UUID(case["id"]), source_entity_id=source.id,
                target_entity_id=destination.id, relation_type="documental", provenance=provenance,
            ))
        session.add(InvestigationScope(investigation_id=UUID(case["id"]), scope_code="digital_defensive", approved=False))
        session.add(InvestigationScope(investigation_id=UUID(other_case["id"]), scope_code="other_case_only"))
        await session.commit()
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 201, response.text
    async with api.factory() as session:
        report = await session.get(Report, UUID(response.json()["report_id"]))
        relations = report.body["relations"]
        assert len(relations) == 1
        assert relations[0]["source_entity_id"] == str(source.id)
        assert relations[0]["target_entity_id"] == str(target.id)
        assert relations[0]["source_name"] == source.display_name
        assert relations[0]["target_name"] == target.display_name
        assert relations[0]["provenance"] == {"note": "Vínculo salvo e pendente de revisão"}
        assert relations[0]["reviewed"] is False
        assert report.body["investigation"]["scope_codes"] == [
            {"code": "digital_defensive", "approved": False}, {"code": "proof_digital", "approved": True},
        ]
        assert report.body["investigation"]["legal_basis"] == case["legal_basis"]
        assert "Não incluir" not in str(report.body)


@pytest.mark.parametrize("status", ["archived", "concluida", "draft", "aguardando_aprovacao"])
async def test_inactive_investigation_cannot_generate_draft(workspace_api, status):
    api = workspace_api
    case = await create_case(api)
    async with api.factory() as session:
        item = await session.get(Investigation, UUID(case["id"]))
        item.status = status
        await session.commit()
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 409, response.text
    async with api.factory() as session:
        assert (await session.scalars(select(Report))).all() == []


@pytest.mark.parametrize("problem", ["foreign_run", "other_case_run", "failed_run", "other_target", "foreign_evidence"])
async def test_report_revalidates_finding_provenance_before_snapshot(workspace_api, problem):
    api = workspace_api
    case = await create_case(api)
    entity = await saved_entity(api, case["id"])
    run = await saved_run(api, case["id"], target_entity_id=entity.id)
    response = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(
        connector_run_id=str(run.id), entity_id=str(entity.id),
    ))
    assert response.status_code == 201, response.text
    other_case_id = UUID((await create_case(api, title="Outro caso"))["id"]) if problem == "other_case_run" else None
    async with api.factory() as session:
        stored_run = await session.get(ConnectorRun, run.id)
        if problem == "foreign_run":
            stored_run.tenant_id = uuid4()
        elif problem == "other_case_run":
            stored_run.investigation_id = other_case_id
        elif problem == "failed_run":
            stored_run.status = "failed"
        elif problem == "other_target":
            stored_run.target_entity_id = uuid4()
        else:
            finding = await session.get(Finding, UUID(response.json()["id"]))
            foreign = Evidence(tenant_id=uuid4(), investigation_id=UUID(case["id"]),
                original_filename="foreign.pdf", mime_type="application/pdf", size_bytes=4,
                sha256="d" * 64, source_type="manual_upload", collection_method="manual_upload",
                collected_at=datetime.now(UTC), validation_status="pending")
            session.add(foreign)
            await session.flush()
            finding.evidence_id = foreign.id
        await session.commit()
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 409, response.text
    async with api.factory() as session:
        assert (await session.scalars(select(Report))).all() == []


async def test_legacy_finding_remains_explicitly_unlinked_in_report(workspace_api):
    api = workspace_api
    case = await create_case(api)
    run = await saved_run(api, case["id"])
    # A matching source label is insufficient evidence of a link to this run.
    created = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(source_name=run.connector_id))
    assert created.status_code == 201
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 201, response.text
    async with api.factory() as session:
        report = await session.get(Report, UUID(response.json()["report_id"]))
        assert report.body["findings"][0]["connector_run_id"] is None
        assert report.body["collections"][0]["id"] == str(run.id)


@pytest.mark.parametrize("roles", [frozenset(), frozenset({"client"}), frozenset({"unknown"})])
async def test_report_reads_and_exports_require_an_authorized_role(workspace_api, roles):
    api = workspace_api
    case = await create_case(api)
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 201, response.text
    report_id = response.json()["report_id"]
    api.state.principal = replace(api.state.principal, roles=roles)
    for path in ("/v1/reports", f"/v1/reports?investigation_id={case['id']}", f"/v1/reports/{report_id}/download"):
        result = await api.client.get(path)
        assert result.status_code == 403, result.text
        assert case["objective"] not in result.text


async def test_approved_investigative_pdf_uses_the_saved_draft_not_current_or_browser_data(workspace_api, monkeypatch):
    api = workspace_api
    case = await create_case(api)
    run = await saved_run(api, case["id"])
    finding = await api.client.post(f"/v1/investigations/{case['id']}/findings", json=finding_body(connector_run_id=str(run.id)))
    assert finding.status_code == 201, finding.text
    response = await api.client.post(f"/v1/investigations/{case['id']}/report-draft", json={"request_id": str(uuid4())})
    assert response.status_code == 201, response.text
    report_id = response.json()["report_id"]
    async with api.factory() as session:
        stored = await session.get(Report, UUID(report_id))
        saved_body = stored.body
        item = await session.get(Finding, UUID(finding.json()["id"]))
        item.statement = "Revisão posterior à emissão do rascunho."
        await session.commit()
    generated = []
    preserved = []

    def build(title, body, manifest):
        generated.append((body, manifest))
        return build_pdf_bytes(title, body, manifest)

    def store(data, **options):
        preserved.append((data, options))
        return {"key": "isolated-report", "version_id": "isolated-version"}

    monkeypatch.setattr(reports, "build_pdf_bytes", build)
    monkeypatch.setattr(reports.evidence_service, "store_bytes", store)
    approved = await api.client.post(f"/v1/reports/{report_id}/approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "FINAL"
    assert generated[0][0] == saved_body
    assert generated[0][0]["findings"][0]["statement"] == finding_body()["statement"]
    assert generated[0][0]["findings"][0]["connector_run_id"] == str(run.id)
    assert generated[0][1]["content_hash"] == response.json()["content_hash"]
    assert preserved[0][0].startswith(b"%PDF-")
    assert (await api.client.post(f"/v1/reports/{report_id}/approve")).status_code == 200
    assert len(generated) == len(preserved) == 1


def test_investigative_pdf_wraps_complete_title_and_provenance_without_clipping(monkeypatch):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase.pdfmetrics import stringWidth
    from reportlab.pdfgen import canvas

    printed = []
    real_canvas = canvas.Canvas

    class RecordingCanvas(real_canvas):
        def drawString(self, x, y, text, *args, **kwargs):
            printed.append((self.getPageNumber(), x, y, text, self._fontname, self._fontsize))
            return super().drawString(x, y, text, *args, **kwargs)

    monkeypatch.setattr(canvas, "Canvas", RecordingCanvas)
    title = "Relatório investigativo — Diligências e documentação " * 5
    body = {
        "object": "Descrição persistida com documentação e conclusão ainda em revisão.",
        "entities": [{"name": "Organização documentada"}],
        "relations": [{"source_name": "Origem registrada", "target_name": "Destino registrado"}],
        "findings": [{"statement": "Achado registrado " * 24} for _ in range(18)],
        "collections": [{"id": "a" * 1200, "response_hash": "b" * 64}],
        "evidence": [{"filename": "documentação.pdf", "sha256": "c" * 64}],
    }
    result = build_pdf_bytes(title, body, {"report_id": "manifesto-persistido"})
    assert result.startswith(b"%PDF-") and len(result) > 1000
    lines = [row for row in printed if row[1] == 48]
    assert max(row[0] for row in lines) > 1
    assert " ".join(row[3] for row in lines if row[5] == 16) == title.strip()
    for _, x, y, text, font, size in lines:
        assert y >= 48
        assert x + stringWidth(text, font, size) <= A4[0] - 48 + 0.01
    for index, (page, _, _, text, font, size) in enumerate(lines):
        if font == "Helvetica-Bold" and size == 11:
            assert lines[index + 1][0] == page, text
    all_text = " ".join(row[3] for row in lines)
    for expected in ("Diligências", "Vínculos entre entidades", "Achados registrados", "Coletas e proveniência",
                     "documentação.pdf", "manifesto-persistido", "Origem registrada", "Destino registrado"):
        assert expected in all_text
