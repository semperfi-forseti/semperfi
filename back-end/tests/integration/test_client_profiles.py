import json
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.v1 import client_profiles
from app.core.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import AuditEvent
from app.models.client_profile import ClientProfile
from app.security.auth import FieldCipher


def identity(roles="administrator,lawyer"):
    return {"X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Tenant-Id": str(uuid4()), "X-Semperfi-Roles": roles}


@pytest.fixture
def api():
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def create_client(api, headers):
    result = api.post("/v1/clients", headers=headers, json={"name": "Cliente de teste isolado"})
    assert result.status_code == 201, result.text
    return result.json()["id"]


def sample_profile():
    return {
        "biography": "Informação fornecida pelo cliente, com acentuação e ⚖️.",
        "profession": "Advogado", "birthDate": "1990-01-02", "nationality": "Brasileira", "maritalStatus": "Informado pelo cliente",
        "professionalHistory": [{"cargo": "Consultor", "organizacao": "Organização de teste", "periodo": "2020–2022", "descricao": "Atividade relatada", "fonte": "Declaração do cliente"}],
        "politicalHistory": [{"ano": 2020, "cargo": "Candidatura informada", "partido": "Declarado", "situacao": "Não conferido", "fonte": "Documento fornecido"}],
        "publicOffices": [{"cargo": "Cargo declarado", "orgao": "Órgão informado", "periodo": "2020", "fonte": "Documento fornecido"}],
        "assets": [{"tipo": "Imóvel", "descricao": "Descrição declarada", "valor": "10000.50", "ano": 2020, "fonte": "Declaração fornecida"}],
        "companies": [{"nome": "Empresa de teste", "cnpj": "12.345.678/0001-90", "qualificacao": "Vínculo informado", "fonte": "Documento fornecido"}],
        "newsMentions": [{"titulo": "Notícia fornecida", "url": "https://example.org/noticia?q=teste", "fonte": "Fonte indicada", "data": "2026-01-01", "snippet": "Resumo revisado"}],
        "notes": "Notas internas do perfil.",
        "sources": [{"titulo": "Documento de origem", "url": "https://example.org/origem", "observacoes": "Revisão manual"}],
    }


def test_empty_profile_save_reload_and_replace_with_version(api):
    headers = identity()
    client_id = create_client(api, headers)
    path = f"/v1/clients/{client_id}/profile"
    empty = api.get(path, headers=headers)
    assert empty.status_code == 200, empty.text
    assert empty.headers["cache-control"] == "no-store"
    assert empty.json()["version"] == 0
    assert empty.json()["profile"]["biography"] == ""
    assert all(empty.json()["profile"][key] == [] for key in ("assets", "companies", "professionalHistory", "sources"))
    saved = api.put(path, headers=headers, json={"version": 0, "profile": sample_profile()})
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1
    assert saved.headers["cache-control"] == "no-store"
    loaded = api.get(path, headers=headers)
    assert loaded.json() == saved.json()
    assert loaded.json()["profile"]["companies"][0]["cnpj"] == "12345678000190"
    assert loaded.json()["profile"]["assets"][0]["valor"] == "10000.50"
    saved_again = api.put(path, headers=headers, json={"version": 1, "profile": {"biography": "Perfil revisado"}})
    assert saved_again.status_code == 200, saved_again.text
    assert saved_again.json()["version"] == 2
    reloaded = api.get(path, headers=headers).json()
    assert reloaded["profile"]["biography"] == "Perfil revisado"
    assert reloaded["profile"]["assets"] == []


@pytest.mark.parametrize("stale_version", [0, 1, 3])
def test_conflicting_write_preserves_saved_profile(api, stale_version):
    headers = identity()
    client_id = create_client(api, headers)
    path = f"/v1/clients/{client_id}/profile"
    for version in (0, 1):
        assert api.put(path, headers=headers, json={"version": version, "profile": {"biography": "Original"}}).status_code == 200
    conflict = api.put(path, headers=headers, json={"version": stale_version, "profile": {"biography": "Sobrescrita inválida"}})
    assert conflict.status_code == 409, conflict.text
    loaded = api.get(path, headers=headers).json()
    assert loaded["version"] == 2
    assert loaded["profile"]["biography"] == "Original"


def test_update_nonexistent_profile_needs_version_zero(api):
    headers = identity()
    path = f"/v1/clients/{create_client(api, headers)}/profile"
    assert api.put(path, headers=headers, json={"version": 1, "profile": {}}).status_code == 409
    assert api.get(path, headers=headers).json()["version"] == 0


@pytest.mark.parametrize("kind", ["foreign", "missing", "deleted"])
def test_profile_rejects_inactive_or_foreign_client(api, kind):
    headers = identity()
    owner = identity() if kind == "foreign" else headers
    client_id = str(uuid4()) if kind == "missing" else create_client(api, owner)
    if kind == "deleted":
        assert api.delete(f"/v1/clients/{client_id}", headers=headers).status_code == 204
    path = f"/v1/clients/{client_id}/profile"
    assert api.get(path, headers=headers).status_code == 404
    assert api.put(path, headers=headers, json={"version": 0, "profile": sample_profile()}).status_code == 404


@pytest.mark.parametrize("role,read_status,write_status", [
    ("auditor", 200, 403), ("lawyer", 200, 200), ("investigator", 200, 200),
    ("analyst", 200, 200), ("manager", 200, 200), ("unknown", 403, 403),
])
def test_profile_permissions_follow_legal_workspace(api, role, read_status, write_status):
    owner = identity()
    client_id = create_client(api, owner)
    headers = {**owner, "X-Semperfi-Roles": role}
    path = f"/v1/clients/{client_id}/profile"
    assert api.get(path, headers=headers).status_code == read_status
    assert api.put(path, headers=headers, json={"version": 0, "profile": {"biography": "Revisão"}}).status_code == write_status


@pytest.mark.parametrize("profile", [
    {"biography": "a" * 20001}, {"unknown": "campo"},
    {"birthDate": "1799-12-31"}, {"birthDate": (datetime.now(UTC).date() + timedelta(days=1)).isoformat()},
    {"sources": [{"titulo": "Origem", "url": "javascript:alert(1)"}]},
    {"sources": [{"titulo": "Origem", "url": "https://user:secret@example.org"}]},
    {"sources": [{"titulo": "Origem", "url": "https://example.org:bad"}]},
    {"sources": [{"titulo": "Origem", "url": "https://example.org/a\nb"}]},
    {"sources": [{"titulo": "Origem", "url": "https://example.org\\@example.net"}]},
    {"companies": [{"nome": "Empresa", "cnpj": "12"}]},
    {"companies": [{"nome": "Empresa", "cnpj": "1234567800019x"}]},
    {"politicalHistory": [{"ano": 2020, "cargo": ""}]},
    {"politicalHistory": [{"ano": 2020.5, "cargo": "Cargo"}]},
    {"assets": [{"tipo": "Bem", "valor": "NaN"}]},
    {"assets": [{"tipo": "Bem", "valor": "-1"}]},
    {"assets": [{"tipo": "Bem", "valor": "1.001"}]},
    {"sources": [{"titulo": "Fonte"}] * 101},
])
def test_invalid_profile_is_not_saved(api, profile):
    headers = identity()
    path = f"/v1/clients/{create_client(api, headers)}/profile"
    result = api.put(path, headers=headers, json={"version": 0, "profile": profile})
    assert result.status_code == 422, result.text
    assert api.get(path, headers=headers).json()["version"] == 0


def test_aggregate_payload_size_is_bounded(api):
    headers = identity()
    path = f"/v1/clients/{create_client(api, headers)}/profile"
    body = {"version": 0, "profile": {"sources": [{"titulo": "Fonte", "observacoes": "a" * 5000}] * 60}}
    result = api.put(path, headers=headers, json=body)
    assert result.status_code == 422, result.text
    assert api.get(path, headers=headers).json()["version"] == 0


def test_profile_is_encrypted_and_audit_has_no_sensitive_payload(api, monkeypatch):
    monkeypatch.setattr(get_settings(), "field_encryption_key", Fernet.generate_key().decode())
    test_cipher = FieldCipher()
    monkeypatch.setattr(client_profiles, "cipher", test_cipher)
    headers = identity()
    client_id = create_client(api, headers)
    path = f"/v1/clients/{client_id}/profile"
    body = sample_profile()
    assert api.put(path, headers=headers, json={"version": 0, "profile": body}).status_code == 200
    assert api.get(path, headers=headers).json()["profile"]["notes"] == body["notes"]

    async def inspect_saved():
        async with SessionLocal() as session:
            profile = await session.scalar(select(ClientProfile).where(ClientProfile.client_id == UUID(client_id)))
            events = list(await session.scalars(select(AuditEvent).where(AuditEvent.tenant_id == UUID(headers["X-Semperfi-Tenant-Id"]), AuditEvent.resource_type == "client_profile")))
            assert profile is not None
            assert not profile.profile_ciphertext.startswith("dev::")
            assert body["notes"] not in profile.profile_ciphertext
            assert json.loads(test_cipher.decrypt(profile.profile_ciphertext))["notes"] == body["notes"]
            assert {event.action for event in events} == {"client.profile.update", "client.profile.read"}
            for event in events:
                assert event.metadata_safe == {"version": 1}

    api.portal.call(inspect_saved)
