from __future__ import annotations

import hashlib
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.providers import (
    OUTPUT_LIMITATIONS,
    PROMPT_VERSION,
    ProviderUnavailable,
    get_agent_provider,
    get_ai_settings,
)
from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import AgentRunCreate, ReportCreate
from app.audit import append_audit
from app.db import get_db
from app.evidence import evidence_service
from app.models import AgentRun, Report
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.reports import build_pdf_bytes, canonical_hash
from app.security import Principal, get_current_principal, require_recent_mfa
from app.services.agent_runs import normalize_input, set_tenant_context, validate_references
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
    payload = normalize_input(body.input_safe)
    await validate_references(session, principal.tenant_id, body.investigation_id, [uuid.UUID(value) for value in payload["evidence_ids"]])
    try: get_agent_provider()
    except ProviderUnavailable as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc
    item = AgentRun(tenant_id=principal.tenant_id, investigation_id=body.investigation_id, agent_type=body.agent_type, status="queued", input_safe=payload, output=None, model_name=None, model_version=None, prompt_version=PROMPT_VERSION, requires_human_review=True, limitations=OUTPUT_LIMITATIONS)
    session.add(item); await session.flush()
    await append_audit(session, principal, request, action="agent.run.queue", resource_type="agent_run", resource_id=item.id, correlation_id=cid, metadata_safe={"agent_type": body.agent_type})
    await session.commit()  # Workers must be able to read the run before it is published.
    try: job = run_supervised_agent.apply_async(args=[str(item.id), body.agent_type, str(principal.tenant_id)])
    except Exception as exc:
        await set_tenant_context(session, principal.tenant_id)
        await session.execute(update(AgentRun).where(AgentRun.id == item.id, AgentRun.tenant_id == principal.tenant_id, AgentRun.status == "queued").values(status="failed", output={"error_code": "QUEUE_UNAVAILABLE", "message": "A fila de agentes está indisponível. Inicie uma nova execução após restabelecer o serviço."}))
        await session.commit()
        raise HTTPException(status_code=503, detail={"agent_run_id": str(item.id), "status": "failed", "message": "Não foi possível enviar a execução à fila de agentes."}) from exc
    return {"agent_run_id": item.id, "job_id": str(job.id), "status": "queued", "requires_human_review": True}


def _agent_payload(item: AgentRun) -> dict:
    return {"id": item.id, "investigation_id": item.investigation_id, "agent_type": item.agent_type,
            "status": item.status, "input_safe": item.input_safe, "output": item.output,
            "model_name": item.model_name, "model_version": item.model_version, "prompt_version": item.prompt_version,
            "requires_human_review": item.requires_human_review, "limitations": item.limitations,
            "created_at": item.created_at, "updated_at": item.updated_at}


def _agent_read_role(principal: Principal) -> None:
    if not principal.has_any_role("administrator", "manager", "lawyer", "investigator", "analyst", "auditor"):
        raise HTTPException(status_code=403, detail="Perfil não autorizado para consultar agentes.")


@router.get("/agents/status")
async def agent_status(principal: Principal = Depends(get_current_principal)):
    _agent_read_role(principal)
    settings = get_ai_settings()
    return {"provider": settings.ai_provider, "enabled": settings.ai_provider == "ollama" and bool(settings.ollama_model), "model": settings.ollama_model or None, "requires_human_review": True}


@router.get("/agents/runs")
async def list_agent_runs(request: Request, investigation_id: uuid.UUID | None = None, limit: int = Query(default=100, ge=1, le=200), session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _agent_read_role(principal)
    cid, _ = await _policy(session, principal, request, PolicyContext(action="agent.read"))
    query = select(AgentRun).where(AgentRun.tenant_id == principal.tenant_id)
    if investigation_id: query = query.where(AgentRun.investigation_id == investigation_id)
    rows = list((await session.scalars(query.order_by(AgentRun.created_at.desc()).limit(limit))).all())
    await append_audit(session, principal, request, action="agent.read", resource_type="agent_run", resource_id=None, correlation_id=cid)
    await session.commit()
    return [_agent_payload(row) for row in rows]


@router.get("/agents/runs/{run_id}")
async def get_agent_run(run_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _agent_read_role(principal)
    cid, _ = await _policy(session, principal, request, PolicyContext(action="agent.read"))
    item = await session.scalar(select(AgentRun).where(AgentRun.id == run_id, AgentRun.tenant_id == principal.tenant_id))
    if not item: raise HTTPException(status_code=404, detail="Execução não encontrada.")
    await append_audit(session, principal, request, action="agent.read", resource_type="agent_run", resource_id=item.id, correlation_id=cid)
    await session.commit()
    return _agent_payload(item)


@router.post("/reports", status_code=status.HTTP_201_CREATED)
async def create_report(body: ReportCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, decision = await _policy(session, principal, request, PolicyContext(action="report.generate", purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, investigation_id=body.investigation_id, scope_codes={"proof_digital"}))
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL: raise HTTPException(status_code=202, detail={"status": "approval_required", "policy_code": decision.code})
    await validate_references(session, principal.tenant_id, body.investigation_id, body.evidence_ids)
    evidence_ids = list(dict.fromkeys(str(value) for value in body.evidence_ids))
    report = Report(tenant_id=principal.tenant_id, investigation_id=body.investigation_id, report_type=body.report_type, title=body.title, status="DRAFT", version=1, body=body.body, evidence_ids=evidence_ids, content_hash=canonical_hash({"title": body.title, "body": body.body, "evidence_ids": evidence_ids}))
    session.add(report); await session.flush(); await append_audit(session, principal, request, action="report.create", resource_type="report", resource_id=report.id, correlation_id=cid, metadata_safe={"report_type": body.report_type}); await session.commit()
    return {"report_id": report.id, "status": report.status, "content_hash": report.content_hash}


@router.post("/reports/{report_id}/approve")
async def approve_report(report_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    if not principal.has_any_role("manager", "administrator", "lawyer"): raise HTTPException(status_code=403, detail="Perfil sem competência para aprovação final.")
    cid, _ = await _policy(session, principal, request, PolicyContext(action="report.approve", requires_mfa=False))
    report = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id).with_for_update())
    if not report: raise HTTPException(status_code=404, detail="Relatório não encontrado.")
    if report.status == "FINAL":
        if not report.storage_key or not report.storage_version_id:
            raise HTTPException(status_code=409, detail="O relatório final não possui uma versão preservada disponível.")
        return {"report_id": report.id, "status": report.status, "version": report.version}
    if report.status != "DRAFT": raise HTTPException(status_code=409, detail="O relatório não está disponível para aprovação.")
    try: evidence_ids = [uuid.UUID(value) for value in report.evidence_ids]
    except (ValueError, TypeError) as exc: raise HTTPException(status_code=409, detail="Relatório contém referência de evidência inválida.") from exc
    evidence = await validate_references(session, principal.tenant_id, report.investigation_id, evidence_ids, preserved=True)
    manifest = {"report_id": str(report.id), "version": report.version, "content_hash": report.content_hash, "evidence": [{"id": str(item.id), "sha256": item.sha256, "storage_version_id": item.storage_version_id} for item in evidence]}
    try:
        pdf = build_pdf_bytes(report.title, report.body, manifest)
        stored = evidence_service.store_bytes(pdf, tenant_id=str(report.tenant_id), investigation_id=str(report.investigation_id) if report.investigation_id else None, sha256=hashlib.sha256(pdf).hexdigest(), filename=f"report-{report.id}.pdf")
        if not stored.get("key") or not stored.get("version_id"):
            raise ValueError("O armazenamento não retornou uma versão preservada.")
    except Exception as exc: raise HTTPException(status_code=503, detail="Geração ou armazenamento seguro do relatório indisponível.") from exc
    report.status, report.approved_by, report.approved_at = "FINAL", principal.user_id, datetime.now(UTC)
    report.storage_key, report.storage_version_id = stored["key"], stored["version_id"]
    await append_audit(session, principal, request, action="report.approve", resource_type="report", resource_id=report.id, correlation_id=cid, metadata_safe={"version": report.version, "evidence_count": len(evidence)})
    await session.commit(); return {"report_id": report.id, "status": report.status, "version": report.version}


@router.get("/reports/{report_id}/download")
async def download_report(report_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="data.export", requires_mfa=False))
    report = await session.scalar(select(Report).where(Report.id == report_id, Report.tenant_id == principal.tenant_id))
    if not report or report.status != "FINAL" or not report.storage_key or not report.storage_version_id: raise HTTPException(status_code=404, detail="Relatório final não disponível.")
    try: url = evidence_service.presigned_download(evidence_service.settings.s3_bucket_evidence, report.storage_key, report.storage_version_id)
    except Exception as exc: raise HTTPException(status_code=503, detail="Link temporário indisponível.") from exc
    await append_audit(session, principal, request, action="report.download", resource_type="report", resource_id=report.id, correlation_id=cid); await session.commit(); return {"url": url, "expires_in_seconds": evidence_service.settings.s3_presign_expires_seconds}
