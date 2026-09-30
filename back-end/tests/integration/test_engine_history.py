from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import AuditEvent, Investigation, InvestigationEngineRun, InvestigationScope


@pytest.fixture
def api():
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def identity(roles="administrator"):
    return {"X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Tenant-Id": str(uuid4()), "X-Semperfi-Roles": roles}


def payload():
    return {"target": "Objeto declarado no teste", "target_type": "company", "purpose": "Planejamento autorizado para teste isolado",
            "legal_basis": "contrato", "authorization_reference": "referencia-privada", "declared_scope": ["empresarial"],
            "connectors_allowed": ["brasilapi"], "risk_level": "low", "seed_facts": {"observacoes": "informacao-privada"},
            "request_id": str(uuid4())}


@pytest.mark.parametrize("engine", ["tacer", "siera"])
def test_plan_persists_retries_idempotently_and_accepts_one_review(api, engine):
    headers, body = identity(), payload()
    path = f"/v1/investigation-engines/{engine}/run"
    result = api.post(path, headers=headers, json=body)
    assert result.status_code == 200, result.text
    run_id = result.json()["run_id"]
    assert result.json()["engine"] == engine.upper()
    assert api.post(path, headers=headers, json=body).json()["run_id"] == run_id
    assert api.post(path, headers=headers, json={**body, "target": "Outro alvo"}).status_code == 409
    history_path = "/v1/investigation-engines/runs"
    history = api.get(history_path, headers=headers).json()
    assert len(history) == 1 and history[0]["id"] == run_id
    assert "target" not in history[0] and "authorization_reference" not in history[0]
    detail = api.get(f"{history_path}/{run_id}", headers=headers)
    assert detail.json()["input_safe"]["target"] == body["target"]
    assert "referencia-privada" not in detail.text
    review = {"decision": "reviewed", "notes": "Escopo revisado pelo responsável do teste"}
    response = api.patch(f"{history_path}/{run_id}/review", headers=headers, json=review)
    assert response.status_code == 200, response.text
    assert response.json()["review_status"] == "reviewed"
    assert api.patch(f"{history_path}/{run_id}/review", headers=headers, json=review).status_code == 409
    assert api.get(f"{history_path}/{run_id}", headers=headers).json()["review_notes"] == review["notes"]
    assert api.get(history_path+"?offset=1", headers=headers).json() == []
    other = "siera" if engine == "tacer" else "tacer"
    assert api.get(history_path+f"?engine={other}", headers=headers).json() == []

    async def inspect_audit():
        async with SessionLocal() as session:
            events = (await session.scalars(select(AuditEvent).where(AuditEvent.tenant_id == UUID(headers["X-Semperfi-Tenant-Id"])))).all()
            assert len([event for event in events if event.action == f"engine.{engine}.run"]) == 1
            assert any(event.action == "engine.run.review" for event in events)
            item = await session.get(InvestigationEngineRun, UUID(run_id))
            assert item.input_ciphertext and item.result_ciphertext and item.review_notes_ciphertext
    api.portal.call(inspect_audit)


def test_engine_history_permissions_and_validation(api):
    owner, foreign = identity(), identity()
    result = api.post("/v1/investigation-engines/tacer/run", headers=owner, json=payload())
    assert result.status_code == 200, result.text
    run_id = result.json()["run_id"]
    path = f"/v1/investigation-engines/runs/{run_id}"
    assert api.get(path, headers=foreign).status_code == 404
    assert api.get("/v1/investigation-engines/runs", headers=foreign).json() == []
    auditor = {**owner, "X-Semperfi-Roles": "auditor"}
    assert api.get(path, headers=auditor).status_code == 200
    assert api.post("/v1/investigation-engines/tacer/run", headers=auditor, json=payload()).status_code == 403
    assert api.patch(path+"/review", headers=auditor, json={"decision": "reviewed", "notes": "Review authorization test"}).status_code == 403
    for body in [{**payload(), "declared_scope": []}, {**payload(), "purpose": " "*10}, {**payload(), "seed_facts": {"text": "x"*16001}}]:
        assert api.post("/v1/investigation-engines/tacer/run", headers=owner, json=body).status_code == 422
    restricted = {**owner, "X-Semperfi-Roles": "lawyer"}
    high_risk = api.post("/v1/investigation-engines/tacer/run", headers=restricted, json={**payload(), "risk_level": "high"})
    assert high_risk.status_code == 202 and high_risk.json()["detail"]["status"] == "approval_required"
    assert len(api.get("/v1/investigation-engines/runs", headers=owner).json()) == 1


@pytest.mark.parametrize("case,expected", [("active", 200), ("foreign", 404), ("deleted", 404), ("closed", 409), ("scope", 403)])
def test_engine_enforces_investigation_and_approved_scope(api, case, expected):
    owner = identity()
    async def seed():
        async with SessionLocal() as session:
            inv = Investigation(tenant_id=uuid4() if case == "foreign" else UUID(owner["X-Semperfi-Tenant-Id"]),
                                title="Investigação de teste", category="test", objective="Objetivo declarado", purpose="Finalidade do teste",
                                legal_basis="contrato", authorization_reference="test-ref", proportionality_assessment="Limitado ao teste",
                                status={"deleted": "deleted", "closed": "concluida"}.get(case, "em_coleta"))
            session.add(inv)
            await session.flush()
            session.add(InvestigationScope(investigation_id=inv.id, scope_code="empresarial", approved=case != "scope"))
            identifier = str(inv.id)
            await session.commit()
            return identifier
    investigation_id = api.portal.call(seed)
    response = api.post("/v1/investigation-engines/tacer/run", headers=owner, json={**payload(), "investigation_id": investigation_id})
    assert response.status_code == expected, response.text
