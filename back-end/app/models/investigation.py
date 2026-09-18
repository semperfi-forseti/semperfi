from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDMixin


class Investigation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "investigations"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("clients.id"), nullable=True)
    process_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("processes.id"), nullable=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(80), nullable=False)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    hypothesis: Mapped[str | None] = mapped_column(Text, nullable=True)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    legal_basis: Mapped[str] = mapped_column(String(96), nullable=False)
    authorization_reference: Mapped[str] = mapped_column(String(255), nullable=False)
    proportionality_assessment: Mapped[str] = mapped_column(Text, nullable=False)
    risk_level: Mapped[str] = mapped_column(String(32), nullable=False, default="medium")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    retention_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InvestigationScope(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "investigation_scopes"
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    scope_code: Mapped[str] = mapped_column(String(96), nullable=False)
    approved: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Entity(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "entities"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    normalized_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    verification_status: Mapped[str] = mapped_column(String(32), nullable=False, default="preliminary")
    confidence: Mapped[float] = mapped_column(nullable=False, default=0.0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)


class EntityIdentifier(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "entity_identifiers"
    entity_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("entities.id"), nullable=False, index=True)
    identifier_type: Mapped[str] = mapped_column(String(64), nullable=False)
    value_ciphertext: Mapped[str] = mapped_column(Text, nullable=False)
    value_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class EntityRelation(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "entity_relations"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    source_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("entities.id"), nullable=False)
    target_entity_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("entities.id"), nullable=False)
    relation_type: Mapped[str] = mapped_column(String(96), nullable=False)
    confidence: Mapped[float] = mapped_column(nullable=False, default=0.0)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    human_validated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class ConnectorRun(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "connector_runs"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=True, index=True)
    target_entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("entities.id"), nullable=True)
    connector_id: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    correlation_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    job_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    request_payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    response_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    raw_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    normalized_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    limitations: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(96), nullable=True)


class Finding(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "findings"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("entities.id"), nullable=True)
    evidence_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("evidences.id"), nullable=True)
    classification: Mapped[str] = mapped_column(String(48), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    source_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    method: Mapped[str] = mapped_column(String(128), nullable=False)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reliability_score: Mapped[float] = mapped_column(nullable=False, default=0.0)
    limitations: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    human_validated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class TimelineEvent(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "timeline_events"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    source_finding_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), ForeignKey("findings.id"), nullable=True)
    confidence: Mapped[float] = mapped_column(nullable=False, default=0.0)


class RiskAssessment(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "risk_assessments"
    tenant_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    investigation_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), ForeignKey("investigations.id"), nullable=False, index=True)
    score: Mapped[float] = mapped_column(nullable=False)
    methodology_version: Mapped[str] = mapped_column(String(64), nullable=False)
    rationale: Mapped[str] = mapped_column(Text, nullable=False)
    human_approved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
