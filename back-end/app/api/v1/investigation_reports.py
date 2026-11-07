"""Investigative drafts built only from persisted records of the current tenant."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.investigations import _investigation
from app.api.v1.reports import _policy
from app.audit import append_audit
from app.db import get_db
from app.models import (
    ConnectorRun,
    Entity,
    EntityRelation,
    Evidence,
    Finding,
    Investigation,
    InvestigationScope,
    Report,
)
from app.policies import PolicyContext, PolicyEffect
from app.reports import canonical_hash
from app.security import Principal, get_current_principal
from app.services.agent_runs import validate_references

router = APIRouter(tags=["Investigation reports"])


class DraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: uuid.UUID


def receipt(report: Report) -> dict:
    return {"report_id": report.id, "status": report.status, "content_hash": report.content_hash, "version": report.version}


@router.post("/investigations/{investigation_id}/report-draft", status_code=201)
async def create_draft(investigation_id: uuid.UUID, body: DraftRequest, request: Request,
                       session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    inv = await _investigation(session, principal.tenant_id, investigation_id)
    # The investigation row serializes draft creation on PostgreSQL. A UUID derived
    # from tenant + investigation + command also handles ambiguous request retries.
    inv = await session.scalar(select(Investigation).where(
        Investigation.id == inv.id, Investigation.tenant_id == principal.tenant_id,
    ).with_for_update().execution_options(populate_existing=True))
    if inv is None:
        raise HTTPException(404, "Investigação não encontrada.")
    cid, decision = await _policy(session, principal, request, PolicyContext(action="report.generate",
        investigation_id=inv.id, purpose=inv.purpose, legal_basis=inv.legal_basis,
        authorization_reference=inv.authorization_reference, risk_level=inv.risk_level, scope_codes={"proof_digital"}))
    if decision.effect != PolicyEffect.ALLOW:
        raise HTTPException(403, "A investigação exige aprovação antes de gerar o relatório.")
    await validate_references(session, principal.tenant_id, inv.id, [])
    report_id = uuid.uuid5(uuid.NAMESPACE_URL, f"semperfi:report:{principal.tenant_id}:{inv.id}:{body.request_id}")
    existing = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id))
    if existing:
        return receipt(existing)
    async def rows(model):
        query = select(model).where(model.tenant_id == principal.tenant_id, model.investigation_id == inv.id)
        if model is Entity:
            query = query.where(Entity.verification_status != "deleted")
        return list((await session.scalars(query.order_by(model.created_at, model.id))).all())
    entities, findings, runs, evidences = await rows(Entity), await rows(Finding), await rows(ConnectorRun), await rows(Evidence)
    entity_by_id = {item.id: item for item in entities}
    run_by_id = {item.id: item for item in runs}
    evidence_ids = [str(item.id) for item in evidences]
    for finding in findings:
        # A legacy finding without a collection remains explicitly unlinked.
        # A recorded link must still point to the same authorized investigation.
        run = run_by_id.get(finding.connector_run_id)
        if finding.connector_run_id and (
            run is None or run.status != "completed" or run.error_code
            or (finding.entity_id and run.target_entity_id and finding.entity_id != run.target_entity_id)
        ):
            raise HTTPException(409, "Há achado com referência de coleta indisponível. Revise o vínculo antes de emitir o relatório.")
        if finding.evidence_id and str(finding.evidence_id) not in evidence_ids:
            raise HTTPException(409, "Há achado com evidência indisponível nesta investigação.")
    relations = [item for item in await rows(EntityRelation)
                 if item.source_entity_id in entity_by_id and item.target_entity_id in entity_by_id]
    scopes = list((await session.scalars(select(InvestigationScope).where(
        InvestigationScope.investigation_id == inv.id,
    ).order_by(InvestigationScope.scope_code, InvestigationScope.id))).all())
    summary = {
        "object": inv.objective, "purpose": inv.purpose,
        "methodology": "Organização dos registros persistidos desta investigação; sem inferências automáticas ou confirmação de fatos não revisados.",
        "technical_conclusion": "Compilação documental para revisão humana. Classificações e validações reproduzem os registros salvos; a aprovação do relatório não confirma fatos ainda não validados.",
        "limitations": ["Resultados públicos não comprovam, isoladamente, identidade ou conduta.", "Aprovação e preservação do PDF são etapas separadas da criação do rascunho."],
        "investigation": {"id": str(inv.id), "title": inv.title, "hypothesis": inv.hypothesis, "priority": inv.priority,
            "responsible": inv.operational_owner, "deadline": inv.deadline.isoformat() if inv.deadline else None,
            "questions": inv.questions, "expected_result": inv.expected_result,
            "legal_basis": inv.legal_basis, "authorization_reference": inv.authorization_reference,
            "proportionality_assessment": inv.proportionality_assessment, "risk_level": inv.risk_level,
            "scope_codes": [{"code": item.scope_code, "approved": item.approved} for item in scopes]},
        "entities": [{"id": str(item.id), "name": item.display_name, "type": item.entity_type, "aliases": item.aliases,
            "verification": item.verification_status, "confidence": item.confidence} for item in entities],
        "relations": [{"id": str(item.id), "source_entity_id": str(item.source_entity_id),
            "source_name": entity_by_id[item.source_entity_id].display_name,
            "target_entity_id": str(item.target_entity_id), "target_name": entity_by_id[item.target_entity_id].display_name,
            "type": item.relation_type, "confidence": item.confidence, "reviewed": item.human_validated,
            "provenance": item.provenance} for item in relations],
        "findings": [{"id": str(item.id), "title": item.title, "statement": item.statement, "classification": item.classification,
            "source": item.source_name, "source_url": item.source_url, "reviewed": item.human_validated,
            "entity_id": str(item.entity_id) if item.entity_id in entity_by_id else None,
            "evidence_id": str(item.evidence_id) if item.evidence_id else None,
            "method": item.method, "collected_at": item.collected_at.isoformat(),
            "reliability_score": item.reliability_score,
            "connector_run_id": str(item.connector_run_id) if item.connector_run_id else None, "limitations": item.limitations} for item in findings],
        "collections": [{"id": str(item.id), "source": item.connector_id, "status": item.status,
            "created_at": item.created_at.isoformat(), "updated_at": item.updated_at.isoformat(), "purpose": item.purpose,
            "response_hash": item.response_hash, "limitations": item.limitations} for item in runs],
        "evidence": [{"id": str(item.id), "filename": item.original_filename, "sha256": item.sha256,
            "status": item.validation_status, "collected_at": item.collected_at.isoformat()} for item in evidences],
    }
    title = f"Relatório investigativo — {inv.title}"[:255]
    report = Report(id=report_id, tenant_id=principal.tenant_id, investigation_id=inv.id,
        report_type="investigative", title=title, status="DRAFT", version=1, body=summary,
        evidence_ids=evidence_ids, content_hash=canonical_hash({"title": title, "body": summary, "evidence_ids": evidence_ids}))
    try:
        async with session.begin_nested():
            session.add(report)
            await session.flush()
    except IntegrityError:
        report = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id))
        if report is None:
            raise
        return receipt(report)
    await append_audit(session, principal, request, action="report.create", resource_type="report", resource_id=report.id,
        correlation_id=cid, metadata_safe={"report_type": "investigative", "source": "database"})
    await session.commit()
    return receipt(report)
