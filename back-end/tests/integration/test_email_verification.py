"""Exercise verification through HTTP; delivery is captured, never sent."""
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
from app.models import AuthenticationChallenge, Membership, Tenant, User
from app.security import Principal, challenges
from app.security.rate_limit import rate_limiter
from app.security.sessions import session_store


@pytest.fixture
def client(monkeypatch, verification_outbox):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_mode", "password")
    monkeypatch.setattr(settings, "allow_self_registration", True)
    monkeypatch.setattr(settings, "allow_development_identity_headers", False)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=True))
    session_store._memory.clear()
    with TestClient(app) as browser:
        browser.outbox = verification_outbox
        yield browser
    session_store._memory.clear()


@pytest.fixture
def registration():
    return {"account_type": "PF", "display_name": "Advogada de Teste",
            "email": f"otp-{uuid4().hex}@example.com", "password": "Senha de teste segura 123!"}


def start(client, registration):
    response = client.post("/v1/auth/register", json=registration)
    assert response.status_code == 202, response.text
    return response


def verify(client, code=None):
    return client.post("/v1/auth/verify", json={"code": code or client.outbox[-1]["code"]})


def create_account(client, registration):
    start(client, registration)
    response = verify(client)
    assert response.status_code == 200, response.text
    return client.get("/v1/me").json()


def login(client, registration, account_type=None):
    credentials = {key: registration[key] for key in ("email", "password")}
    if account_type:
        credentials["account_type"] = account_type
    return client.post("/v1/auth/login", json=credentials)


async def snapshot(email):
    async with SessionLocal() as session:
        user = await session.scalar(select(User).where(User.email == email))
        challenge = await session.scalar(select(AuthenticationChallenge).where(AuthenticationChallenge.email == email))
        membership = await session.scalar(select(Membership).where(Membership.user_id == user.id)) if user else None
        tenant = await session.get(Tenant, membership.tenant_id) if membership else None
        return user, challenge, tenant


async def mutate_challenge(email, **values):
    async with SessionLocal() as session:
        row = await session.scalar(select(AuthenticationChallenge).where(AuthenticationChallenge.email == email))
        for key, value in values.items():
            setattr(row, key, value)
        await session.commit()


@pytest.mark.parametrize("account_type", ["PF", "PJ"])
def test_registration_needs_email_proof_before_identity_exists(client, registration, account_type):
    registration["account_type"] = account_type
    if account_type == "PJ":
        registration["organization_name"] = "Escritório de Teste"
    pending = start(client, registration)
    payload = pending.json()
    assert payload["authenticated"] is False and payload["verification_required"] is True
    assert payload["pending_verification"]["purpose"] == "register"
    assert payload["pending_verification"]["account_type"] == account_type
    assert payload["pending_verification"]["channel"] == "email"
    assert registration["email"] not in pending.text
    assert client.outbox[-1]["code"] not in pending.text
    assert registration["password"] not in pending.text
    assert "HttpOnly" in pending.headers["set-cookie"]
    assert not client.cookies.get(get_settings().session_cookie_name)
    assert client.get("/v1/me").status_code == 401
    assert client.post("/v1/auth/session").status_code == 401
    user, challenge, tenant = client.portal.call(snapshot, registration["email"])
    assert user is None and tenant is None
    assert challenge.password_hash.startswith("scrypt$")
    assert challenge.code_hash != client.outbox[-1]["code"]
    assert challenge.token_hash != client.cookies.get(get_settings().challenge_cookie_name)
    status = client.get("/v1/auth/status").json()
    assert status["authenticated"] is False
    assert status["pending_verification"]["masked_destination"] == payload["pending_verification"]["masked_destination"]
    assert 0 < status["pending_verification"]["expires_in"] <= 600

    response = verify(client)
    assert response.status_code == 200, response.text
    assert response.json()["authenticated"] is True
    me = client.get("/v1/me").json()
    assert me["account_type"] == account_type
    assert me["mfa_verified_at"] is not None
    user, challenge, tenant = client.portal.call(snapshot, registration["email"])
    assert user is not None and tenant.account_type == account_type
    assert tenant.name == registration.get("organization_name", registration["display_name"])
    assert challenge.password_hash is None
    assert challenge.consumed_at is not None
    assert client.get("/v1/auth/status").json()["pending_verification"] is None


def test_pj_registration_requires_organization_and_pf_requires_explicit_type(client, registration):
    response = client.post("/v1/auth/register", json={**registration, "account_type": "PJ"})
    assert response.status_code == 422
    response = client.post("/v1/auth/register", json={key: value for key, value in registration.items() if key != "account_type"})
    assert response.status_code == 422
    assert not client.outbox


def test_every_password_login_requires_new_browser_bound_single_use_code(client, registration):
    create_account(client, registration)
    client.post("/v1/auth/logout")
    pending = login(client, registration)
    assert pending.status_code == 200
    assert pending.json()["authenticated"] is False
    assert pending.json()["pending_verification"]["purpose"] == "login"
    assert client.get("/v1/me").status_code == 401
    code = client.outbox[-1]["code"]
    cookie = client.cookies.get(get_settings().challenge_cookie_name)
    with TestClient(app) as other_browser:
        assert other_browser.post("/v1/auth/verify", json={"code": code}).status_code == 400
    assert verify(client, code).status_code == 200
    client.post("/v1/auth/logout")
    client.cookies.set(get_settings().challenge_cookie_name, cookie)
    assert verify(client, code).status_code == 400
    assert client.get("/v1/me").status_code == 401
    assert login(client, registration).json()["verification_required"] is True


def test_five_wrong_attempts_exhaust_challenge_without_account(client, registration):
    start(client, registration)
    code = client.outbox[-1]["code"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        assert verify(client, wrong).status_code == 400
    assert verify(client, code).status_code == 400
    assert client.post("/v1/auth/resend").status_code == 400
    assert client.get("/v1/auth/status").json()["pending_verification"] is None
    user, challenge, _ = client.portal.call(snapshot, registration["email"])
    assert user is None and challenge.attempts == 5
    assert challenge.password_hash is None


def test_expired_challenge_cannot_create_identity(client, registration):
    start(client, registration)
    client.portal.call(mutate_challenge, registration["email"], **{}) if False else None
    async def expire():
        await mutate_challenge(registration["email"], expires_at=int(time.time()) - 1)
    client.portal.call(expire)
    assert verify(client).status_code == 400
    assert client.get("/v1/auth/status").json()["pending_verification"] is None
    user, challenge, _ = client.portal.call(snapshot, registration["email"])
    assert user is None and challenge.password_hash is None


def test_resend_cooldown_and_old_code_invalidation(client, registration):
    start(client, registration)
    old_code = client.outbox[-1]["code"]
    too_soon = client.post("/v1/auth/resend")
    assert too_soon.status_code == 429
    assert int(too_soon.headers["retry-after"]) > 0
    assert len(client.outbox) == 1
    async def enable_resend():
        await mutate_challenge(registration["email"], resend_at=0)
    client.portal.call(enable_resend)
    response = client.post("/v1/auth/resend")
    assert response.status_code == 200, response.text
    new_code = client.outbox[-1]["code"]
    assert new_code != old_code
    assert verify(client, old_code).status_code == 400
    _, challenge, _ = client.portal.call(snapshot, registration["email"])
    assert challenge.attempts == 1
    assert verify(client, new_code).status_code == 200


def test_concurrent_resend_sends_only_one_new_code(client, registration):
    start(client, registration)
    async def enable_resend():
        await mutate_challenge(registration["email"], resend_at=0)
    client.portal.call(enable_resend)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post("/v1/auth/resend"), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 429]
    assert len(client.outbox) == 2
    assert verify(client).status_code == 200


def test_concurrent_verification_consumes_code_only_once(client, registration):
    start(client, registration)
    code = client.outbox[-1]["code"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: verify(client, code), range(2)))
    assert sorted(response.status_code for response in responses) == [200, 400]
    assert len(session_store._memory) == 1


def test_cancel_invalidates_code_and_allows_fresh_start(client, registration):
    start(client, registration)
    old_code = client.outbox[-1]["code"]
    old_cookie = client.cookies.get(get_settings().challenge_cookie_name)
    assert client.post("/v1/auth/cancel").status_code == 204
    assert client.get("/v1/auth/status").json()["pending_verification"] is None
    client.cookies.set(get_settings().challenge_cookie_name, old_cookie)
    assert verify(client, old_code).status_code == 400
    client.cookies.clear()
    start(client, registration)
    assert verify(client).status_code == 200


def test_delivery_failure_creates_no_account_or_session(client, registration, monkeypatch):
    monkeypatch.setattr(challenges, "send_verification_code", AsyncMock(side_effect=DeliveryUnavailable("unavailable")))
    response = client.post("/v1/auth/register", json=registration)
    assert response.status_code == 503
    assert "não foi liberado" in response.json()["detail"]
    assert not client.cookies.get(get_settings().challenge_cookie_name)
    user, challenge, tenant = client.portal.call(snapshot, registration["email"])
    assert user is challenge is tenant is None
    assert not session_store._memory


def test_missing_smtp_config_is_fail_closed(client, registration, monkeypatch):
    from app.integrations.verification_email import send_verification_code
    monkeypatch.setattr(get_settings(), "smtp_host", None)
    monkeypatch.setattr(challenges, "send_verification_code", send_verification_code)
    response = client.post("/v1/auth/register", json=registration)
    assert response.status_code == 503
    assert client.portal.call(snapshot, registration["email"])[0] is None
    assert client.get("/v1/auth/status").json()["password_enabled"] is True


@pytest.mark.parametrize("environment", ["staging", "production"])
def test_hosted_verification_requires_stable_signing_key(client, registration, monkeypatch, environment):
    monkeypatch.setattr(get_settings(), "environment", environment)
    monkeypatch.setattr(get_settings(), "auth_otp_signing_key", None)
    response = client.post("/v1/auth/register", json=registration)
    assert response.status_code == 503
    assert not client.outbox
    assert client.portal.call(snapshot, registration["email"])[0] is None


def test_failed_resend_invalidates_old_code_and_can_be_retried(client, registration, monkeypatch):
    start(client, registration)
    old_code = client.outbox[-1]["code"]
    delivery = challenges.send_verification_code
    async def enable_resend():
        await mutate_challenge(registration["email"], resend_at=0)
    client.portal.call(enable_resend)
    monkeypatch.setattr(challenges, "send_verification_code", AsyncMock(side_effect=DeliveryUnavailable("unavailable")))
    assert client.post("/v1/auth/resend").status_code == 503
    assert verify(client, old_code).status_code == 400
    assert client.portal.call(snapshot, registration["email"])[0] is None
    client.portal.call(enable_resend)
    monkeypatch.setattr(challenges, "send_verification_code", delivery)
    assert client.post("/v1/auth/resend").status_code == 200
    assert verify(client).status_code == 200


def test_session_failure_rolls_back_signup_and_keeps_code_retryable(client, registration, monkeypatch):
    start(client, registration)
    create_session = session_store.create
    monkeypatch.setattr(session_store, "create", AsyncMock(side_effect=RuntimeError("Redis unavailable")))
    assert verify(client).status_code == 503
    user, challenge, _ = client.portal.call(snapshot, registration["email"])
    assert user is None and challenge.consumed_at is None
    assert not session_store._memory
    monkeypatch.setattr(session_store, "create", create_session)
    assert verify(client).status_code == 200


def test_suspension_between_password_and_code_prevents_session(client, registration):
    create_account(client, registration)
    client.post("/v1/auth/logout")
    assert login(client, registration).status_code == 200
    async def suspend():
        async with SessionLocal() as session:
            user = await session.scalar(select(User).where(User.email == registration["email"]))
            user.is_active = False
            await session.commit()
    client.portal.call(suspend)
    assert verify(client).status_code == 401
    assert not session_store._memory


def test_account_type_filter_and_unclassified_legacy_accounts(client, registration):
    registration.update(account_type="PJ", organization_name="Escritório")
    me = create_account(client, registration)
    client.post("/v1/auth/logout")
    assert login(client, registration, "PF").status_code == 401
    async def unclassify():
        from uuid import UUID
        async with SessionLocal() as session:
            tenant = await session.get(Tenant, UUID(me["tenant_id"]))
            tenant.account_type = None
            await session.commit()
    client.portal.call(unclassify)
    response = login(client, registration, "PF")
    assert response.status_code == 200
    assert response.json()["pending_verification"]["account_type"] is None
    assert verify(client).status_code == 200
    assert client.get("/v1/me").json()["account_type"] is None


def test_old_password_session_without_code_proof_is_rejected(client, registration):
    create_account(client, registration)
    client.post("/v1/auth/logout")
    user, _, tenant = client.portal.call(snapshot, registration["email"])
    old_principal = Principal(user.id, tenant.id, user.email, user.display_name,
                              frozenset({"administrator"}), None, "password")
    cookie = client.portal.call(session_store.create, old_principal)
    client.cookies.set(get_settings().session_cookie_name, cookie)
    assert client.get("/v1/auth/status").json()["authenticated"] is False
    assert client.get("/v1/me").status_code == 401


@pytest.mark.parametrize("code", ["12345", "1234567", "abcdef", "１２３４５６"])
def test_invalid_code_shape_is_sanitized(client, code):
    response = verify(client, code)
    assert response.status_code == 422
    assert code not in response.text
    assert "seis dígitos" in response.json()["detail"]
