from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class BillingCheckout(Base, UUIDMixin, TimestampMixin):
    """Sandbox purchase intent; never a production entitlement or a credit balance."""

    __tablename__ = "billing_checkouts"
    __table_args__ = (
        UniqueConstraint("tenant_id", "request_id", name="billing_checkout_request"),
        UniqueConstraint("tenant_id", "active_slot", name="billing_checkout_active_slot"),
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    requested_by: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    plan_key: Mapped[str] = mapped_column(String(32), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="BRL", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="creating", nullable=False)
    active_slot: Mapped[str | None] = mapped_column(String(32), nullable=True)
    provider_checkout_id: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    checkout_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)


class BillingWebhookReceipt(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "billing_webhook_receipts"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("tenants.id"), index=True)
    checkout_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("billing_checkouts.id"), index=True)
    provider_event_id: Mapped[str] = mapped_column(String(240), unique=True, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
