from __future__ import annotations

import hmac
import json
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing.catalog import PLANS
from app.billing.service import receive_webhook, serialize_checkout, start_checkout
from app.core.config import get_settings
from app.db import SessionLocal, get_db
from app.integrations.asaas import configuration_ready
from app.models.billing import BillingCheckout
from app.security import Principal, get_current_principal, require_recent_mfa

router = APIRouter(prefix="/billing", tags=["Sandbox billing"])


class CheckoutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_key: Literal["lite", "profissional", "escritorio", "equipe"]
    request_id: uuid.UUID


@router.get("/catalog")
async def catalog(response: Response, principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    return {"currency": "BRL", "provider": "asaas", "environment": "sandbox", "sandbox_only": True,
        "plans": [{**plan, "price": plan["amount_cents"] / 100, "cycle": "MONTHLY"} for plan in PLANS.values()]}


@router.get("/status")
async def billing_status(response: Response, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    rows = list((await session.scalars(select(BillingCheckout).where(BillingCheckout.tenant_id == principal.tenant_id)
        .order_by(BillingCheckout.created_at.desc()).limit(20))).all())
    enabled = configuration_ready(get_settings())
    # History is capped for display; an older active intent must still block a
    # second checkout even if it falls outside this page.
    active = await session.scalar(select(BillingCheckout).where(
        BillingCheckout.tenant_id == principal.tenant_id,
        BillingCheckout.active_slot == "subscription"))
    paid = active if active and active.status == "paid" else None
    can_manage = principal.has_any_role("administrator")
    return {"provider": "asaas", "environment": "sandbox", "sandbox_only": True, "enabled": enabled,
        "can_checkout": enabled and can_manage and not active, "can_manage": can_manage,
        "subscription": {"plan_key": paid.plan_key, "status": "sandbox_paid", "paid_at": paid.paid_at} if paid else None,
        "checkouts": [serialize_checkout(item) for item in rows],
        "production_entitlements": False,
        "limitations": ["Homologação: não movimenta valores reais nem libera franquias de produção.",
            "Renovação, alteração e cancelamento da assinatura ainda exigem conciliação no painel Sandbox."]}


@router.get("/checkouts/{checkout_id}")
async def checkout_status(checkout_id: uuid.UUID, response: Response, session: AsyncSession = Depends(get_db),
                          principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    item = await session.scalar(select(BillingCheckout).where(
        BillingCheckout.id == checkout_id, BillingCheckout.tenant_id == principal.tenant_id))
    if not item:
        raise HTTPException(404, detail="Checkout não encontrado.")
    return serialize_checkout(item)


@router.post("/checkouts", status_code=201)
async def checkout_create(body: CheckoutRequest, response: Response, session: AsyncSession = Depends(get_db),
                          principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    if not principal.has_any_role("administrator"):
        raise HTTPException(403, detail="Somente o administrador pode iniciar o checkout de homologação.")
    return await start_checkout(session, get_settings(), principal, body.plan_key, body.request_id)


@router.post("/webhooks/asaas")
async def asaas_webhook(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    settings = get_settings()
    expected, supplied = settings.asaas_webhook_token or "", request.headers.get("asaas-access-token", "")
    if not settings.asaas_sandbox_enabled or len(expected) < 32:
        raise HTTPException(503, detail="Webhook de homologação não configurado.")
    if not hmac.compare_digest(expected.encode(), supplied.encode()):
        raise HTTPException(401, detail="Webhook não autorizado.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 65536:
            raise HTTPException(413, detail="Evento excede o limite permitido.")
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(422, detail="JSON inválido.") from None
    if not isinstance(payload, dict):
        raise HTTPException(422, detail="Evento inválido.")
    async with SessionLocal() as session:
        return await receive_webhook(session, payload)
