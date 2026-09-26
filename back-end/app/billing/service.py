from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.billing.catalog import PLANS
from app.core.config import Settings
from app.integrations import asaas
from app.models.billing import BillingCheckout, BillingWebhookReceipt
from app.security import Principal


async def tenant_context(session: AsyncSession, tenant_id: uuid.UUID) -> None:
    # SET LOCAL expires after each commit; restore it for the next transaction.
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT set_config('app.tenant_id', :tenant, true)"), {"tenant": str(tenant_id)})


async def webhook_context(session: AsyncSession) -> None:
    # Called only after authenticating the provider token. The scope is limited
    # to the two billing tables and ends with this transaction.
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT set_config('app.billing_webhook_verified', 'true', true)"))


def serialize_checkout(item: BillingCheckout) -> dict:
    return {
        "id": str(item.id), "request_id": str(item.request_id), "plan_key": item.plan_key,
        "amount_cents": item.amount_cents, "currency": item.currency, "status": item.status,
        "checkout_url": item.checkout_url if item.status == "open" else None,
        "created_at": item.created_at, "expires_at": item.expires_at, "paid_at": item.paid_at,
        "provider": "asaas", "environment": "sandbox", "sandbox_only": True,
    }


async def start_checkout(session: AsyncSession, settings: Settings, principal: Principal,
                         plan_key: str, request_id: uuid.UUID) -> dict:
    if not asaas.configuration_ready(settings):
        raise HTTPException(503, detail="O checkout Sandbox aguarda configuração no servidor.")
    await tenant_context(session, principal.tenant_id)
    existing = await session.scalar(select(BillingCheckout).where(
        BillingCheckout.tenant_id == principal.tenant_id, BillingCheckout.request_id == request_id))
    if existing:
        if existing.plan_key != plan_key:
            raise HTTPException(409, detail="Este identificador já pertence a outro plano.")
        if existing.status in {"creating", "unknown"}:
            raise HTTPException(409, detail={"code": "CHECKOUT_RECONCILIATION_REQUIRED", "checkout_id": str(existing.id),
                "reason": "Pedido em processamento ou aguardando conciliação. Não inicie uma nova compra."})
        return serialize_checkout(existing)
    active = await session.scalar(select(BillingCheckout.id).where(
        BillingCheckout.tenant_id == principal.tenant_id, BillingCheckout.active_slot == "subscription"))
    if active:
        raise HTTPException(409, detail={"code": "CHECKOUT_ALREADY_EXISTS", "checkout_id": str(active),
            "reason": "Já existe um checkout ou assinatura de homologação para esta organização."})
    plan = PLANS[plan_key]
    item = BillingCheckout(tenant_id=principal.tenant_id, requested_by=principal.user_id,
        request_id=request_id, plan_key=plan_key, amount_cents=plan["amount_cents"], status="creating", active_slot="subscription")
    session.add(item)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(409, detail="Outro pedido foi iniciado. Atualize o estado antes de continuar.") from None
    item_id = item.id
    try:
        payload = asaas.build_payload(settings=settings, checkout_id=str(item_id), plan=plan)
        created = await asaas.create_checkout(settings, payload)
    except asaas.AsaasUnavailable as error:
        await tenant_context(session, principal.tenant_id)
        item = await session.scalar(select(BillingCheckout).where(
            BillingCheckout.id == item_id, BillingCheckout.tenant_id == principal.tenant_id)
            .with_for_update().execution_options(populate_existing=True))
        if item and item.status == "creating":
            item.status = "unknown" if error.uncertain else "failed"
            item.error_code = "PROVIDER_UNCERTAIN" if error.uncertain else "PROVIDER_REJECTED"
            if not error.uncertain:
                item.active_slot = None
            await session.commit()
        raise HTTPException(503, detail={"code": "CHECKOUT_UNAVAILABLE", "checkout_id": str(item_id),
            "reason": "O checkout não pôde ser confirmado. Consulte o estado do pedido antes de tentar novamente."}) from None
    await tenant_context(session, principal.tenant_id)
    item = await session.scalar(select(BillingCheckout).where(
        BillingCheckout.id == item_id, BillingCheckout.tenant_id == principal.tenant_id)
        .with_for_update().execution_options(populate_existing=True))
    if not item or (item.provider_checkout_id and item.provider_checkout_id != created["id"]):
        raise HTTPException(409, detail="Pedido requer conciliação com o provedor.")
    item.provider_checkout_id = created["id"]
    item.checkout_url = created["link"]
    item.expires_at = datetime.now(UTC) + timedelta(minutes=60)
    if item.status == "creating":
        item.status = "open"
    await session.commit()
    return serialize_checkout(item)


def _paid_amount(checkout: dict) -> int:
    items = checkout.get("items")
    if not isinstance(items, list) or not items or len(items) > 100:
        raise HTTPException(422, detail="Evento de pagamento sem itens verificáveis.")
    try:
        total = Decimal(0)
        for item in items:
            value, quantity = Decimal(str(item["value"])), Decimal(str(item["quantity"]))
            if (not value.is_finite() or not quantity.is_finite() or value <= 0 or quantity <= 0
                    or quantity != quantity.to_integral_value() or value > 1_000_000 or quantity > 1_000_000):
                raise ValueError
            total += value * quantity
        cents = total * 100
        if not cents.is_finite() or cents <= 0 or cents != cents.to_integral_value():
            raise ValueError
        return int(cents)
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise HTTPException(422, detail="Valor do evento inválido.") from None


async def receive_webhook(session: AsyncSession, payload: dict) -> dict:
    event_id, event_type, checkout = payload.get("id"), payload.get("event"), payload.get("checkout")
    if not isinstance(event_id, str) or not 1 <= len(event_id) <= 240 or not isinstance(event_type, str):
        raise HTTPException(422, detail="Evento inválido.")
    supported = {"CHECKOUT_CREATED", "CHECKOUT_PAID", "CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"}
    if event_type not in supported:
        return {"received": True, "ignored": True, "environment": "sandbox"}
    if not isinstance(checkout, dict) or not isinstance(checkout.get("id"), str):
        raise HTTPException(422, detail="Checkout ausente no evento.")
    provider_id = checkout["id"]
    if not asaas.PROVIDER_ID.fullmatch(provider_id):
        raise HTTPException(422, detail="Identificador de checkout inválido.")
    await webhook_context(session)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    receipt = await session.scalar(select(BillingWebhookReceipt).where(BillingWebhookReceipt.provider_event_id == event_id))
    if receipt:
        if receipt.payload_hash != digest:
            raise HTTPException(409, detail="O identificador do evento já possui outro conteúdo.")
        return {"received": True, "duplicate": True, "environment": "sandbox"}
    conditions = [BillingCheckout.provider_checkout_id == provider_id]
    reference = checkout.get("externalReference")
    if reference:
        try:
            local_id = uuid.UUID(reference)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, detail="Referência de checkout inválida.") from None
        conditions.append((BillingCheckout.id == local_id) & BillingCheckout.provider_checkout_id.is_(None))
    item = await session.scalar(select(BillingCheckout).where(or_(*conditions)).with_for_update())
    if not item:
        # A webhook may arrive while the creating request is saving the provider ID.
        # A non-2xx response asks Asaas to redeliver; do not acknowledge a lost payment.
        raise HTTPException(409, detail="Checkout ainda não conciliado. Reenvie o evento.")
    if reference and reference != str(item.id):
        raise HTTPException(409, detail="Referência divergente do pedido registrado.")
    if event_type == "CHECKOUT_PAID":
        if checkout.get("status") != "PAID" or _paid_amount(checkout) != item.amount_cents:
            raise HTTPException(409, detail="Pagamento divergente do pedido registrado.")
        charge_types = checkout.get("chargeTypes")
        subscription = checkout.get("subscription")
        if (not isinstance(charge_types, list) or charge_types != ["RECURRENT"]
                or not isinstance(subscription, dict) or subscription.get("cycle") != "MONTHLY"):
            raise HTTPException(409, detail="Recorrência divergente do pedido registrado.")
        item.status = "paid"
        item.active_slot = "subscription"
        item.paid_at = item.paid_at or datetime.now(UTC)
    elif item.status != "paid":
        states = {"CHECKOUT_CREATED": "open", "CHECKOUT_CANCELED": "canceled", "CHECKOUT_EXPIRED": "expired"}
        # A delayed CREATED cannot reopen a canceled/expired checkout.
        if event_type != "CHECKOUT_CREATED" or item.status in {"creating", "unknown"}:
            item.status = states[event_type]
        if item.status in {"canceled", "expired"}:
            item.active_slot = None
    item.provider_checkout_id = provider_id
    session.add(BillingWebhookReceipt(tenant_id=item.tenant_id, checkout_id=item.id,
        provider_event_id=event_id, event_type=event_type, payload_hash=digest))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        await webhook_context(session)
        receipt = await session.scalar(select(BillingWebhookReceipt).where(BillingWebhookReceipt.provider_event_id == event_id))
        if receipt and receipt.payload_hash == digest:
            return {"received": True, "duplicate": True, "environment": "sandbox"}
        raise HTTPException(409, detail="Evento requer conciliação. Reenvie o evento.") from None
    return {"received": True, "duplicate": False, "environment": "sandbox"}
