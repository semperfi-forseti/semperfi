from __future__ import annotations

import uuid
from collections import defaultdict
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.legal import _policy
from app.audit import append_audit
from app.db import get_db
from app.models import (
    Appointment,
    AuditEvent,
    Client,
    ConnectorRun,
    Deadline,
    Entity,
    EntityIdentifier,
    EntityRelation,
    Evidence,
    EvidenceEvent,
    FinancialEntry,
    Finding,
    Intimation,
    Investigation,
    InvestigationScope,
    LegalProcess,
    ProcessMovement,
    Report,
    User,
)
from app.security import Principal, cipher, get_current_principal

router = APIRouter(tags=["Frontend bridge"])


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _map_status(value: str | None, mapping: dict[str, str]) -> str | None:
    if value is None:
        return None
    return mapping.get(value, value)


def _frontend_entity_type(value: str) -> str:
    mapping = {
        "person": "pessoa_fisica",
        "company": "pessoa_juridica",
        "process": "processo",
        "domain": "dominio",
        "address": "endereco",
        "phone": "telefone",
        "bank": "banco",
        "document": "documento",
        "web_page": "pagina_web",
        "municipality": "municipio",
    }
    return mapping.get(value, value)


def _frontend_risk(value: str) -> str:
    return {"low": "baixo", "medium": "medio", "high": "alto"}.get(value, value)


def _frontend_connector_id(run: ConnectorRun) -> str:
    if run.connector_id == "brasilapi":
        kind = str(run.request_payload.get("kind", "")).lower()
        return {
            "cnpj": "brasilapi_cnpj",
            "cep": "brasilapi_cep",
            "ddd": "brasilapi_ddd",
            "bank": "brasilapi_bancos",
            "holidays": "brasilapi_feriados",
        }.get(kind, "brasilapi")
    if run.connector_id == "datajud":
        return "datajud_cnj"
    return run.connector_id


def _run_status(value: str) -> str:
    return {
        "queued": "em_execucao",
        "running": "em_execucao",
        "completed": "ok",
        "failed": "erro",
    }.get(value, value)


def _run_summary(run: ConnectorRun) -> str | None:
    result = run.normalized_result or run.raw_snapshot or {}
    if not isinstance(result, dict) or not result:
        return None
    parts: list[str] = []
    for key in ("razao_social", "nome_fantasia", "name", "numeroProcesso", "ldhName", "cep", "city", "state"):
        value = result.get(key)
        if value:
            parts.append(str(value))
    if not parts:
        parts = [f"{key}: {value}" for key, value in list(result.items())[:3]]
    return " | ".join(parts[:3])


def _frontend_audit_module(item: AuditEvent) -> str:
    if item.resource_type in {"investigation", "entity", "entity_relation", "finding", "connector_run", "evidence", "report", "agent_run"}:
        return "osint"
    if item.resource_type in {"audit_event", "audit_ledger"} or item.action.startswith("audit."):
        return "audit"
    if item.resource_type in {"client", "process", "deadline", "appointment", "intimation", "financial_entry", "process_movement"}:
        return "legal"
    return item.resource_type


def _resource_key(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


@router.get("/frontend/bootstrap")
async def frontend_bootstrap(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    await _policy(session, principal, request, "frontend.bootstrap")
    clients = list((await session.scalars(select(Client).where(Client.tenant_id == principal.tenant_id, Client.deleted_at.is_(None)).order_by(Client.name))).all())
    processes = list((await session.scalars(select(LegalProcess).where(LegalProcess.tenant_id == principal.tenant_id, LegalProcess.deleted_at.is_(None)).order_by(LegalProcess.number))).all())
    deadlines = list((await session.scalars(select(Deadline).where(Deadline.tenant_id == principal.tenant_id, Deadline.deleted_at.is_(None)).order_by(Deadline.due_date))).all())
    appointments = list((await session.scalars(select(Appointment).where(Appointment.tenant_id == principal.tenant_id, Appointment.deleted_at.is_(None)).order_by(Appointment.appointment_date, Appointment.appointment_time))).all())
    intimations = list((await session.scalars(select(Intimation).where(Intimation.tenant_id == principal.tenant_id, Intimation.deleted_at.is_(None)).order_by(Intimation.received_at.desc()))).all())
    financial_entries = list((await session.scalars(select(FinancialEntry).where(FinancialEntry.tenant_id == principal.tenant_id, FinancialEntry.deleted_at.is_(None)).order_by(FinancialEntry.entry_date.desc()))).all())
    process_movements = list((await session.scalars(select(ProcessMovement).where(ProcessMovement.tenant_id == principal.tenant_id, ProcessMovement.deleted_at.is_(None)).order_by(ProcessMovement.occurred_on.desc()))).all())
    investigations = list((await session.scalars(select(Investigation).where(Investigation.tenant_id == principal.tenant_id, Investigation.status != "deleted").order_by(Investigation.created_at.desc()))).all())

    investigation_ids = [item.id for item in investigations]
    scopes = list((await session.scalars(select(InvestigationScope).where(InvestigationScope.investigation_id.in_(investigation_ids) if investigation_ids else False))).all()) if investigation_ids else []
    entities = list((await session.scalars(select(Entity).where(Entity.investigation_id.in_(investigation_ids), Entity.verification_status != "deleted"))).all()) if investigation_ids else []
    entity_ids = [item.id for item in entities]
    identifiers = list((await session.scalars(select(EntityIdentifier).where(EntityIdentifier.entity_id.in_(entity_ids) if entity_ids else False))).all()) if entity_ids else []
    relations = list((await session.scalars(select(EntityRelation).where(EntityRelation.investigation_id.in_(investigation_ids) if investigation_ids else False))).all()) if investigation_ids else []
    runs = list((await session.scalars(select(ConnectorRun).where(ConnectorRun.tenant_id == principal.tenant_id, ConnectorRun.investigation_id.in_(investigation_ids) if investigation_ids else False).order_by(ConnectorRun.created_at.desc()))).all()) if investigation_ids else []
    findings = list((await session.scalars(select(Finding).where(Finding.tenant_id == principal.tenant_id, Finding.investigation_id.in_(investigation_ids) if investigation_ids else False).order_by(Finding.created_at.desc()))).all()) if investigation_ids else []
    evidences = list((await session.scalars(select(Evidence).where(Evidence.tenant_id == principal.tenant_id).order_by(Evidence.collected_at.desc()))).all())
    evidence_ids = [item.id for item in evidences]
    evidence_events = list((await session.scalars(select(EvidenceEvent).where(EvidenceEvent.evidence_id.in_(evidence_ids) if evidence_ids else False).order_by(EvidenceEvent.created_at.asc()))).all()) if evidence_ids else []
    reports = list((await session.scalars(select(Report).where(Report.tenant_id == principal.tenant_id).order_by(Report.created_at.desc()))).all())
    audit_rows = list((await session.scalars(select(AuditEvent).where(AuditEvent.tenant_id == principal.tenant_id).order_by(AuditEvent.occurred_at.desc()).limit(500))).all())

    owner_ids = {item.owner_id for item in investigations if item.owner_id}
    collector_ids = {item.collector_id for item in evidences if item.collector_id}
    actor_ids = {item.actor_id for item in audit_rows if item.actor_id}
    user_ids = list(owner_ids | collector_ids | actor_ids)
    users = list((await session.scalars(select(User).where(User.id.in_(user_ids) if user_ids else False))).all()) if user_ids else []
    user_map = {item.id: item.display_name for item in users}
    user_map.setdefault(principal.user_id, principal.display_name)

    scopes_by_investigation: dict[uuid.UUID, list[str]] = defaultdict(list)
    for scope in scopes:
        scopes_by_investigation[scope.investigation_id].append(scope.scope_code)

    identifiers_by_entity: dict[uuid.UUID, list[EntityIdentifier]] = defaultdict(list)
    for identifier in identifiers:
        identifiers_by_entity[identifier.entity_id].append(identifier)

    entity_to_investigation = {str(item.id): str(item.investigation_id) for item in entities}
    relation_to_investigation = {str(item.id): str(item.investigation_id) for item in relations}
    run_to_investigation = {str(item.id): str(item.investigation_id) for item in runs if item.investigation_id}
    finding_to_investigation = {str(item.id): str(item.investigation_id) for item in findings}
    finding_by_evidence = {str(item.evidence_id): item for item in findings if item.evidence_id}
    report_to_investigation = {str(item.id): str(item.investigation_id) for item in reports if item.investigation_id}
    evidence_to_investigation = {str(item.id): str(item.investigation_id) for item in evidences if item.investigation_id}

    finding_reviewers = {
        str(item.resource_id): item.metadata_safe.get("reviewer_name")
        for item in audit_rows
        if item.resource_type == "finding" and item.action == "finding.update" and item.metadata_safe.get("human_validated")
    }
    evidence_reviewers = {
        str(item.resource_id): item.metadata_safe.get("reviewer_name")
        for item in audit_rows
        if item.resource_type == "evidence" and item.action == "evidence.attest"
    }
    evidence_hashes: dict[str, tuple[str | None, str | None]] = {}
    for event in evidence_events:
        evidence_hashes[str(event.evidence_id)] = (event.previous_hash, event.event_hash)

    audit_payload: list[dict[str, Any]] = []
    for row in audit_rows:
        resource_id = _resource_key(row.resource_id)
        investigation_id = (
            resource_id if row.resource_type == "investigation" else
            entity_to_investigation.get(resource_id or "") if row.resource_type == "entity" else
            relation_to_investigation.get(resource_id or "") if row.resource_type == "entity_relation" else
            finding_to_investigation.get(resource_id or "") if row.resource_type == "finding" else
            run_to_investigation.get(resource_id or "") if row.resource_type == "connector_run" else
            evidence_to_investigation.get(resource_id or "") if row.resource_type == "evidence" else
            report_to_investigation.get(resource_id or "") if row.resource_type == "report" else
            None
        )
        audit_payload.append(
            {
                "id": str(row.id),
                "timestamp": row.occurred_at.isoformat(),
                "actor": user_map.get(row.actor_id, principal.display_name if row.actor_id == principal.user_id else "Sistema"),
                "profile": "Backend",
                "module": _frontend_audit_module(row),
                "action": row.action,
                "target": resource_id,
                "result": row.result,
                "correlationId": row.correlation_id,
                "osintMeta": {"investigationId": investigation_id} if investigation_id else None,
            }
        )

    await append_audit(session, principal, request, action="frontend.bootstrap", resource_type="frontend", resource_id=None, correlation_id=request.headers.get("X-Correlation-Id", "frontend-bootstrap"), metadata_safe={"clients": len(clients), "investigations": len(investigations)})
    await session.commit()

    return {
        "me": {
            "id": str(principal.user_id),
            "tenant_id": str(principal.tenant_id),
            "email": principal.email,
            "display_name": principal.display_name,
            "roles": sorted(principal.roles),
        },
        "data": {
            "clients": [
                {
                    "id": str(item.id),
                    "name": item.name,
                    "type": item.kind,
                    "document": cipher.decrypt(item.document_ciphertext),
                    "email": cipher.decrypt(item.email_ciphertext),
                    "phone": cipher.decrypt(item.phone_ciphertext),
                    "address": cipher.decrypt(item.address_ciphertext),
                    "responsible": item.responsible,
                    "status": _map_status(item.status, {"active": "ativo", "pending": "atencao", "inactive": "inativo"}),
                    "notes": item.notes,
                    "createdAt": item.created_at.isoformat(),
                }
                for item in clients
            ],
            "processes": [
                {
                    "id": str(item.id),
                    "number": item.number,
                    "clientId": str(item.client_id),
                    "court": item.court,
                    "area": item.area,
                    "phase": item.phase,
                    "responsible": item.responsible,
                    "value": _to_float(item.claim_value),
                    "status": _map_status(item.status, {"active": "ativo", "critical": "critico", "archived": "arquivado"}),
                    "notes": item.notes,
                    "createdAt": item.created_at.isoformat(),
                }
                for item in processes
            ],
            "deadlines": [
                {
                    "id": str(item.id),
                    "processId": str(item.process_id),
                    "title": item.title,
                    "date": item.due_date.isoformat(),
                    "type": item.deadline_type,
                    "responsible": item.responsible,
                    "status": _map_status(item.status, {"pending": "pendente", "completed": "concluido"}),
                    "notes": item.notes,
                    "createdAt": item.created_at.isoformat(),
                }
                for item in deadlines
            ],
            "appointments": [
                {
                    "id": str(item.id),
                    "date": item.appointment_date.isoformat(),
                    "time": item.appointment_time.isoformat(timespec="minutes") if item.appointment_time else "",
                    "title": item.title,
                    "type": item.appointment_type,
                    "clientId": str(item.client_id) if item.client_id else None,
                    "processId": str(item.process_id) if item.process_id else None,
                    "location": item.location,
                    "notes": item.notes,
                    "status": _map_status(item.status, {"confirmed": "confirmado", "pending": "pendente", "completed": "concluido", "cancelled": "cancelado", "canceled": "cancelado"}),
                    "createdAt": item.created_at.isoformat(),
                }
                for item in appointments
            ],
            "intimations": [
                {
                    "id": str(item.id),
                    "source": item.source,
                    "type": item.intimation_type,
                    "processId": str(item.process_id) if item.process_id else None,
                    "receivedAt": item.received_at.isoformat(),
                    "confidence": _map_status(item.confidence, {"medium": "media", "high": "alta", "low": "baixa"}),
                    "status": _map_status(item.status, {"triage": "triagem", "received": "recebida", "concluded": "concluida", "associated": "associada"}),
                    "content": cipher.decrypt(item.content_ciphertext) or "",
                    "createdAt": item.created_at.isoformat(),
                }
                for item in intimations
            ],
            "financial": [
                {
                    "id": str(item.id),
                    "date": item.entry_date.isoformat(),
                    "type": _map_status(item.entry_type, {"revenue": "receita", "expense": "despesa"}),
                    "description": item.description,
                    "clientId": str(item.client_id) if item.client_id else None,
                    "processId": str(item.process_id) if item.process_id else None,
                    "category": item.category,
                    "amount": _to_float(item.amount),
                    "status": _map_status(item.status, {"paid": "pago", "received": "recebido", "forecast": "previsto", "overdue": "vencido"}),
                    "createdAt": item.created_at.isoformat(),
                }
                for item in financial_entries
            ],
            "processMovements": [
                {
                    "id": str(item.id),
                    "processId": str(item.process_id),
                    "date": item.occurred_on.isoformat(),
                    "type": item.movement_type,
                    "description": item.description,
                    "source": item.source,
                    "authorId": user_map.get(item.created_by, principal.display_name if item.created_by == principal.user_id else "Sistema"),
                    "attachments": [],
                    "intimationId": (item.payload or {}).get("intimationId"),
                    "createdAt": item.created_at.isoformat(),
                    "payload": item.payload,
                }
                for item in process_movements
            ],
            "investigations": [
                {
                    "id": str(item.id),
                    "title": item.title,
                    "objective": item.objective,
                    "hypothesis": item.hypothesis,
                    "category": item.category,
                    "legalBasis": item.legal_basis,
                    "legitimateInterestAssessment": item.proportionality_assessment,
                    "authorizationReference": item.authorization_reference,
                    "clientId": str(item.client_id) if item.client_id else None,
                    "processId": str(item.process_id) if item.process_id else None,
                    "owner": user_map.get(item.owner_id, principal.display_name if item.owner_id == principal.user_id else "Equipe SEMPER-FI"),
                    "status": item.status,
                    "riskLevel": _frontend_risk(item.risk_level),
                    "scope": scopes_by_investigation.get(item.id, []),
                    "priority": "media",
                    "purpose": item.purpose,
                    "deadline": None,
                    "retentionUntil": item.retention_until.isoformat() if item.retention_until else None,
                    "createdAt": item.created_at.isoformat(),
                    "updatedAt": item.updated_at.isoformat(),
                    "closedAt": item.updated_at.isoformat() if item.status in {"concluida", "arquivada", "bloqueada"} else None,
                }
                for item in investigations
            ],
            "osintEntities": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id),
                    "entityType": _frontend_entity_type(item.entity_type),
                    "displayName": item.display_name,
                    "normalizedName": item.normalized_name,
                    "documentMasked": next((f"***{identifier.value_fingerprint[-8:]}" for identifier in identifiers_by_entity[item.id] if identifier.identifier_type == "document"), None),
                    "documentFingerprint": next((identifier.value_fingerprint[:12] for identifier in identifiers_by_entity[item.id] if identifier.identifier_type == "document"), None),
                    "aliases": [],
                    "verificationStatus": _map_status(item.verification_status, {"preliminary": "preliminar"}),
                    "confidence": item.confidence,
                    "notes": item.notes,
                    "createdAt": item.created_at.isoformat(),
                }
                for item in entities
            ],
            "osintRuns": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id) if item.investigation_id else None,
                    "connectorId": _frontend_connector_id(item),
                    "targetEntityId": str(item.target_entity_id) if item.target_entity_id else None,
                    "purpose": item.purpose,
                    "scopeSnapshot": item.request_payload.get("scope_codes", []),
                    "requestFingerprint": item.request_hash[:16],
                    "startedAt": item.created_at.isoformat(),
                    "finishedAt": item.updated_at.isoformat() if item.status in {"completed", "failed"} else None,
                    "status": _run_status(item.status),
                    "resultSummary": _run_summary(item),
                    "errorMessage": item.error_code,
                    "actor": "Servidor",
                    "correlationId": item.correlation_id,
                    "rawData": item.raw_snapshot or item.normalized_result or {},
                }
                for item in runs
            ],
            "osintFindings": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id),
                    "entityId": str(item.entity_id) if item.entity_id else None,
                    "type": item.source_name.lower().replace(" ", "_"),
                    "title": item.title,
                    "statement": item.statement,
                    "sourceCount": 1,
                    "confidenceScore": item.reliability_score,
                    "classification": item.classification,
                    "humanValidated": item.human_validated,
                    "reviewer": finding_reviewers.get(str(item.id)),
                    "evidenceIds": [str(item.evidence_id)] if item.evidence_id else [],
                    "createdAt": item.created_at.isoformat(),
                    "updatedAt": item.updated_at.isoformat(),
                    "runId": None,
                }
                for item in findings
            ],
            "osintRelations": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id),
                    "fromEntityId": str(item.source_entity_id),
                    "toEntityId": str(item.target_entity_id),
                    "relationType": item.relation_type,
                    "confidenceScore": item.confidence,
                    "evidenceIds": [],
                    "status": "validada" if item.human_validated else "pendente_validacao",
                    "createdAt": item.created_at.isoformat(),
                }
                for item in relations
            ],
            "evidence": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id) if item.investigation_id else None,
                    "findingId": str(finding_by_evidence.get(str(item.id)).id) if finding_by_evidence.get(str(item.id)) else None,
                    "entityId": str(finding_by_evidence.get(str(item.id)).entity_id) if finding_by_evidence.get(str(item.id)) and finding_by_evidence.get(str(item.id)).entity_id else None,
                    "sourceName": item.metadata_json.get("display_name") or item.original_filename,
                    "sourceType": item.source_type,
                    "sourceUrl": item.source_url,
                    "collectionMethod": item.collection_method,
                    "collectedAt": item.collected_at.isoformat(),
                    "collectedAtUtc": item.collected_at.isoformat(),
                    "actor": user_map.get(item.collector_id, principal.display_name if item.collector_id == principal.user_id else "Sistema"),
                    "rawPayloadReference": item.metadata_json.get("payload_preview"),
                    "visualSnapshotReference": None,
                    "originalFileId": None,
                    "sha256": item.sha256,
                    "previousEventHash": evidence_hashes.get(str(item.id), (None, None))[0],
                    "eventHash": evidence_hashes.get(str(item.id), (None, None))[1],
                    "validationStatus": _map_status(item.validation_status, {"pending": "pendente", "validated": "validada", "preserved": "validada", "integrity_failed": "falha_integridade"}),
                    "reviewer": evidence_reviewers.get(str(item.id)),
                    "notes": None,
                    "retentionUntil": item.retain_until.isoformat() if item.retain_until else None,
                }
                for item in evidences
            ],
            "evidenceEvents": [
                {
                    "id": str(item.id),
                    "evidenceId": str(item.evidence_id),
                    "investigationId": evidence_to_investigation.get(str(item.evidence_id)),
                    "action": item.event_type,
                    "actor": user_map.get(item.actor_id, "Sistema"),
                    "timestamp": item.created_at.isoformat(),
                    "previousHash": item.previous_hash,
                    "currentHash": item.event_hash,
                    "details": item.details,
                }
                for item in evidence_events
            ],
            "reports": [
                {
                    "id": str(item.id),
                    "investigationId": str(item.investigation_id) if item.investigation_id else None,
                    "title": item.title,
                    "status": item.status,
                    "version": item.version,
                    "reportType": item.report_type,
                    "contentHash": item.content_hash,
                    "createdAt": item.created_at.isoformat(),
                    "updatedAt": item.updated_at.isoformat(),
                }
                for item in reports
            ],
            "audit": audit_payload,
        },
    }
