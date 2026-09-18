from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api.v1 import auth_routes
from app.core.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import Membership, Tenant, User
from app.security.sessions import session_store


@pytest.fixture
def browser_client(monkeypatch):
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))
    session_store._memory.clear()
    with TestClient(app) as client:
        yield client
    session_store._memory.clear()


def test_status_does_not_sign_in_and_logout_revokes_cookie(browser_client):
    status = browser_client.get("/v1/auth/status")
    assert status.json()["authenticated"] is False
    assert status.headers["cache-control"] == "no-store"
    assert status.json()["development_enabled"] is True
    login = browser_client.post("/v1/auth/session")
    assert login.status_code == 200
    assert "HttpOnly" in login.headers["set-cookie"]
    cookie = browser_client.cookies.get(get_settings().session_cookie_name)
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is True
    assert browser_client.post("/v1/auth/logout").status_code == 204
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is False
    browser_client.cookies.set(get_settings().session_cookie_name, cookie)
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is False


def test_production_has_no_development_entry(browser_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "environment", "production")
    assert browser_client.get("/v1/auth/status").json()["development_enabled"] is False
    assert browser_client.post("/v1/auth/session").status_code == 401
    assert browser_client.get("/v1/me").status_code == 401


def test_expired_cookie_does_not_authenticate(browser_client):
    browser_client.post("/v1/auth/session")
    cookie = browser_client.cookies.get(get_settings().session_cookie_name)
    _, payload = session_store._memory[cookie]
    session_store._memory[cookie] = (0, payload)
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is False
    assert cookie not in session_store._memory


def test_static_entry_and_production_assets(browser_client, monkeypatch):
    root = browser_client.get("/", follow_redirects=False)
    assert root.headers["location"] == "/ui/frontend/index.html"
    monkeypatch.setattr(get_settings(), "environment", "production")
    for file in (
        "index.html", "login.html", "assets/css/interface.css", "assets/js/auth.js", "data/sources.json",
        "assets/css/commercial.css", "assets/js/commercial.js", "data/commercial.json",
        "assets/css/public.css", "assets/js/public.js",
    ):
        response = browser_client.get(f"/ui/frontend/{file}")
        assert response.status_code == 200
        assert "default-src 'self'" in response.headers["content-security-policy"]
    assert 'charset="UTF-8"' in browser_client.get("/ui/frontend/login.html").text


def test_oidc_callback_requires_state_from_same_browser(browser_client, monkeypatch):
    monkeypatch.setattr(get_settings(), "auth_mode", "oidc")
    monkeypatch.setattr(auth_routes.oidc_bff, "authorization_url", AsyncMock(return_value="https://identity.example.test/authorize"))
    login = browser_client.get("/v1/auth/oidc/login", follow_redirects=False)
    assert login.status_code == 307
    state = browser_client.cookies.get("semperfi_oidc_state")
    assert state in auth_routes._oidc_states
    browser_client.cookies.clear()
    callback = browser_client.get("/v1/auth/oidc/callback", params={"code": "test-code", "state": state})
    assert callback.status_code == 400
    auth_routes._oidc_states.pop(state, None)


@pytest.mark.parametrize("matching_subject, active_tenant, expected", [(False, True, 403), (True, False, 403), (True, True, 302)])
def test_oidc_uses_provisioned_subject_and_active_tenant(browser_client, monkeypatch, matching_subject, active_tenant, expected):
    subject = uuid4().hex
    email = f"oidc-{uuid4().hex}@example.com"

    async def provision():
        async with SessionLocal() as session:
            tenant = Tenant(name="OIDC test", slug=uuid4().hex, is_active=active_tenant)
            user = User(email=email, display_name="OIDC test", oidc_subject=subject)
            session.add_all([tenant, user])
            await session.flush()
            session.add(Membership(tenant_id=tenant.id, user_id=user.id, role="administrator", permissions=[]))
            await session.commit()

    browser_client.portal.call(provision)
    monkeypatch.setattr(get_settings(), "auth_mode", "oidc")
    monkeypatch.setattr(auth_routes.oidc_bff, "authorization_url", AsyncMock(return_value="https://identity.example.test/authorize"))
    monkeypatch.setattr(auth_routes.oidc_bff, "exchange_code", AsyncMock(return_value={
        "sub": subject if matching_subject else "different-subject", "email": email, "email_verified": False,
    }))
    browser_client.get("/v1/auth/oidc/login", follow_redirects=False)
    state = browser_client.cookies.get("semperfi_oidc_state")
    callback = browser_client.get("/v1/auth/oidc/callback", params={"code": "test-code", "state": state}, follow_redirects=False)
    assert callback.status_code == expected
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is (expected == 302)


def test_development_cookie_is_not_accepted_after_switching_auth_mode(browser_client, monkeypatch):
    assert browser_client.post("/v1/auth/session").status_code == 200
    monkeypatch.setattr(get_settings(), "auth_mode", "password")
    assert browser_client.get("/v1/auth/status").json()["authenticated"] is False
    assert browser_client.get("/v1/me").status_code == 401
