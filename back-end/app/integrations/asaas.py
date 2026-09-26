"""Hosted Asaas Sandbox checkout. No production host or payment-data collection.

Contract: https://docs.asaas.com/docs/checkout-com-assinatura-recorrente
Authentication: https://docs.asaas.com/docs/authentication
"""
from __future__ import annotations

import re
from datetime import UTC, datetime
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

import httpx

from app.core.config import Settings

SANDBOX_API = "https://api-sandbox.asaas.com/v3"
PROVIDER_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class AsaasUnavailable(Exception):
    def __init__(self, *, uncertain: bool = True):
        super().__init__("Checkout de homologação temporariamente indisponível.")
        self.uncertain = uncertain


def configuration_ready(settings: Settings) -> bool:
    if not settings.asaas_sandbox_enabled:
        return False
    key = settings.asaas_sandbox_api_key or ""
    token = settings.asaas_webhook_token or ""
    try:
        url = urlsplit(settings.asaas_checkout_return_url or "")
        valid_return = (url.scheme == "https" and bool(url.hostname) and not url.username
                        and not url.password and url.port in {None, 443})
    except ValueError:
        return False
    return bool(
        key.startswith("$aact_hmlg_") and len(key) > 20
        and len(token) >= 32 and not any(char.isspace() for char in token)
        and valid_return
    )


def checkout_link(provider_id: str, supplied: str | None = None) -> str:
    if not PROVIDER_ID.fullmatch(provider_id):
        raise AsaasUnavailable()
    if supplied:
        url = urlsplit(supplied)
        matching_path = url.path.rstrip("/") == f"/checkoutSession/show/{provider_id}"
        matching_query = url.path == "/checkoutSession/show" and parse_qs(url.query).get("id") == [provider_id]
        if (url.scheme != "https" or url.hostname != "sandbox.asaas.com" or url.port not in {None, 443}
                or url.username or url.password or not (matching_path or matching_query)):
            raise AsaasUnavailable()
        return supplied
    return f"https://sandbox.asaas.com/checkoutSession/show?id={provider_id}"


def build_payload(*, settings: Settings, checkout_id: str, plan: dict, now: datetime | None = None) -> dict:
    if not configuration_ready(settings):
        raise AsaasUnavailable(uncertain=False)
    current = now or datetime.now(UTC)
    base = urlsplit(settings.asaas_checkout_return_url or "")

    def callback(outcome: str) -> str:
        query = urlencode({"billing_checkout": checkout_id, "billing_return": outcome})
        return urlunsplit((base.scheme, base.netloc, base.path, query, base.fragment or "billing"))

    return {
        "billingTypes": ["CREDIT_CARD"],
        "chargeTypes": ["RECURRENT"],
        "minutesToExpire": 60,
        "externalReference": checkout_id,
        "callback": {"successUrl": callback("success"), "cancelUrl": callback("cancel"), "expiredUrl": callback("expired")},
        "items": [{"name": f"SEMPER-FI {plan['name']} — Sandbox", "description": "Homologação de assinatura mensal; sem cobrança real.",
                   "quantity": 1, "value": plan["amount_cents"] / 100}],
        "subscription": {"cycle": "MONTHLY", "nextDueDate": current.strftime("%Y-%m-%d %H:%M:%S")},
    }


async def create_checkout(settings: Settings, payload: dict) -> dict:
    if not configuration_ready(settings):
        raise AsaasUnavailable(uncertain=False)
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=False, trust_env=False) as client:
            response = await client.post(f"{SANDBOX_API}/checkouts", json=payload, headers={
                "access_token": settings.asaas_sandbox_api_key or "",
                "User-Agent": "SEMPER-FI/0.1 (sandbox)", "Content-Type": "application/json",
            })
        if response.status_code >= 400:
            raise AsaasUnavailable(uncertain=response.status_code not in {400, 401, 403, 422})
        if response.status_code not in {200, 201}:
            raise AsaasUnavailable()
        data = response.json()
        provider_id = data.get("id")
        if not isinstance(provider_id, str):
            raise AsaasUnavailable()
        return {"id": provider_id, "link": checkout_link(provider_id, data.get("link"))}
    except AsaasUnavailable:
        raise
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        # Do not attach a request/response carrying credentials or payer data.
        raise AsaasUnavailable() from None
