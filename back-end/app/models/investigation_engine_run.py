from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class InvestigationEngineRun(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "investigation_engine_runs"
    __table_args__ = (UniqueConstraint("tenant_id", "request_id", name="uq_engine_runs_tenant_request"),)

    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    engine: Mapped[str] = mapped_column(String(16), nullable=False)
    target_type: Mapped[str] = mapped_column(String(32), nullable=False)
    input_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    result_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    review_status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    review_notes_ciphertext: Mapped[str | None] = mapped_column(Text)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

