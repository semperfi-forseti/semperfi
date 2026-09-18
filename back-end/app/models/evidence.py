from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class Evidence(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "evidences"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=True, index=True)
    parent_evidence_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("evidences.id"), nullable=True)
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    collection_method: Mapped[str] = mapped_column(String(128), nullable=False)
    collector_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    storage_bucket: Mapped[str | None] = mapped_column(String(255), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    storage_version_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    storage_etag: Mapped[str | None] = mapped_column(String(256), nullable=True)
    retention_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    retain_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    legal_hold: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    scan_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    validation_status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict, nullable=False)


class EvidenceEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "evidence_events"
    evidence_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("evidences.id"), nullable=False, index=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    event_type: Mapped[str] = mapped_column(String(96), nullable=False)
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    previous_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    event_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class RetentionPolicy(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "retention_policies"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    retention_days: Mapped[int] = mapped_column(nullable=False)
    object_lock_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class LegalHold(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "legal_holds"
    evidence_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("evidences.id"), nullable=False, index=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    requested_by: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
