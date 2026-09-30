"""Password recovery through HTTP with captured delivery and an isolated database."""
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.db import SessionLocal
from app.integrations.verification_email import DeliveryUnavailable
from app.main import app
from app.models import AuthenticationChallenge, Membership, User
from app.security import challenges
from app.security.passwords import hash_password, verify_password
from app.security.rate_limit import rate_limiter
from app.security.sessions import session_store

NEW_PASSWORD = "Uma nova frase de acesso 456!"


@pytest.fixture
def browser(monkeypatch, verification_outbox):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_mode", "password")
    monkeypatch.setattr(settings, "allow_self_registration", True)
    monkeypatch.setattr(settings, "allow_development_identity_headers", False)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=True))
    session_store._memory.clear()
    with TestClient(app) as client:
        client.outbox = verification_outbox
        yield client
    session_store._memory.clear()


@pytest.fixture
def account(browser):
    return provision(browser)


def provision(browser, account_type="PF"):
    body = {"email": f"recovery-{uuid4().hex}@example.com", "password": "Senha anterior segura 123!",
            "account_type": account_type, "display_name": "Pessoa de teste"}
    if account_type == "PJ":
        body["organization_name"] = "Organização de teste"
    assert browser.post("/v1/auth/register", json=body).status_code == 202
    response = browser.post("/v1/auth/verify", json={"code": browser.outbox[-1]["code"]})
    assert response.status_code == 200, response.text
    return body


def forgot(browser, email):
    return browser.post("/v1/auth/password/forgot", json={"email": email})


def reset(browser, code, password=NEW_PASSWORD):
    return browser.post("/v1/auth/password/reset", json={"code": code, "password": password})


async def change_challenge(email, changes):
    async with SessionLocal() as session:
        row = await session.scalar(select(AuthenticationChallenge).where(AuthenticationChallenge.email == email))
        for key, value in changes.items():
            setattr(row, key, value)
        await session.commit()


async def read_user(email):
    async with SessionLocal() as session:
        return await session.scalar(select(User).where(User.email == email))


async def change_user(email, changes):
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.email == email))
        for key, value in changes.items():
            setattr(user, key, value)
        await session.commit()


@pytest.mark.parametrize("account_type", ["PF", "PJ"])
def test_recovery_revokes_all_password_sessions_and_requires_new_login_mfa(browser, account_type):
    account = provision(browser, account_type)
    cookie_name = get_settings().session_cookie_name
    first_cookie = browser.cookies.get(cookie_name)
    browser.cookies.clear()  # Another browser, preserving the first session.
    credentials = {key: account[key] for key in ("email", "password")}
    assert browser.post("/v1/auth/login", json=credentials).status_code == 200
    assert browser.post("/v1/auth/verify", json={"code": browser.outbox[-1]["code"]}).status_code == 200
    second_cookie = browser.cookies.get(cookie_name)
    assert first_cookie != second_cookie
    browser.cookies.clear()

    response = forgot(browser, account["email"].upper())
    assert response.status_code == 202, response.text
    assert response.json()["pending_verification"]["purpose"] == "reset"
    assert response.json()["pending_verification"]["account_type"] is None
    assert browser.outbox[-1]["purpose"] == "reset"
    code = browser.outbox[-1]["code"]
    recovery_cookie = browser.cookies.get(get_settings().challenge_cookie_name)
    recovery_cookie_domain = next(cookie.domain for cookie in browser.cookies.jar
                                  if cookie.name == get_settings().challenge_cookie_name)
    assert account["email"] not in response.text and code not in response.text
    assert "HttpOnly" in response.headers["set-cookie"]
    assert browser.post("/v1/auth/verify", json={"code": code}).status_code == 400
    # The recovery code never grants an authenticated session directly.
    response = reset(browser, code)
    assert response.status_code == 200, response.text
    assert response.json()["password_reset"] is True
    assert response.json()["authenticated"] is False
    assert browser.get("/v1/auth/status").json()["authenticated"] is False
    for cookie in (first_cookie, second_cookie):
        assert browser.portal.call(session_store.get, cookie) is None
    # Restore the real cookie scope. A domainless test cookie would coexist with
    # the server's host cookie and incorrectly shadow the new login challenge.
    browser.cookies.set(get_settings().challenge_cookie_name, recovery_cookie,
                        domain=recovery_cookie_domain, path="/v1/auth")
    assert reset(browser, code).status_code == 400
    assert browser.post("/v1/auth/login", json=credentials).status_code == 401
    assert browser.post("/v1/auth/login", json={**credentials, "password": NEW_PASSWORD}).status_code == 200
    assert sum(cookie.name == get_settings().challenge_cookie_name for cookie in browser.cookies.jar) == 1
    assert browser.get("/v1/me").status_code == 401
    assert browser.post("/v1/auth/verify", json={"code": browser.outbox[-1]["code"]}).status_code == 200
    assert browser.get("/v1/me").status_code == 200


def test_unknown_account_has_same_response_and_no_email(browser, account):
    known = forgot(browser, account["email"])
    sent_count = len(browser.outbox)
    missing = forgot(browser, f"recovery-{uuid4().hex}@example.com")
    assert known.status_code == missing.status_code == 202
    assert len(browser.outbox) == sent_count
    left, right = known.json(), missing.json()
    assert left["message"] == right["message"]
    for value in (left, right):
        value["pending_verification"].pop("masked_destination")
        value["pending_verification"].pop("expires_in")
        value["pending_verification"].pop("resend_after")
    assert left == right
    assert reset(browser, "000000").status_code == 400


@pytest.mark.parametrize("eligible", [True, False])
@pytest.mark.parametrize("delivery_state", ["pending", "sent", "failed"])
def test_recovery_attempts_exhaust_for_known_and_unknown_accounts(browser, account, eligible, delivery_state):
    email = account["email"] if eligible else f"missing-{uuid4().hex}@example.com"
    assert forgot(browser, email).status_code == 202
    # Force a known incorrect code without relying on a random OTP collision.
    browser.portal.call(change_challenge, email, {"code_hash": "invalid-for-every-code", "delivery_state": delivery_state})
    for _ in range(get_settings().auth_otp_max_attempts):
        assert reset(browser, "123456").status_code == 400
    assert browser.get("/v1/auth/status").json()["pending_verification"] is None
    assert browser.post("/v1/auth/resend").status_code == 400
    assert verify_password(account["password"], browser.portal.call(read_user, account["email"]).password_hash)


def test_recovery_resend_cooldown_and_old_code_invalidation(browser, account):
    assert forgot(browser, account["email"]).status_code == 202
    first_code = browser.outbox[-1]["code"]
    assert browser.post("/v1/auth/resend").status_code == 429
    browser.portal.call(change_challenge, account["email"], {"resend_at": int(time.time()) - 1})
    assert browser.post("/v1/auth/resend").status_code == 200
    second_code = browser.outbox[-1]["code"]
    assert first_code != second_code
    assert reset(browser, first_code).status_code == 400
    assert reset(browser, second_code).status_code == 200


@pytest.mark.parametrize("state", ["expired", "canceled", "different-browser"])
def test_expired_canceled_or_unbound_recovery_cannot_change_password(browser, account, state):
    assert forgot(browser, account["email"]).status_code == 202
    code = browser.outbox[-1]["code"]
    if state == "expired":
        browser.portal.call(change_challenge, account["email"], {"expires_at": int(time.time()) - 1})
    elif state == "canceled":
        assert browser.post("/v1/auth/cancel").status_code == 204
    else:
        browser.cookies.clear()
    assert reset(browser, code).status_code == 400
    assert verify_password(account["password"], browser.portal.call(read_user, account["email"]).password_hash)


@pytest.mark.parametrize("password", ["", "short!123", "x" * 129])
def test_new_password_validation_does_not_echo_secret_or_consume_code(browser, account, password):
    assert forgot(browser, account["email"]).status_code == 202
    code = browser.outbox[-1]["code"]
    response = reset(browser, code, password)
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert all("input" not in item and "ctx" not in item for item in response.json()["detail"])
    if password:
        assert password not in response.text
    assert reset(browser, code).status_code == 200


@pytest.mark.parametrize("code", ["12345", "1234567", "abcdef", "１２３４５６"])
def test_recovery_validation_never_echoes_invalid_code_or_password(browser, account, code):
    assert forgot(browser, account["email"]).status_code == 202
    response = reset(browser, code)
    assert response.status_code == 422
    assert code not in response.text and NEW_PASSWORD not in response.text
    assert response.headers["cache-control"] == "no-store"
    assert all("input" not in item and "ctx" not in item for item in response.json()["detail"])


def test_registration_and_login_codes_cannot_reset_password(browser, account):
    browser.cookies.clear()
    assert browser.post("/v1/auth/login", json={key: account[key] for key in ("email", "password")}).status_code == 200
    code = browser.outbox[-1]["code"]
    assert reset(browser, code).status_code == 400
    assert browser.post("/v1/auth/verify", json={"code": code}).status_code == 200


def test_delivery_failure_keeps_generic_response_and_allows_resend(browser, account, monkeypatch):
    delivery = challenges.send_verification_code
    monkeypatch.setattr(challenges, "send_verification_code", AsyncMock(side_effect=DeliveryUnavailable("test-only")))
    response = forgot(browser, account["email"])
    assert response.status_code == 202
    assert response.json()["pending_verification"]["delivery_failed"] is False
    assert browser.get("/v1/auth/status").json()["pending_verification"]["delivery_failed"] is False
    browser.portal.call(change_challenge, account["email"], {"resend_at": int(time.time()) - 1})
    monkeypatch.setattr(challenges, "send_verification_code", delivery)
    assert browser.post("/v1/auth/resend").status_code == 200
    assert reset(browser, browser.outbox[-1]["code"]).status_code == 200


def test_recovery_respects_auth_mode_and_rate_limit(browser, account, monkeypatch):
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=False))
    assert forgot(browser, account["email"]).status_code == 429
    monkeypatch.setattr(get_settings(), "auth_mode", "oidc")
    assert forgot(browser, account["email"]).status_code == 403
    assert reset(browser, "123456").status_code == 403
    assert browser.get("/v1/auth/status").json()["password_recovery_enabled"] is False


def test_password_sessions_without_credential_version_require_login(browser, account):
    cookie = browser.cookies.get(get_settings().session_cookie_name)
    session_store._memory[cookie][1].pop("credential_version")
    assert browser.get("/v1/me").status_code == 401


@pytest.mark.parametrize("field", ["password_hash", "email", "is_active", "membership"])
def test_account_changes_after_request_invalidate_recovery_code(browser, account, field):
    assert forgot(browser, account["email"]).status_code == 202
    code = browser.outbox[-1]["code"]
    if field == "membership":
        async def suspend_membership():
            async with SessionLocal() as session:
                user = await session.scalar(select(User).where(User.email == account["email"]))
                membership = await session.scalar(select(Membership).where(Membership.user_id == user.id))
                membership.is_active = False
                await session.commit()
        browser.portal.call(suspend_membership)
    else:
        values = {"password_hash": hash_password("Alteração independente 789!"),
                  "email": f"changed-{uuid4().hex}@example.com", "is_active": False}
        browser.portal.call(change_user, account["email"], {field: values[field]})
    assert reset(browser, code).status_code == 400


def test_concurrent_reset_consumes_code_once(browser, account):
    assert forgot(browser, account["email"]).status_code == 202
    code = browser.outbox[-1]["code"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: reset(browser, code), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 400]
    user = browser.portal.call(read_user, account["email"])
    assert verify_password(NEW_PASSWORD, user.password_hash)


@pytest.mark.parametrize("condition", ["suspended", "institutional"])
def test_ineligible_accounts_do_not_send_recovery_email(browser, account, condition):
    changes = {"is_active": False} if condition == "suspended" else {"password_hash": None}
    browser.portal.call(change_user, account["email"], changes)
    sent_count = len(browser.outbox)
    response = forgot(browser, account["email"])
    assert response.status_code == 202
    assert len(browser.outbox) == sent_count
    assert response.json()["pending_verification"]["purpose"] == "reset"


def test_reading_password_session_does_not_rotate_or_upgrade_credentials(browser, account, monkeypatch):
    cookie_name = get_settings().session_cookie_name
    cookie = browser.cookies.get(cookie_name)
    create = AsyncMock(side_effect=AssertionError("An authenticated read must not mint a new password session."))
    monkeypatch.setattr(session_store, "create", create)
    response = browser.post("/v1/auth/session")
    assert response.status_code == 200
    assert response.json()["authenticated"] is True
    assert "set-cookie" not in response.headers
    assert browser.cookies.get(cookie_name) == cookie
    create.assert_not_awaited()
