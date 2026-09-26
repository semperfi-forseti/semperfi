from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import legal_launch
from app.db import SessionLocal
from app.main import app
from app.models import ProcessMovement


def identity():
    return {"X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Tenant-Id": str(uuid4()),
            "X-Semperfi-Roles": "administrator,lawyer,manager"}


@pytest.fixture
def api():
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def create(api, headers, resource, body):
    response = api.post(f"/v1/{resource}", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def client_and_process(api, headers):
    client_id = create(api, headers, "clients", {"kind": "PF", "name": "Registro isolado"})
    process_id = create(api, headers, "processes", {"client_id": client_id, "number": "00001-test"})
    return client_id, process_id


def payload(resource, client_id, process_id):
    return {
        "processes": {"client_id": client_id, "number": "00002-test"},
        "deadlines": {"process_id": process_id, "title": "Prazo isolado", "due_date": "2026-10-02"},
        "intimations": {"process_id": process_id, "source": "Manual", "received_at": "2026-09-23T12:00:00Z", "content": "Conteúdo de teste"},
        "appointments": {"client_id": client_id, "process_id": process_id, "title": "Reunião de teste", "appointment_date": "2026-10-02"},
        "financial-entries": {"client_id": client_id, "process_id": process_id, "entry_date": "2026-10-02", "entry_type": "revenue", "description": "Honorários de teste", "amount": "10.50", "status": "forecast"},
    }[resource]


RELATIONS = [
    ("processes", "patch", "client_id"), ("deadlines", "patch", "process_id"),
    ("intimations", "patch", "process_id"),
    *[(resource, method, field) for resource in ("appointments", "financial-entries")
      for method in ("post", "patch") for field in ("client_id", "process_id")],
]


@pytest.mark.parametrize("resource,method,field", RELATIONS)
@pytest.mark.parametrize("invalid_kind", ["foreign", "missing", "deleted"])
def test_invalid_relation_is_rejected_without_persisting(api, resource, method, field, invalid_kind):
    headers = identity()
    client_id, process_id = client_and_process(api, headers)
    body = payload(resource, client_id, process_id)
    row_id = create(api, headers, resource, body) if method == "patch" else None
    before = api.get(f"/v1/{resource}", headers=headers).json()
    if invalid_kind == "missing":
        invalid_id = str(uuid4())
    else:
        other_headers = identity() if invalid_kind == "foreign" else headers
        other_client = create(api, other_headers, "clients", {"name": "Outro registro"})
        invalid_id = other_client
        target = "clients"
        if field == "process_id":
            invalid_id = create(api, other_headers, "processes", {"client_id": other_client, "number": "00003-test"})
            target = "processes"
        if invalid_kind == "deleted":
            assert api.delete(f"/v1/{target}/{invalid_id}", headers=other_headers).status_code == 204
    body[field] = invalid_id
    suffix = f"/{row_id}" if row_id else ""
    response = getattr(api, method)(f"/v1/{resource}{suffix}", headers=headers, json=body)
    assert response.status_code == 404, response.text
    assert response.json()["detail"] == "Registro não encontrado."
    after = api.get(f"/v1/{resource}", headers=headers).json()
    # Foreign/deleted relation setup never creates another row in these resources.
    assert after == before


@pytest.mark.parametrize("resource", ["appointments", "financial-entries"])
def test_client_must_match_process_on_create_and_update(api, resource):
    headers = identity()
    client_id, process_id = client_and_process(api, headers)
    other_client = create(api, headers, "clients", {"name": "Cliente diferente"})
    body = payload(resource, client_id, process_id)
    row_id = create(api, headers, resource, body)
    body["client_id"] = other_client
    assert api.post(f"/v1/{resource}", headers=headers, json=body).status_code == 422
    assert api.patch(f"/v1/{resource}/{row_id}", headers=headers, json=body).status_code == 422
    assert api.get(f"/v1/{resource}", headers=headers).json()[0]["client_id"] == client_id


@pytest.mark.parametrize("amount", ["0", "-0.01", "1.001", "1000000000000", "NaN", "Infinity"])
def test_financial_amount_is_validated(api, amount):
    headers = identity()
    body = payload("financial-entries", None, None)
    body["amount"] = amount
    assert api.post("/v1/financial-entries", headers=headers, json=body).status_code == 422
    assert api.get("/v1/financial-entries", headers=headers).json() == []


@pytest.mark.parametrize("entry_type,status,expected", [
    ("revenue", "recebido", 201), ("expense", "pago", 201),
    ("expense", "received", 422), ("revenue", "paid", 422),
])
def test_financial_settlement_matches_type(api, entry_type, status, expected):
    headers = identity()
    body = {**payload("financial-entries", None, None), "entry_type": entry_type, "status": status}
    response = api.post("/v1/financial-entries", headers=headers, json=body)
    assert response.status_code == expected, response.text
    if expected == 201:
        saved = api.get("/v1/financial-entries", headers=headers).json()[0]
        assert saved["status"] == ("received" if entry_type == "revenue" else "paid")
        assert Decimal(str(saved["amount"])) == Decimal("10.50")


def launch_body():
    return {
        "movement": {"occurred_on": "2026-09-23", "movement_type": "intimacao", "description": "Ciência e revisão humana"},
        "deadline": {"title": "Manifestação", "due_date": "2026-10-02"},
        "appointment": {"title": "Revisar manifestação", "appointment_date": "2026-10-01", "appointment_time": "10:00"},
    }


def intimation_setup(api):
    headers = identity()
    client_id, process_id = client_and_process(api, headers)
    intimation_id = create(api, headers, "intimations", payload("intimations", client_id, process_id))
    return headers, client_id, process_id, intimation_id


def bootstrap(api, headers):
    response = api.get("/v1/frontend/bootstrap", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_launch_is_atomic_persistent_idempotent_and_linked(api):
    headers, client_id, process_id, intimation_id = intimation_setup(api)
    path = f"/v1/intimations/{intimation_id}/launch"
    response = api.post(path, headers=headers, json=launch_body())
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["already_launched"] is False
    assert result["status"] == "concluded"
    replay = api.post(path, headers=headers, json=launch_body())
    assert replay.status_code == 200, replay.text
    assert replay.json() == {**result, "already_launched": True}
    records = bootstrap(api, headers)
    for key in ("processMovements", "deadlines", "appointments"):
        assert len(records[key]) == 1
        assert records[key][0]["processId"] == process_id
    assert records["appointments"][0]["clientId"] == client_id
    assert records["processMovements"][0]["intimationId"] == intimation_id
    assert records["intimations"][0]["status"] == "concluida"
    assert records["clients"][0]["status"] == "ativo"
    assert records["processes"][0]["status"] == "ativo"
    changed = launch_body()
    changed["movement"]["description"] = "Outro lançamento"
    assert api.post(path, headers=headers, json=changed).status_code == 409
    assert len(bootstrap(api, headers)["processMovements"]) == 1


def test_launch_without_optional_records_and_foreign_access(api):
    headers, _, _, intimation_id = intimation_setup(api)
    path = f"/v1/intimations/{intimation_id}/launch"
    body = {"movement": launch_body()["movement"]}
    assert api.post(path, headers=identity(), json=body).status_code == 404
    result = api.post(path, headers=headers, json=body)
    assert result.status_code == 201
    assert result.json()["deadline_id"] is None
    assert result.json()["appointment_id"] is None
    assert bootstrap(api, headers)["deadlines"] == []


def test_launch_rolls_back_every_record_when_audit_fails(api, monkeypatch):
    headers, _, _, intimation_id = intimation_setup(api)
    original = legal_launch._record

    async def reject_final_audit(session, principal, request, action, resource, resource_id, cid):
        if action == "intimation.launch":
            raise RuntimeError("Injected test failure before commit")
        await original(session, principal, request, action, resource, resource_id, cid)

    monkeypatch.setattr(legal_launch, "_record", reject_final_audit)
    result = api.post(f"/v1/intimations/{intimation_id}/launch", headers=headers, json=launch_body())
    assert result.status_code == 500
    records = bootstrap(api, headers)
    assert records["processMovements"] == records["deadlines"] == records["appointments"] == []
    assert records["intimations"][0]["status"] == "triagem"
    monkeypatch.setattr(legal_launch, "_record", original)
    assert api.post(f"/v1/intimations/{intimation_id}/launch", headers=headers, json=launch_body()).status_code == 201


def test_concurrent_launch_does_not_duplicate_records(api):
    headers, _, _, intimation_id = intimation_setup(api)
    def launch(_):
        return api.post(f"/v1/intimations/{intimation_id}/launch", headers=headers, json=launch_body())
    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(launch, range(2)))
    assert sorted(response.status_code for response in responses) == [200, 201], [r.text for r in responses]
    records = bootstrap(api, headers)
    assert len(records["processMovements"]) == len(records["deadlines"]) == len(records["appointments"]) == 1


def test_launch_link_survives_movement_edit(api):
    headers, _, _, intimation_id = intimation_setup(api)
    path = f"/v1/intimations/{intimation_id}/launch"
    created = api.post(path, headers=headers, json=launch_body()).json()
    body = {**launch_body()["movement"], "description": "Texto revisado", "payload": {"attachments": []}}
    assert api.patch(f"/v1/process-movements/{created['movement_id']}", headers=headers, json=body).status_code == 200
    assert bootstrap(api, headers)["processMovements"][0]["intimationId"] == intimation_id
    assert api.post(path, headers=headers, json=launch_body()).status_code == 200


@pytest.mark.parametrize("invalid", ["missing_process", "deleted_process", "completed", "invalid_date"])
def test_launch_validates_state_and_optional_input_before_writing(api, invalid):
    headers, client_id, process_id, intimation_id = intimation_setup(api)
    body = deepcopy(launch_body())
    if invalid == "deleted_process":
        assert api.delete(f"/v1/processes/{process_id}", headers=headers).status_code == 204
    elif invalid == "invalid_date":
        body["deadline"]["due_date"] = "2026-02-30"
    else:
        update_body = payload("intimations", client_id, process_id)
        update_body.update({"process_id": None} if invalid == "missing_process" else {"status": "concluded"})
        assert api.patch(f"/v1/intimations/{intimation_id}", headers=headers, json=update_body).status_code == 200
    result = api.post(f"/v1/intimations/{intimation_id}/launch", headers=headers, json=body)
    assert result.status_code in {404, 409, 422}, result.text
    records = bootstrap(api, headers)
    assert records["processMovements"] == records["deadlines"] == records["appointments"] == []


def test_process_detail_filters_movement_tenant_even_for_legacy_bad_links(api):
    headers = identity()
    _, process_id = client_and_process(api, headers)
    from uuid import UUID

    async def inject_legacy_inconsistency():
        async with SessionLocal() as session:
            from datetime import date
            session.add(ProcessMovement(tenant_id=uuid4(), process_id=UUID(process_id),
                                        occurred_on=date(2026, 9, 23), movement_type="manual",
                                        description="Registro externo que não deve aparecer", source="manual"))
            await session.commit()

    api.portal.call(inject_legacy_inconsistency)
    result = api.get(f"/v1/processes/{process_id}", headers=headers)
    assert result.status_code == 200
    assert result.json()["movements"] == []


@pytest.mark.parametrize("resource,field,value", [
    ("deadlines", "title", "Prazo corrigido"),
    ("appointments", "status", "completed"),
    ("intimations", "content", "Texto corrigido"),
    ("financial-entries", "status", "overdue"),
])
def test_updates_return_and_persist_database_generated_timestamps(api, resource, field, value):
    headers = identity()
    client_id, process_id = client_and_process(api, headers)
    body = payload(resource, client_id, process_id)
    row_id = create(api, headers, resource, body)
    updated = api.patch(f"/v1/{resource}/{row_id}", headers=headers, json={**body, field: value})
    assert updated.status_code == 200, updated.text
    assert updated.json()[field] == value
    assert updated.json()["updated_at"]
    saved = api.get(f"/v1/{resource}", headers=headers).json()[0]
    assert saved[field] == value
    if resource == "appointments":
        assert bootstrap(api, headers)["appointments"][0]["status"] == "concluido"
    if resource == "financial-entries":
        assert bootstrap(api, headers)["financial"][0]["status"] == "vencido"


def legal_workspace(api, headers):
    client_id, process_id = client_and_process(api, headers)
    bodies = {resource: payload(resource, client_id, process_id) for resource in
              ("processes", "deadlines", "appointments", "intimations", "financial-entries")}
    bodies["clients"] = {"name": "Registro isolado", "kind": "PF"}
    ids = {"clients": client_id, "processes": process_id}
    for resource in ("deadlines", "appointments", "intimations", "financial-entries"):
        ids[resource] = create(api, headers, resource, bodies[resource])
    movement = {**launch_body()["movement"], "source": "manual"}
    movement_id = create(api, headers, f"processes/{process_id}/movements", movement)
    return bodies, ids, movement, movement_id


def legal_records(api, headers):
    records = bootstrap(api, headers)
    return {key: records[key] for key in ("clients", "processes", "deadlines", "appointments", "intimations", "financial", "processMovements")}


@pytest.mark.parametrize("role", ["auditor", "unknown", ""])
def test_legal_mutations_deny_read_only_and_unrecognized_roles_without_changes(api, role):
    admin = identity()
    bodies, ids, movement, movement_id = legal_workspace(api, admin)
    restricted = {**admin, "X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Roles": role}
    before = legal_records(api, admin)
    requests = []
    for resource, body in bodies.items():
        requests.extend([
            ("post", f"/v1/{resource}", body),
            ("patch", f"/v1/{resource}/{ids[resource]}", body),
            ("delete", f"/v1/{resource}/{ids[resource]}", None),
        ])
    requests.extend([
        ("post", f"/v1/processes/{ids['processes']}/movements", movement),
        ("patch", f"/v1/process-movements/{movement_id}", movement),
        ("delete", f"/v1/process-movements/{movement_id}", None),
        ("post", f"/v1/intimations/{ids['intimations']}/launch", launch_body()),
        ("post", "/v1/imports/frontend-demo", {"payload": {"clients": [{"id": "import-denied", "name": "Não importar"}]}}),
    ])
    for method, path, body in requests:
        result = api.request(method, path, headers=restricted, json=body)
        assert result.status_code == 403, (role, method, path, result.text)
        assert result.json()["detail"]["policy_code"] == "RBAC_ROLE_DENIED"
    assert legal_records(api, admin) == before


@pytest.mark.parametrize("role,expected", [("auditor", 200), ("unknown", 403), ("", 403)])
def test_legal_reads_and_bootstrap_restrict_unrecognized_roles(api, role, expected):
    admin = identity()
    _, ids, _, _ = legal_workspace(api, admin)
    reader = {**admin, "X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Roles": role}
    paths = [f"/v1/{resource}" for resource in ids]
    paths.extend([f"/v1/clients/{ids['clients']}", f"/v1/processes/{ids['processes']}", "/v1/frontend/bootstrap"])
    for path in paths:
        result = api.get(path, headers=reader)
        assert result.status_code == expected, (role, path, result.text)


@pytest.mark.parametrize("role", ["administrator", "manager", "lawyer", "investigator", "analyst"])
def test_authorized_legal_roles_can_mutate_launch_and_import(api, role):
    headers = {**identity(), "X-Semperfi-Roles": role}
    client_id, process_id = client_and_process(api, headers)
    response = api.patch(f"/v1/clients/{client_id}", headers=headers, json={"name": "Nome corrigido"})
    assert response.status_code == 200, response.text
    assert api.get(f"/v1/clients/{client_id}", headers=headers).json()["name"] == "Nome corrigido"
    intimation_id = create(api, headers, "intimations", payload("intimations", client_id, process_id))
    response = api.post(f"/v1/intimations/{intimation_id}/launch", headers=headers, json=launch_body())
    assert response.status_code == 201, response.text
    imported = api.post("/v1/imports/frontend-demo", headers=headers, json={"payload": {"clients": [{"id": "import-test", "name": "Importação autorizada"}]}})
    assert imported.status_code == 202, imported.text
    assert imported.json()["clients"] == 1
    disposable = create(api, headers, "clients", {"name": "Registro a excluir"})
    assert api.delete(f"/v1/clients/{disposable}", headers=headers).status_code == 204
    assert api.get(f"/v1/clients/{disposable}", headers=headers).status_code == 404
