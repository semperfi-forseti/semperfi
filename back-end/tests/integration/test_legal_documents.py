from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import Evidence


@pytest.fixture
def api():
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def identity(role="administrator"):
    return {"X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Tenant-Id": str(uuid4()), "X-Semperfi-Roles": role}


def target(api, headers, kind):
    response = api.post("/v1/clients", headers=headers, json={"name": "Cliente isolado"})
    assert response.status_code == 201, response.text
    client_id = response.json()["id"]
    if kind == "clients":
        return client_id
    response = api.post("/v1/processes", headers=headers, json={"client_id": client_id, "number": "processo isolado"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def evidence(api, headers):
    async def create():
        async with SessionLocal() as session:
            item = Evidence(tenant_id=UUID(headers["X-Semperfi-Tenant-Id"]), original_filename="Diligências.txt",
                            mime_type="text/plain", size_bytes=7, sha256="a"*64, source_type="manual",
                            collection_method="upload", collected_at=datetime.now(UTC), storage_bucket="private-bucket",
                            storage_key="private-key", metadata_json={"private": "not disclosed"})
            session.add(item)
            await session.flush()
            item_id = str(item.id)
            await session.commit()
            return item_id
    return api.portal.call(create)


@pytest.mark.parametrize("kind", ["clients", "processes"])
def test_attach_reload_detach_keeps_original_and_blocks_parent_deletion(api, kind):
    headers = identity()
    item_id = target(api, headers, kind)
    evidence_id = evidence(api, headers)
    path = f"/v1/{kind}/{item_id}/documents"
    body = {"evidence_id": evidence_id, "label": "Instrumento de mandato"}
    response = api.post(path, headers=headers, json=body)
    assert response.status_code == 200, response.text
    link = response.json()
    assert api.post(path, headers=headers, json=body).json()["id"] == link["id"]
    rows = api.get(path, headers=headers).json()
    assert len(rows) == 1
    assert rows[0]["filename"] == "Diligências.txt"
    assert rows[0]["validation_status"] == "pending"
    assert not {"storage_key", "storage_bucket", "metadata", "sha256"}.intersection(rows[0])
    assert api.delete(f"/v1/{kind}/{item_id}", headers=headers).status_code == 409
    assert api.delete(f"{path}/{link['id']}", headers=headers).status_code == 204
    assert api.get(path, headers=headers).json() == []
    assert api.delete(f"/v1/{kind}/{item_id}", headers=headers).status_code == 204
    assert api.get(path, headers=headers).status_code == 404
    original = api.get("/v1/evidences", headers=headers).json()
    assert any(row["id"] == evidence_id for row in original)


@pytest.mark.parametrize("kind", ["clients", "processes"])
def test_documents_enforce_tenant_and_readonly_permissions(api, kind):
    owner, stranger = identity(), identity()
    item_id = target(api, owner, kind)
    evidence_id = evidence(api, owner)
    foreign_evidence = evidence(api, stranger)
    path = f"/v1/{kind}/{item_id}/documents"
    body = {"evidence_id": evidence_id}
    assert api.get(path, headers=stranger).status_code == 404
    assert api.post(path, headers=stranger, json=body).status_code == 404
    assert api.post(path, headers=owner, json={"evidence_id": foreign_evidence}).status_code == 404
    auditor = {**owner, "X-Semperfi-Roles": "auditor"}
    assert api.get(path, headers=auditor).status_code == 200
    assert api.post(path, headers=auditor, json=body).status_code == 403
    link = api.post(path, headers=owner, json=body).json()
    assert api.delete(f"{path}/{link['id']}", headers=auditor).status_code == 403
    assert api.delete(f"{path}/{link['id']}", headers=stranger).status_code == 404
    assert api.post(path, headers=owner, json={**body, "label": "x"*181}).status_code == 422
    other_id = target(api, owner, kind)
    assert api.delete(f"/v1/{kind}/{other_id}/documents/{link['id']}", headers=owner).status_code == 404
