from __future__ import annotations

import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ClientCreate(BaseModel):
    kind: Literal["PF", "PJ"] = "PF"
    name: str = Field(min_length=2, max_length=255)
    document: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=64)
    address: str | None = Field(default=None, max_length=512)
    responsible: str | None = Field(default=None, max_length=160)
    status: str = "active"
    notes: str | None = None


class ClientRead(ORMModel):
    id: uuid.UUID
    kind: str
    name: str
    document_masked: str | None = None
    responsible: str | None
    status: str
    created_at: datetime


class ProcessCreate(BaseModel):
    client_id: uuid.UUID
    number: str = Field(min_length=5, max_length=32)
    court: str | None = None
    area: str | None = None
    phase: str | None = None
    status: str = "active"
    responsible: str | None = None
    claim_value: Decimal | None = None
    notes: str | None = None


class ProcessRead(ORMModel):
    id: uuid.UUID
    client_id: uuid.UUID
    number: str
    court: str | None
    area: str | None
    phase: str | None
    status: str
    responsible: str | None
    claim_value: Decimal | None
    created_at: datetime


class ProcessMovementCreate(BaseModel):
    occurred_on: date
    movement_type: str = Field(min_length=2, max_length=64)
    description: str = Field(min_length=3)
    source: str = "manual"
    source_reference: str | None = Field(default=None, max_length=255)
    payload: dict[str, Any] = Field(default_factory=dict)


class DeadlineCreate(BaseModel):
    process_id: uuid.UUID
    title: str = Field(min_length=2, max_length=255)
    due_date: date
    deadline_type: str = "manifestation"
    responsible: str | None = None
    status: str = "pending"
    notes: str | None = None


class AppointmentCreate(BaseModel):
    title: str
    appointment_date: date
    appointment_time: time | None = None
    appointment_type: str = "meeting"
    client_id: uuid.UUID | None = None
    process_id: uuid.UUID | None = None
    status: str = "confirmed"
    location: str | None = None
    notes: str | None = None


class IntimationCreate(BaseModel):
    source: str
    intimation_type: str = "intimation"
    process_id: uuid.UUID | None = None
    received_at: datetime
    confidence: str = "medium"
    status: str = "triage"
    content: str = Field(min_length=3)


class FinancialEntryCreate(BaseModel):
    entry_date: date
    entry_type: Literal["revenue", "expense"]
    description: str
    amount: Decimal
    status: str
    category: str | None = None
    client_id: uuid.UUID | None = None
    process_id: uuid.UUID | None = None


class InvestigationCreate(BaseModel):
    title: str
    category: str
    objective: str = Field(min_length=50)
    purpose: str = Field(min_length=10)
    legal_basis: str
    authorization_reference: str
    proportionality_assessment: str = Field(min_length=10)
    risk_level: Literal["low", "medium", "high"] = "medium"
    client_id: uuid.UUID | None = None
    process_id: uuid.UUID | None = None
    hypothesis: str | None = None
    scope_codes: list[str] = Field(min_length=1)
    retention_until: datetime | None = None


class InvestigationStatusUpdate(BaseModel):
    status: str = Field(min_length=3, max_length=64)


class EntityCreate(BaseModel):
    entity_type: Literal["person", "company", "process", "domain", "address", "phone", "bank", "document", "web_page", "municipality"]
    display_name: str
    normalized_name: str | None = None
    identifiers: list[dict[str, str]] = Field(default_factory=list)
    verification_status: str = "preliminary"
    confidence: float = Field(default=0.0, ge=0, le=1)
    notes: str | None = None


class RelationCreate(BaseModel):
    source_entity_id: uuid.UUID
    target_entity_id: uuid.UUID
    relation_type: str
    confidence: float = Field(ge=0, le=1)
    provenance: dict[str, Any] = Field(default_factory=dict)


class FindingCreate(BaseModel):
    entity_id: uuid.UUID | None = None
    evidence_id: uuid.UUID | None = None
    classification: str = "dado_bruto"
    title: str = Field(min_length=3, max_length=255)
    statement: str = Field(min_length=3)
    source_name: str = Field(min_length=2, max_length=255)
    source_url: str | None = None
    method: str = Field(min_length=2, max_length=128)
    collected_at: datetime
    reliability_score: float = Field(default=0.0, ge=0, le=1)
    limitations: list[str] = Field(default_factory=list)
    human_validated: bool = False


class FindingUpdate(BaseModel):
    classification: str | None = Field(default=None, min_length=3, max_length=48)
    evidence_id: uuid.UUID | None = None
    human_validated: bool | None = None
    statement: str | None = Field(default=None, min_length=3)
    title: str | None = Field(default=None, min_length=3, max_length=255)


class ConnectorRunCreate(BaseModel):
    investigation_id: uuid.UUID | None = None
    target_entity_id: uuid.UUID | None = None
    connector_id: Literal["brasilapi", "transparency", "datajud", "rdap_dns"]
    payload: dict[str, Any]
    purpose: str = Field(min_length=10)
    legal_basis: str
    authorization_reference: str = Field(min_length=3)
    scope_codes: list[str] = Field(default_factory=list)
    risk_level: Literal["low", "medium", "high"] = "medium"


class InvestigationEngineRunCreate(BaseModel):
    investigation_id: uuid.UUID | None = None
    target: str = Field(min_length=3, max_length=255)
    target_type: Literal["person", "company", "domain", "process", "asset", "other"] = "other"
    purpose: str = Field(min_length=10)
    legal_basis: str = Field(min_length=3, max_length=96)
    authorization_reference: str = Field(min_length=3, max_length=255)
    declared_scope: list[str] = Field(default_factory=list)
    connectors_allowed: list[Literal["brasilapi", "transparency", "datajud", "rdap_dns"]] = Field(default_factory=list)
    risk_level: Literal["low", "medium", "high"] = "medium"
    seed_facts: dict[str, Any] = Field(default_factory=dict)


class EvidenceCreateResponse(BaseModel):
    evidence_id: uuid.UUID
    status: str
    sha256: str
    mime_type: str
    size_bytes: int


class LegalHoldRequest(BaseModel):
    reason: str = Field(min_length=10)
    confirmation_phrase: Literal["CONFIRMAR LEGAL HOLD"]


class AgentRunCreate(BaseModel):
    investigation_id: uuid.UUID | None = None
    agent_type: Literal["collection", "metadata", "timeline", "correlation", "inconsistency", "report", "legal_review"]
    purpose: str = Field(min_length=10)
    legal_basis: str
    authorization_reference: str = Field(min_length=3)
    input_safe: dict[str, Any] = Field(default_factory=dict)


class ReportCreate(BaseModel):
    investigation_id: uuid.UUID | None = None
    report_type: str = "investigative"
    title: str
    body: dict[str, Any]
    evidence_ids: list[uuid.UUID] = Field(default_factory=list)
    purpose: str = Field(min_length=10)
    legal_basis: str
    authorization_reference: str = Field(min_length=3)


class DemoImport(BaseModel):
    payload: dict[str, Any]


class SessionResponse(BaseModel):
    authenticated: bool
    auth_mode: str
    message: str
