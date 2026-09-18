"""Session revocation must report storage failures and permit a reliable retry."""

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError

from app.core.config import get_settings
from app.main import app
from app.security.rate_limit import rate_limiter
from app.security.sessions import session_store


@pytest.fixture
def hosted_session(monkeypatch, verification_outbox):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_mode", "password")
    monkeypatch.setattr(settings, "allow_self_registration", True)
    monkeypatch.setattr(settings, "allow_development_identity_headers", False)
    monkeypatch.setattr(rate_limiter, "allow", AsyncMock(return_value=True))
    records = {}
    redis = AsyncMock()
    redis.setex.side_effect = lambda key, ttl, payload: records.update({key: payload})
    redis.get.side_effect = records.get
    redis.delete.side_effect = lambda key: records.pop(key, None)
    connection = AsyncMock(return_value=redis)
    monkeypatch.setattr(session_store, "_redis", connection)
    credentials = {
        "email": f"session-{uuid4().hex}@example.com",
        "password": "Senha de teste segura 123!",
    }
    with TestClient(app, base_url="https://testserver") as client:
        client.verification_outbox = verification_outbox
        # Initialize the disposable SQLite schema before simulating production.
        monkeypatch.setattr(settings, "environment", "production")
        response = client.post("/v1/auth/register", json={
            **credentials,
            "account_type": "PJ",
            "display_name": "Pessoa de teste",
            "organization_name": "Organização de teste",
        })
        assert response.status_code == 202, response.text
        verified = client.post("/v1/auth/verify", json={"code": verification_outbox[-1]["code"]})
        assert verified.status_code == 200, verified.text
        yield client, redis, connection, records, credentials


def test_logout_unavailable_storage_preserves_cookie_until_retried(hosted_session):
    client, _, connection, records, _ = hosted_session
    cookie_name = get_settings().session_cookie_name
    original_cookie = client.cookies.get(cookie_name)
    connection.return_value = None

    failed = client.post("/v1/auth/logout")

    assert failed.status_code == 503
    assert "encerrar" in failed.json()["detail"]
    assert "set-cookie" not in failed.headers
    assert client.cookies.get(cookie_name) == original_cookie
    assert f"semperfi:session:{original_cookie}" in records

    # Recovery must allow retrying logout and must revoke replay of the old ID.
    connection.return_value = hosted_session[1]
    assert client.get("/v1/auth/status").json()["authenticated"] is True
    assert client.post("/v1/auth/logout").status_code == 204
    assert not records
    client.cookies.set(cookie_name, original_cookie)
    assert client.get("/v1/me").status_code == 401


def test_logout_failed_delete_closes_connection_and_preserves_cookie(hosted_session):
    client, redis, _, records, _ = hosted_session
    cookie_name = get_settings().session_cookie_name
    original_cookie = client.cookies.get(cookie_name)
    redis.aclose.reset_mock()
    redis.delete.side_effect = RedisConnectionError("Connection lost after ping")

    failed = client.post("/v1/auth/logout")

    assert failed.status_code == 503
    assert "set-cookie" not in failed.headers
    assert client.cookies.get(cookie_name) == original_cookie
    assert f"semperfi:session:{original_cookie}" in records
    redis.aclose.assert_awaited_once()


def test_rotation_failure_retains_old_cookie_and_cleans_pending_session(hosted_session):
    client, redis, connection, records, credentials = hosted_session
    cookie_name = get_settings().session_cookie_name
    original_cookie = client.cookies.get(cookie_name)
    assert client.post("/v1/auth/login", json=credentials).status_code == 200
    # New session write succeeds, old-session revocation fails, cleanup succeeds.
    connection.side_effect = [redis, None, redis]

    failed = client.post("/v1/auth/verify", json={"code": client.verification_outbox[-1]["code"]})

    assert failed.status_code == 503
    assert "set-cookie" not in failed.headers
    assert client.cookies.get(cookie_name) == original_cookie
    assert list(records) == [f"semperfi:session:{original_cookie}"]


@pytest.mark.parametrize("operation", ["setex", "get"])
def test_session_operation_failure_still_closes_connection(hosted_session, operation):
    client, redis, _, _, credentials = hosted_session
    redis.aclose.reset_mock()
    getattr(redis, operation).side_effect = RedisConnectionError("Connection lost after ping")

    if operation == "setex":
        assert client.post("/v1/auth/login", json=credentials).status_code == 200
        response = client.post("/v1/auth/verify", json={"code": client.verification_outbox[-1]["code"]})
        assert response.status_code == 503
    else:
        with pytest.raises(RedisConnectionError):
            client.get("/v1/auth/status")

    redis.aclose.assert_awaited_once()
