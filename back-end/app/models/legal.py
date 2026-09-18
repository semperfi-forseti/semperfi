from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal

from sqlalchemy import JSON, Date, DateTime, ForeignKey, Numeric, String, Text, Time, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, SoftDeleteMixin, TimestampMixin, UUIDMixin


class TenantRecord(Base, UUIDMixin, TimestampMixin, SoftDeleteMixin):
    __abstract__ = True
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)


class Client(TenantRecord):
    __tablename__ = "clients"
    kind: Mapped[str] = mapped_column(String(8), nullable=False, default="PF")
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    document_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    document_fingerprint: Mapped[str | None] = mapped_column(String(64), index=True)
    email_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    phone_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    address_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    responsible: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class LegalProcess(TenantRecord):
    __tablename__ = "processes"
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("clients.id"), nullable=False, index=True)
    number: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    court: Mapped[str | None] = mapped_column(String(120), nullable=True)
    area: Mapped[str | None] = mapped_column(String(64), nullable=True)
    phase: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    responsible: Mapped[str | None] = mapped_column(String(160), nullable=True)
    claim_value: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class ProcessMovement(TenantRecord):
    __tablename__ = "process_movements"
    process_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=False, index=True)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    movement_type: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(80), nullable=False, default="manual")
    source_reference: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)


class Deadline(TenantRecord):
    __tablename__ = "deadlines"
    process_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    deadline_type: Mapped[str] = mapped_column(String(64), nullable=False)
    responsible: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class Appointment(TenantRecord):
    __tablename__ = "appointments"
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("clients.id"), nullable=True)
    process_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    appointment_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    appointment_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    appointment_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="confirmed", nullable=False)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class Intimation(TenantRecord):
    __tablename__ = "intimations"
    process_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=True, index=True)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    intimation_type: Mapped[str] = mapped_column(String(64), nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confidence: Mapped[str] = mapped_column(String(32), default="medium", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="triage", nullable=False)
    content_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)


class FinancialEntry(TenantRecord):
    __tablename__ = "financial_entries"
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("clients.id"), nullable=True)
    process_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=True)
    entry_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    entry_type: Mapped[str] = mapped_column(String(16), nullable=False)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str | None] = mapped_column(String(64), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
