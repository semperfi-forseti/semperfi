"""Password authentication contracts using only the disposable test database."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Membership, Tenant, User
from app.security.rate_limit import rate_limiter
from app.security.sessions import session_store


@pytest.fixture
def password_client(monkeypatch, verification_outbox):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_mode", "password")
    monkeypatch.setattr(settings, "allow_self_registration", True)
    monkeypatch.setattr(settings, "allow_development_identity_headers", False)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=True))
    session_store._memory.clear()
    rate_limiter._fallback.clear()
    with TestClient(app) as client:
        client.verification_outbox = verification_outbox
        yield client
    session_store._memory.clear()
    rate_limiter._fallback.clear()


@pytest.fixture
def registration():
    return {
        "account_type": "PJ",
        "display_name": "Pessoa de teste",
        "email": f"password-{uuid4().hex}@example.com",
        "password": "Senha de teste segura 123!",
        "organization_name": "Organização de teste",
    }


def credentials(registration):
    return {key: registration[key] for key in ("email", "password")}


def register_verified(client, registration):
    pending = client.post("/v1/auth/register", json=registration)
    assert pending.status_code == 202, pending.text
    assert pending.json()["authenticated"] is False
    return client.post("/v1/auth/verify", json={"code": client.verification_outbox[-1]["code"]})


def login_verified(client, body, origin=""):
    pending = client.post(f"{origin}/v1/auth/login", json=body)
    assert pending.status_code == 200, pending.text
    assert pending.json()["authenticated"] is False
    return client.post(f"{origin}/v1/auth/verify", json={"code": client.verification_outbox[-1]["code"]})


async def read_account(email):
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.email == email.lower()))
        assert user is not None
        membership = await session.scalar(
            select(Membership).where(Membership.user_id == user.id)
        )
        assert membership is not None
        tenant = await session.get(Tenant, membership.tenant_id)
        assert tenant is not None
        return user, membership, tenant


def test_password_status_does_not_authenticate(password_client):
    response = password_client.get("/v1/auth/status")
    assert response.status_code == 200
    assert response.json()["authenticated"] is False
    assert response.json()["password_enabled"] is True
    assert response.json()["registration_enabled"] is True
    assert response.json()["development_enabled"] is False
    assert response.headers["cache-control"] == "no-store"
    assert password_client.get("/v1/me").status_code == 401
    assert not session_store._memory


def test_register_login_and_logout_revoke_session(password_client, registration):
    response = register_verified(password_client, registration)
    assert response.status_code == 200, response.text
    assert response.json()["authenticated"] is True
    assert response.json()["auth_mode"] == "password"
    assert isinstance(response.json()["message"], str)
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]

    user, membership, tenant = password_client.portal.call(read_account, registration["email"])
    assert user.password_hash
    assert user.password_hash != registration["password"]
    assert registration["password"] not in user.password_hash
    assert user.display_name == registration["display_name"]
    assert membership.role == "administrator"
    assert membership.is_active and tenant.is_active and user.is_active
    assert tenant.name == registration["organization_name"]
    me = password_client.get("/v1/me")
    assert me.status_code == 200
    assert me.json()["email"] == registration["email"]
    assert me.json()["tenant_id"] == str(tenant.id)

    cookie_name = get_settings().session_cookie_name
    registration_cookie = password_client.cookies.get(cookie_name)
    assert password_client.post("/v1/auth/logout").status_code == 204
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False
    password_client.cookies.set(cookie_name, registration_cookie)
    assert password_client.get("/v1/me").status_code == 401
    password_client.cookies.clear()

    login = login_verified(password_client, credentials(registration))
    assert login.status_code == 200, login.text
    assert login.json()["authenticated"] is True
    assert login.json()["auth_mode"] == "password"
    assert "HttpOnly" in login.headers["set-cookie"]
    assert password_client.cookies.get(cookie_name) != registration_cookie
    assert password_client.get("/v1/auth/status").json()["authenticated"] is True
    assert password_client.post("/v1/auth/logout").status_code == 204
    assert password_client.get("/v1/me").status_code == 401


def test_email_is_case_insensitive_and_duplicate_is_rejected(password_client, registration):
    assert register_verified(password_client, registration).status_code == 200
    password_client.post("/v1/auth/logout")
    mixed_case = {**registration, "email": registration["email"].upper()}
    duplicate = password_client.post("/v1/auth/register", json=mixed_case)
    assert duplicate.status_code == 409
    login = login_verified(password_client, credentials(mixed_case))
    assert login.status_code == 200
    assert password_client.get("/v1/me").json()["email"] == registration["email"]


def test_invalid_credentials_do_not_reveal_whether_email_exists(password_client, registration):
    assert register_verified(password_client, registration).status_code == 200
    password_client.post("/v1/auth/logout")
    wrong_password = password_client.post(
        "/v1/auth/login", json={**credentials(registration), "password": "Uma outra senha inválida!"}
    )
    missing_account = password_client.post(
        "/v1/auth/login",
        json={**credentials(registration), "email": f"missing-{uuid4().hex}@example.com"},
    )
    assert wrong_password.status_code == missing_account.status_code == 401
    assert wrong_password.json() == missing_account.json()
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False


@pytest.mark.parametrize("password", ["", "12345678901", "x" * 129])
def test_registration_enforces_password_length(password_client, registration, password):
    response = password_client.post(
        "/v1/auth/register", json={**registration, "password": password}
    )
    assert response.status_code == 422
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False


@pytest.mark.parametrize("endpoint", ["register", "login"])
def test_validation_errors_never_echo_passwords(password_client, registration, endpoint):
    secret = "Sensitive!"
    body = registration if endpoint == "register" else credentials(registration)
    response = password_client.post(f"/v1/auth/{endpoint}", json={**body, "password": secret})
    assert response.status_code == 422
    assert secret not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"]
    assert all("input" not in error and "ctx" not in error for error in response.json()["detail"])


def test_registration_can_be_disabled_without_disabling_login(password_client, registration, monkeypatch):
    assert register_verified(password_client, registration).status_code == 200
    password_client.post("/v1/auth/logout")
    monkeypatch.setattr(get_settings(), "allow_self_registration", False)
    status = password_client.get("/v1/auth/status").json()
    assert status["password_enabled"] is True
    assert status["registration_enabled"] is False
    assert password_client.post("/v1/auth/register", json=registration).status_code == 403
    assert login_verified(password_client, credentials(registration)).status_code == 200


def test_password_endpoints_reject_other_auth_modes(password_client, registration, monkeypatch):
    monkeypatch.setattr(get_settings(), "auth_mode", "oidc")
    status = password_client.get("/v1/auth/status").json()
    assert status["password_enabled"] is False
    assert status["registration_enabled"] is False
    assert password_client.post("/v1/auth/register", json=registration).status_code == 403
    assert password_client.post("/v1/auth/login", json=credentials(registration)).status_code == 403


def test_password_endpoints_enforce_rate_limit(password_client, registration, monkeypatch):
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=False))
    assert password_client.post("/v1/auth/register", json=registration).status_code == 429
    assert password_client.post("/v1/auth/login", json=credentials(registration)).status_code == 429
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False


def test_inactive_tenant_cannot_log_in(password_client, registration):
    assert register_verified(password_client, registration).status_code == 200
    password_client.post("/v1/auth/logout")

    async def deactivate_tenant():
        _, _, tenant = await read_account(registration["email"])
        async with SessionLocal() as session:
            persisted_tenant = await session.get(Tenant, tenant.id)
            persisted_tenant.is_active = False
            await session.commit()

    password_client.portal.call(deactivate_tenant)
    response = password_client.post("/v1/auth/login", json=credentials(registration))
    assert response.status_code == 401
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False


@pytest.mark.parametrize("model", [User, Membership, Tenant], ids=["user", "membership", "tenant"])
def test_suspension_invalidates_existing_session_immediately(password_client, registration, model):
    assert register_verified(password_client, registration).status_code == 200
    assert password_client.get("/v1/me").status_code == 200
    active_cookie = password_client.cookies.get(get_settings().session_cookie_name)

    async def suspend_account():
        account = await read_account(registration["email"])
        target = next(entity for entity in account if isinstance(entity, model))
        async with SessionLocal() as session:
            entity = await session.get(model, target.id)
            entity.is_active = False
            await session.commit()

    password_client.portal.call(suspend_account)
    assert password_client.cookies.get(get_settings().session_cookie_name) == active_cookie
    assert password_client.get("/v1/auth/status").json()["authenticated"] is False
    assert password_client.get("/v1/me").status_code == 401


def test_each_registration_gets_an_isolated_tenant(password_client, registration):
    assert register_verified(password_client, registration).status_code == 200
    first = password_client.get("/v1/me").json()
    password_client.post("/v1/auth/logout")
    second_registration = {**registration, "email": f"second-{uuid4().hex}@example.com"}
    assert register_verified(password_client, second_registration).status_code == 200
    second = password_client.get("/v1/me").json()
    assert first["id"] != second["id"]
    assert first["tenant_id"] != second["tenant_id"]


def test_production_login_sets_secure_cookie(password_client, registration, monkeypatch):
    assert register_verified(password_client, registration).status_code == 200
    password_client.post("/v1/auth/logout")
    stored_sessions = {}

    async def store_session(key, ttl, payload):
        assert ttl == get_settings().session_ttl_seconds
        stored_sessions[key] = payload

    redis = AsyncMock()
    redis.setex.side_effect = store_session
    redis.get.side_effect = lambda key: stored_sessions.get(key)
    redis.delete.side_effect = lambda key: stored_sessions.pop(key, None)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=redis))
    monkeypatch.setattr(get_settings(), "environment", "production")
    response = login_verified(password_client, credentials(registration), "https://testserver")
    assert response.status_code == 200, response.text
    assert "Secure" in response.headers["set-cookie"]
    assert "HttpOnly" in response.headers["set-cookie"]
    redis.setex.assert_awaited_once()
    assert len(stored_sessions) == 1
    assert registration["password"] not in next(iter(stored_sessions.values()))
    assert not session_store._memory
    assert password_client.get("https://testserver/v1/auth/status").json()["authenticated"] is True
    me = password_client.get("https://testserver/v1/me")
    assert me.status_code == 200
    assert me.json()["email"] == registration["email"]
    assert password_client.post("https://testserver/v1/auth/logout").status_code == 204
    assert not stored_sessions
    assert password_client.get("https://testserver/v1/auth/status").json()["authenticated"] is False
