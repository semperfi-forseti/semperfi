from __future__ import annotations

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class LegalDocumentLink(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "legal_document_links"
    __table_args__ = (
        CheckConstraint("(client_id IS NOT NULL AND process_id IS NULL) OR (client_id IS NULL AND process_id IS NOT NULL)", name="one_target"),
        UniqueConstraint("tenant_id", "client_id", "evidence_id", name="uq_document_client_evidence"),
        UniqueConstraint("tenant_id", "process_id", "evidence_id", name="uq_document_process_evidence"),
    )

    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid, index=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("clients.id"), index=True)
    process_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("processes.id"), index=True)
    evidence_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("evidences.id"), index=True)
    label: Mapped[str | None] = mapped_column(String(180))
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid)
