from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Integer, Text, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class ClientProfile(Base, UUIDMixin, TimestampMixin):
    """Operator supplied profile; its JSON document is encrypted as one field."""

    __tablename__ = "client_profiles"
    __table_args__ = (UniqueConstraint("tenant_id", "client_id", name="uq_client_profiles_tenant_client"),)

    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("clients.id"), nullable=False, index=True)
    profile_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
