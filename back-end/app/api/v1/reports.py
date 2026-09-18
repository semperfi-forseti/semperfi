from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents import safe_agent_output
from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import AgentRunCreate, ReportCreate
from app.audit import append_audit
from app.db import get_db
from app.evidence import evidence_service
from app.models import AgentRun, Evidence, Report
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.reports import build_pdf_bytes, canonical_hash
from app.security import Principal, get_current_principal, require_recent_mfa
from app.workers.tasks import run_supervised_agent

router = APIRouter(tags=["Reports and supervised agents"])


async def _policy(session: AsyncSession, principal: Principal, request: Request, context: PolicyContext):
    cid = correlation_id(request); decision = await policy_engine.evaluate(session, principal, context, cid)
    if decision.effect in {PolicyEffect.DENY, PolicyEffect.REQUIRE_MFA}: raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    return cid, decision


@router.get("/reports")
async def list_reports(request: Request, investigation_id: uuid.UUID | None = None, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="report.read"))
    query = select(Report).where(Report.tenant_id == principal.tenant_id)
    if investigation_id:
        query = query.where(Report.investigation_id == investigation_id)
    rows = list((await session.scalars(query.order_by(Report.created_at.desc()))).all())
    await append_audit(session, principal, request, action="report.read", resource_type="report", resource_id=None, correlation_id=cid)
    await session.commit()
    return [
        {
            "id": row.id,
            "investigation_id": row.investigation_id,
            "report_type": row.report_type,
            "title": row.title,
            "status": row.status,
            "version": row.version,
            "body": row.body,
            "evidence_ids": row.evidence_ids,
            "content_hash": row.content_hash,
            "storage_key": row.storage_key,
            "storage_version_id": row.storage_version_id,
            "approved_by": row.approved_by,
            "approved_at": row.approved_at,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


@router.post("/agents/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_agent_run(body: AgentRunCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, decision = await _policy(session, principal, request, PolicyContext(action="agent.run", purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, investigation_id=body.investigation_id, scope_codes={"proof_digital"}))
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL: raise HTTPException(status_code=202, detail={"status": "approval_required", "policy_code": decision.code})
    item = AgentRun(tenant_id=principal.tenant_id, investigation_id=body.investigation_id, agent_type=body.agent_type, status="queued", input_safe=body.input_safe, output=safe_agent_output(body.agent_type), model_name=None, model_version=None, prompt_version="v1", requires_human_review=True, limitations=["Agente não executa conectores externos diretamente.", "Aprovação humana obrigatória."])
    session.add(item); await session.flush(); job = run_supervised_agent.delay(str(item.id), body.agent_type)
    await append_audit(session, principal, request, action="agent.run.queue", resource_type="agent_run", resource_id=item.id, correlation_id=cid, metadata_safe={"agent_type": body.agent_type}); await session.commit()
    return {"agent_run_id": item.id, "job_id": str(job.id), "status": "queued", "requires_human_review": True}


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def create_report(body: ReportCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, decision = await _policy(session, principal, request, PolicyContext(action="report.generate", purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, investigation_id=body.investigation_id, scope_codes={"proof_digital"}))
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL: raise HTTPException(status_code=202, detail={"status": "approval_required", "policy_code": decision.code})
    report = Report(tenant_id=principal.tenant_id, investigation_id=body.investigation_id, report_type=body.report_type, title=body.title, status="DRAFT", version=1, body=body.body, evidence_ids=[str(x) for x in body.evidence_ids], content_hash=canonical_hash({"title": body.title, "body": body.body, "evidence_ids": [str(x) for x in body.evidence_ids]}))
    session.add(report); await session.flush(); await append_audit(session, principal, request, action="report.create", resource_type="report", resource_id=report.id, correlation_id=cid, metadata_safe={"report_type": body.report_type}); await session.commit()
    return {"report_id": report.id, "status": report.status, "content_hash": report.content_hash}


@router.post("/reports/{report_id}/approve")
async def approve_report(report_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    if not principal.has_any_role("manager", "administrator", "lawyer"): raise HTTPException(status_code=403, detail="Perfil sem competência para aprovação final.")
    cid, _ = await _policy(session, principal, request, PolicyContext(action="report.approve", requires_mfa=False))
    report = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id))
    if not report: raise HTTPException(status_code=404, detail="Relatório não encontrado.")
    evidence = list((await session.scalars(select(Evidence).where(Evidence.id.in_([uuid.UUID(x) for x in report.evidence_ids]) if report.evidence_ids else False))).all()) if report.evidence_ids else []
    if len(evidence) != len(report.evidence_ids) or any(item.validation_status not in {"preserved", "validated"} for item in evidence):
        raise HTTPException(status_code=409, detail="Relatório contém evidência não preservada ou não validada.")
    manifest = {"report_id": str(report.id), "version": report.version, "content_hash": report.content_hash, "evidence": [{"id": str(item.id), "sha256": item.sha256, "storage_version_id": item.storage_version_id} for item in evidence]}
    try:
        pdf = build_pdf_bytes(report.title, report.body, manifest)
        stored = evidence_service.store_bytes(pdf, tenant_id=str(report.tenant_id), investigation_id=str(report.investigation_id) if report.investigation_id else None, sha256=canonical_hash(manifest), filename=f"report-{report.id}.pdf")
    except Exception as exc: raise HTTPException(status_code=503, detail="Geração ou armazenamento seguro do relatório indisponível.") from exc
    report.status, report.approved_by, report.approved_at = "FINAL", principal.user_id, datetime.now(UTC)
    report.storage_key, report.storage_version_id = stored["key"], stored["version_id"]
    await append_audit(session, principal, request, action="report.approve", resource_type="report", resource_id=report.id, correlation_id=cid, metadata_safe={"version": report.version, "evidence_count": len(evidence)})
    await session.commit(); return {"report_id": report.id, "status": report.status, "version": report.version}


@router.get("/reports/{report_id}/download")
async def download_report(report_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="data.export", requires_mfa=False))
    report = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id))
    if not report or report.status != "FINAL" or not report.storage_key: raise HTTPException(status_code=404, detail="Relatório final não disponível.")
    try: url = evidence_service.presigned_download(evidence_service.settings.s3_bucket_evidence, report.storage_key, report.storage_version_id)
    except Exception as exc: raise HTTPException(status_code=503, detail="Link temporário indisponível.") from exc
    await append_audit(session, principal, request, action="report.download", resource_type="report", resource_id=report.id, correlation_id=cid); await session.commit(); return {"url": url, "expires_in_seconds": evidence_service.settings.s3_presign_expires_seconds}
