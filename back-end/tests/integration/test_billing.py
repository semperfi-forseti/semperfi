"""Sandbox billing contracts using an isolated database and mocked Asaas only."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.billing.catalog import PLANS
from app.billing.service import receive_webhook
from app.core.config import Settings, get_settings
from app.db import SessionLocal
from app.integrations import asaas
from app.main import app
from app.models import Tenant
from app.models.billing import BillingCheckout, BillingWebhookReceipt
from app.security import Principal
from app.security.sessions import session_store

TOKEN = "test-webhook-token-with-at-least-32-characters"
KEY = "$aact_hmlg_test_only_no_real_credential"


def sandbox_settings(**changes):
    return Settings(_env_file=None, asaas_sandbox_enabled=True,
                    asaas_sandbox_api_key=KEY, asaas_webhook_token=TOKEN,
                    asaas_checkout_return_url="https://app.example.test/index.html", **changes)


@pytest.fixture
def billing_client(monkeypatch):
    settings = get_settings()
    for name, value in {
        "asaas_sandbox_enabled": True, "asaas_sandbox_api_key": KEY,
        "asaas_webhook_token": TOKEN,
        "asaas_checkout_return_url": "https://app.example.test/index.html",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))
    session_store._memory.clear()
    # Every provider write must be explicitly mocked by the test exercising it.
    monkeypatch.setattr(asaas, "create_checkout", AsyncMock(side_effect=AssertionError("Unmocked Asaas request")))
    tenant_id = uuid4()
    with TestClient(app, headers={"X-Semperfi-Tenant-Id": str(tenant_id)}) as client:
        async def provision():
            async with SessionLocal() as session:
                session.add(Tenant(id=tenant_id, name="Billing test", slug=uuid4().hex))
                await session.commit()
        client.portal.call(provision)
        yield client
    session_store._memory.clear()


def create(billing_client, monkeypatch, *, plan="profissional", request_id=None):
    provider_id = str(uuid4())
    mocked = AsyncMock(return_value={"id": provider_id, "link": asaas.checkout_link(provider_id)})
    monkeypatch.setattr(asaas, "create_checkout", mocked)
    body = {"plan_key": plan, "request_id": str(request_id or uuid4())}
    response = billing_client.post("/v1/billing/checkouts", json=body)
    assert response.status_code == 201, response.text
    return response.json(), body, mocked


def event(item, *, kind="CHECKOUT_PAID", amount=None, event_id=None):
    return {"id": event_id or f"evt_{uuid4().hex}", "event": kind,
            "checkout": {
                "id": item["checkout_url"].split("id=")[1],
                "externalReference": item["id"], "status": "PAID" if kind == "CHECKOUT_PAID" else "ACTIVE",
                "chargeTypes": ["RECURRENT"], "subscription": {"cycle": "MONTHLY"},
                "items": [{"value": amount if amount is not None else item["amount_cents"] / 100, "quantity": 1}],
            }}


def webhook(client, payload):
    return client.post("/v1/billing/webhooks/asaas", json=payload, headers={"asaas-access-token": TOKEN})


def test_catalog_prices_match_displayed_frontend_and_no_secret_is_exposed(billing_client):
    displayed = json.loads((Path(__file__).resolve().parents[3] / "front-end/data/commercial.json").read_text(encoding="utf-8"))
    expected = {plan["key"]: int(Decimal(str(plan["price"])) * 100)
                for plan in displayed["plans"] if plan["price"] is not None}
    response = billing_client.get("/v1/billing/catalog")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert {plan["key"]: plan["amount_cents"] for plan in response.json()["plans"]} == expected
    status = billing_client.get("/v1/billing/status")
    assert status.json()["can_checkout"] is True
    assert status.json()["production_entitlements"] is False
    assert KEY not in response.text + status.text
    assert TOKEN not in response.text + status.text


def test_checkout_idempotency_and_single_active_subscription(billing_client, monkeypatch):
    item, body, provider = create(billing_client, monkeypatch)
    assert item["amount_cents"] == 15990
    assert item["sandbox_only"] is True
    repeated = billing_client.post("/v1/billing/checkouts", json=body)
    assert repeated.json()["id"] == item["id"]
    assert provider.await_count == 1
    assert billing_client.post("/v1/billing/checkouts", json={**body, "plan_key": "lite"}).status_code == 409
    assert billing_client.post("/v1/billing/checkouts", json={**body, "request_id": str(uuid4())}).status_code == 409
    assert billing_client.get("/v1/billing/status").json()["can_checkout"] is False


@pytest.mark.parametrize("extra", [{"amount_cents": 1}, {"checkout_url": "https://evil.test"}, {"plan_key": "corporate"}])
def test_client_cannot_override_server_price_or_plan(billing_client, extra):
    response = billing_client.post("/v1/billing/checkouts", json={"plan_key": "lite", "request_id": str(uuid4()), **extra})
    assert response.status_code == 422


def test_checkout_requires_authenticated_administrator_and_recent_mfa(billing_client, monkeypatch):
    body = {"plan_key": "lite", "request_id": str(uuid4())}
    assert billing_client.post("/v1/billing/checkouts", json=body, headers={"X-Semperfi-Roles": "lawyer"}).status_code == 403
    principal = Principal(uuid4(), UUID(billing_client.headers["X-Semperfi-Tenant-Id"]),
                          "test@example.test", "Billing test", frozenset(["administrator"]),
                          datetime.now(UTC) - timedelta(days=1), "development-header")
    sid = billing_client.portal.call(session_store.create, principal)
    billing_client.cookies.set(get_settings().session_cookie_name, sid)
    response = billing_client.post("/v1/billing/checkouts", json=body)
    assert response.status_code == 403
    assert response.json()["detail"]["policy_code"] == "MFA_REAUTH_REQUIRED"
    billing_client.cookies.clear()
    monkeypatch.setattr(get_settings(), "auth_mode", "password")
    assert billing_client.post("/v1/billing/checkouts", json=body).status_code == 401
    assert billing_client.get("/v1/billing/status").status_code == 401


def test_tenant_isolation_for_history_detail_and_request_id(billing_client, monkeypatch):
    item, body, _ = create(billing_client, monkeypatch)
    other_headers = {"X-Semperfi-Tenant-Id": str(uuid4())}
    assert billing_client.get(f"/v1/billing/checkouts/{item['id']}", headers=other_headers).status_code == 404
    assert billing_client.get("/v1/billing/status", headers=other_headers).json()["checkouts"] == []
    other_provider = str(uuid4())
    monkeypatch.setattr(asaas, "create_checkout", AsyncMock(return_value={"id": other_provider, "link": asaas.checkout_link(other_provider)}))
    other = billing_client.post("/v1/billing/checkouts", headers=other_headers, json=body)
    assert other.status_code == 201
    assert other.json()["id"] != item["id"]


@pytest.mark.parametrize("uncertain,status,can_retry", [(True, "unknown", False), (False, "failed", True)])
def test_provider_failure_does_not_duplicate_uncertain_purchase(billing_client, monkeypatch, uncertain, status, can_retry):
    provider = AsyncMock(side_effect=asaas.AsaasUnavailable(uncertain=uncertain))
    monkeypatch.setattr(asaas, "create_checkout", provider)
    body = {"plan_key": "lite", "request_id": str(uuid4())}
    response = billing_client.post("/v1/billing/checkouts", json=body)
    assert response.status_code == 503
    snapshot = billing_client.get("/v1/billing/status").json()
    assert snapshot["checkouts"][0]["status"] == status
    assert snapshot["can_checkout"] is can_retry
    assert KEY not in response.text
    repeated = billing_client.post("/v1/billing/checkouts", json=body)
    assert repeated.status_code == (409 if uncertain else 201)
    assert provider.await_count == 1


def test_authenticated_payment_webhook_is_idempotent_and_callback_is_not_payment(billing_client, monkeypatch):
    item, _, _ = create(billing_client, monkeypatch)
    detail = f"/v1/billing/checkouts/{item['id']}"
    assert billing_client.get(detail, params={"billing_return": "success"}).json()["status"] == "open"
    payload = event(item)
    assert billing_client.post("/v1/billing/webhooks/asaas", json=payload).status_code == 401
    first = webhook(billing_client, payload)
    assert first.status_code == 200
    assert first.json()["duplicate"] is False
    assert webhook(billing_client, payload).json()["duplicate"] is True
    async def receipt_count():
        async with SessionLocal() as session:
            return await session.scalar(select(func.count()).select_from(BillingWebhookReceipt).where(
                BillingWebhookReceipt.checkout_id == UUID(item["id"])))
    assert billing_client.portal.call(receipt_count) == 1
    assert billing_client.get(detail).json()["status"] == "paid"
    assert billing_client.get(detail).json()["checkout_url"] is None
    status = billing_client.get("/v1/billing/status").json()
    assert status["subscription"]["status"] == "sandbox_paid"
    assert status["production_entitlements"] is False
    altered = {**payload, "unexpected": "altered content"}
    assert webhook(billing_client, altered).status_code == 409


@pytest.mark.parametrize("patch", [
    {"items": [{"value": 1, "quantity": 1}]},
    {"items": [{"value": -159.9, "quantity": -1}]},
    {"items": [{"value": "NaN", "quantity": 1}]},
    {"items": [{"value": 319.8, "quantity": 0.5}]},
    {"items": None}, {"chargeTypes": None}, {"chargeTypes": "RECURRENT"},
    {"subscription": {"cycle": "YEARLY"}}, {"status": "ACTIVE"},
    {"externalReference": str(uuid4())},
])
def test_invalid_payment_does_not_mark_as_paid(billing_client, monkeypatch, patch):
    item, _, _ = create(billing_client, monkeypatch)
    payload = event(item)
    payload["checkout"].update(patch)
    assert webhook(billing_client, payload).status_code in {409, 422}
    assert billing_client.get(f"/v1/billing/checkouts/{item['id']}").json()["status"] == "open"


@pytest.mark.parametrize("ending", ["CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"])
def test_delayed_created_event_does_not_reopen_terminal_checkout(billing_client, monkeypatch, ending):
    item, _, _ = create(billing_client, monkeypatch)
    assert webhook(billing_client, event(item, kind=ending)).status_code == 200
    assert webhook(billing_client, event(item, kind="CHECKOUT_CREATED")).status_code == 200
    status = billing_client.get("/v1/billing/status").json()
    assert status["checkouts"][0]["status"] == ending.removeprefix("CHECKOUT_").lower()
    assert status["can_checkout"] is True


def test_delayed_events_do_not_undo_payment(billing_client, monkeypatch):
    item, _, _ = create(billing_client, monkeypatch)
    assert webhook(billing_client, event(item)).status_code == 200
    for kind in ("CHECKOUT_CREATED", "CHECKOUT_EXPIRED", "CHECKOUT_CANCELED"):
        assert webhook(billing_client, event(item, kind=kind)).status_code == 200
    assert billing_client.get(f"/v1/billing/checkouts/{item['id']}").json()["status"] == "paid"


@pytest.mark.parametrize("timeout_after_webhook", [False, True])
def test_webhook_arriving_during_provider_call_survives_stale_orm_session(billing_client, monkeypatch, timeout_after_webhook):
    provider_id = str(uuid4())

    async def provider(_settings, payload):
        payment = {"id": f"evt_{uuid4().hex}", "event": "CHECKOUT_PAID", "checkout": {
            "id": provider_id, "externalReference": payload["externalReference"], "status": "PAID",
            "items": payload["items"], "chargeTypes": payload["chargeTypes"], "subscription": payload["subscription"],
        }}
        async with SessionLocal() as session:
            await receive_webhook(session, payment)
        if timeout_after_webhook:
            raise asaas.AsaasUnavailable()
        return {"id": provider_id, "link": asaas.checkout_link(provider_id)}

    monkeypatch.setattr(asaas, "create_checkout", provider)
    response = billing_client.post("/v1/billing/checkouts", json={"plan_key": "lite", "request_id": str(uuid4())})
    assert response.status_code == (503 if timeout_after_webhook else 201)
    snapshot = billing_client.get("/v1/billing/status").json()
    assert snapshot["checkouts"][0]["status"] == "paid"
    assert snapshot["subscription"]["plan_key"] == "lite"


def test_unmapped_webhook_requests_redelivery_and_oversized_body_is_rejected(billing_client):
    payload = {"id": "evt_unknown", "event": "CHECKOUT_CREATED", "checkout": {"id": str(uuid4())}}
    assert webhook(billing_client, payload).status_code == 409
    response = billing_client.post("/v1/billing/webhooks/asaas", content=b"x" * 65537,
                                   headers={"asaas-access-token": TOKEN})
    assert response.status_code == 413
    assert billing_client.post("/v1/billing/webhooks/asaas", content=b"{invalid",
                               headers={"asaas-access-token": TOKEN}).status_code == 422
    assert webhook(billing_client, {"id": "evt_other", "event": "PAYMENT_CREATED"}).json()["ignored"] is True


def test_active_subscription_outside_history_page_still_blocks_checkout(billing_client, monkeypatch):
    item, _, _ = create(billing_client, monkeypatch)
    assert webhook(billing_client, event(item)).status_code == 200

    async def later_history():
        async with SessionLocal() as session:
            for _ in range(21):
                session.add(BillingCheckout(tenant_id=UUID(billing_client.headers["X-Semperfi-Tenant-Id"]),
                    requested_by=uuid4(), request_id=uuid4(), plan_key="lite", amount_cents=8990,
                    status="failed", created_at=datetime.now(UTC) + timedelta(hours=1)))
            await session.commit()

    billing_client.portal.call(later_history)
    state = billing_client.get("/v1/billing/status").json()
    assert len(state["checkouts"]) == 20
    assert all(row["status"] == "failed" for row in state["checkouts"])
    assert state["can_checkout"] is False
    assert state["subscription"]["plan_key"] == "profissional"


@pytest.mark.parametrize("field,value", [
    ("asaas_sandbox_enabled", False), ("asaas_sandbox_api_key", "$aact_prod_forbidden"),
    ("asaas_webhook_token", "short"), ("asaas_checkout_return_url", "http://app.example.test"),
    ("asaas_checkout_return_url", "https://user:password@example.test"),
    ("asaas_checkout_return_url", "https://[invalid"),
    ("asaas_checkout_return_url", "https://example.test:wrong"),
])
def test_invalid_configuration_fails_closed(billing_client, monkeypatch, field, value):
    monkeypatch.setattr(get_settings(), field, value)
    assert billing_client.get("/v1/billing/status").json()["enabled"] is False
    response = billing_client.post("/v1/billing/checkouts", json={"plan_key": "lite", "request_id": str(uuid4())})
    assert response.status_code == 503


@pytest.mark.parametrize("link", ["https://asaas.com/checkoutSession/show?id=test", "https://evil.test/test",
                                 "https://sandbox.asaas.com/checkoutSession/show?id=other",
                                 "https://user@sandbox.asaas.com/checkoutSession/show?id=test"])
def test_external_or_production_checkout_link_is_rejected(link):
    with pytest.raises(asaas.AsaasUnavailable):
        asaas.checkout_link("test", link)


@pytest.mark.asyncio
async def test_provider_request_uses_sandbox_only_and_server_owned_payload(monkeypatch):
    settings = sandbox_settings()
    provider_id = str(uuid4())
    seen = []

    def respond(request):
        seen.append(request)
        return httpx.Response(200, json={"id": provider_id})

    factory = httpx.AsyncClient
    monkeypatch.setattr(asaas.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs))
    checkout_id = str(uuid4())
    payload = asaas.build_payload(settings=settings, checkout_id=checkout_id, plan=PLANS["lite"])
    result = await asaas.create_checkout(settings, payload)
    assert str(seen[0].url) == "https://api-sandbox.asaas.com/v3/checkouts"
    assert seen[0].headers["access_token"] == KEY
    sent = json.loads(seen[0].content)
    assert sent["items"][0]["value"] == 89.9
    assert sent["chargeTypes"] == ["RECURRENT"]
    assert sent["subscription"]["cycle"] == "MONTHLY"
    assert sent["externalReference"] == checkout_id
    assert "billing_return=success" in sent["callback"]["successUrl"]
    assert result["link"].startswith("https://sandbox.asaas.com/")


@pytest.mark.asyncio
@pytest.mark.parametrize("status,uncertain", [(400, False), (401, False), (403, False), (422, False), (429, True), (500, True), (302, True)])
async def test_provider_errors_are_sanitized_without_automatic_retry(monkeypatch, status, uncertain):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, text=f"Untrusted provider detail containing {KEY}")

    factory = httpx.AsyncClient
    monkeypatch.setattr(asaas.httpx, "AsyncClient", lambda **kwargs: factory(transport=httpx.MockTransport(respond), **kwargs))
    with pytest.raises(asaas.AsaasUnavailable) as failure:
        await asaas.create_checkout(sandbox_settings(), {})
    assert failure.value.uncertain is uncertain
    assert KEY not in str(failure.value)
    assert len(calls) == 1
