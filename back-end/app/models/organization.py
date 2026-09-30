from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class OrganizationInvitation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "organization_invitations"

    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("tenants.id"), index=True)
    invited_by: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"))
    email: Mapped[str] = mapped_column(String(320), index=True)
    role: Mapped[str] = mapped_column(String(64))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.id"))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OrganizationSessionVersion(Base):
    """Changing one membership never revokes access to unrelated organizations."""

    __tablename__ = "organization_session_versions"

    membership_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("memberships.id"), primary_key=True)
    version: Mapped[str] = mapped_column(String(64))
