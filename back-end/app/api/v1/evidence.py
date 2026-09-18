from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import EvidenceCreateResponse, LegalHoldRequest
from app.audit import append_audit
from app.db import get_db
from app.evidence import evidence_service
from app.models import Evidence, EvidenceEvent, LegalHold
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.security import Principal, get_current_principal, require_recent_mfa
from app.services.evidence_ledger import append_evidence_event

router = APIRouter(tags=["Evidence and chain of custody"])


async def _evidence(session: AsyncSession, tenant_id: uuid.UUID, evidence_id: uuid.UUID) -> Evidence:
    item = await session.scalar(select(Evidence).where(Evidence.id == evidence_id, Evidence.tenant_id == tenant_id))
    if not item: raise HTTPException(status_code=404, detail="Evidência não encontrada.")
    return item


async def _policy(session: AsyncSession, principal: Principal, request: Request, context: PolicyContext):
    cid = correlation_id(request); decision = await policy_engine.evaluate(session, principal, context, cid)
    if decision.effect in {PolicyEffect.DENY, PolicyEffect.REQUIRE_MFA, PolicyEffect.RETENTION_BLOCKED}: raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    return cid, decision


@router.get("/evidences")
async def list_evidences(request: Request, investigation_id: uuid.UUID | None = None, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.read"))
    query = select(Evidence).where(Evidence.tenant_id == principal.tenant_id)
    if investigation_id:
        query = query.where(Evidence.investigation_id == investigation_id)
    rows = list((await session.scalars(query.order_by(Evidence.collected_at.desc()))).all())
    await append_audit(session, principal, request, action="evidence.read", resource_type="evidence", resource_id=None, correlation_id=cid)
    await session.commit()
    return [
        {
            "id": row.id,
            "investigation_id": row.investigation_id,
            "original_filename": row.original_filename,
            "mime_type": row.mime_type,
            "size_bytes": row.size_bytes,
            "sha256": row.sha256,
            "source_type": row.source_type,
            "source_url": row.source_url,
            "collection_method": row.collection_method,
            "collector_id": row.collector_id,
            "collected_at": row.collected_at,
            "storage_bucket": row.storage_bucket,
            "storage_key": row.storage_key,
            "storage_version_id": row.storage_version_id,
            "retention_mode": row.retention_mode,
            "retain_until": row.retain_until,
            "legal_hold": row.legal_hold,
            "scan_status": row.scan_status,
            "validation_status": row.validation_status,
            "metadata": row.metadata_json,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


@router.get("/evidences/{evidence_id}/events")
async def list_evidence_events(evidence_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.read"))
    await _evidence(session, principal.tenant_id, evidence_id)
    rows = list((await session.scalars(select(EvidenceEvent).where(EvidenceEvent.evidence_id == evidence_id, EvidenceEvent.tenant_id == principal.tenant_id).order_by(EvidenceEvent.created_at.asc()))).all())
    await append_audit(session, principal, request, action="evidence.events.read", resource_type="evidence_event", resource_id=str(evidence_id), correlation_id=cid)
    await session.commit()
    return [
        {
            "id": row.id,
            "evidence_id": row.evidence_id,
            "actor_id": row.actor_id,
            "event_type": row.event_type,
            "details": row.details,
            "previous_hash": row.previous_hash,
            "event_hash": row.event_hash,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.post("/evidences/uploads", response_model=EvidenceCreateResponse, status_code=status.HTTP_201_CREATED)
async def upload_evidence(
    request: Request, file: UploadFile = File(...), investigation_id: uuid.UUID | None = Form(None), purpose: str = Form(...), legal_basis: str = Form(...), authorization_reference: str = Form(...), collection_method: str = Form("manual_upload"), source_url: str | None = Form(None), source_name: str | None = Form(None), source_type: str | None = Form(None), payload_preview: str | None = Form(None), session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)
):
    cid, decision = await _policy(session, principal, request, PolicyContext(action="evidence.upload", purpose=purpose, legal_basis=legal_basis, authorization_reference=authorization_reference, investigation_id=investigation_id, scope_codes={"proof_digital"}))
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL: raise HTTPException(status_code=202, detail={"policy_code": decision.code, "reason": decision.reason, "status": "approval_required"})
    try: staged = await evidence_service.stage_upload(file)
    except (ValueError, RuntimeError) as exc: raise HTTPException(status_code=422, detail="Arquivo rejeitado pela política de ingestão.") from exc
    metadata = {**staged.metadata, "staged_path": str(staged.path)}
    if source_name:
        metadata["display_name"] = source_name
    if payload_preview:
        metadata["payload_preview"] = payload_preview[:2000]
    item = Evidence(tenant_id=principal.tenant_id, investigation_id=investigation_id, original_filename=staged.original_filename, mime_type=staged.detected_mime, size_bytes=staged.size_bytes, sha256=staged.sha256, source_type=source_type or "manual_upload", source_url=source_url, collection_method=collection_method, collector_id=principal.user_id, collected_at=datetime.now(UTC), scan_status="clean", validation_status="pending", metadata_json=metadata)
    session.add(item); await session.flush()
    await append_evidence_event(session, evidence_id=item.id, tenant_id=principal.tenant_id, actor_id=principal.user_id, event_type="upload_staged", details={"sha256": item.sha256, "mime_type": item.mime_type, "size_bytes": item.size_bytes})
    await append_audit(session, principal, request, action="evidence.upload", resource_type="evidence", resource_id=item.id, correlation_id=cid, metadata_safe={"mime_type": item.mime_type, "size_bytes": item.size_bytes})
    await session.commit(); return EvidenceCreateResponse(evidence_id=item.id, status="staged", sha256=item.sha256, mime_type=item.mime_type, size_bytes=item.size_bytes)


@router.post("/evidences/{evidence_id}/finalize")
async def finalize_evidence(evidence_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.finalize")); item = await _evidence(session, principal.tenant_id, evidence_id)
    staged_path = item.metadata_json.get("staged_path") if item.metadata_json else None
    if not staged_path: raise HTTPException(status_code=409, detail="Evidência não possui upload pendente.")
    from pathlib import Path
    path = Path(staged_path)
    if not path.exists(): raise HTTPException(status_code=409, detail="Área temporária indisponível; reenvie o arquivo.")
    from app.evidence.service import StagedEvidence
    staged = StagedEvidence(upload_id=path.parent.name, path=path, original_filename=item.original_filename, detected_mime=item.mime_type, size_bytes=item.size_bytes, sha256=item.sha256, metadata=item.metadata_json)
    try: stored = evidence_service.store_original(staged, str(item.tenant_id), str(item.investigation_id) if item.investigation_id else None)
    except Exception as exc: raise HTTPException(status_code=503, detail="Cofre de evidências indisponível.") from exc
    item.storage_bucket, item.storage_key, item.storage_version_id, item.storage_etag = stored["bucket"], stored["key"], stored["version_id"], stored["etag"]
    item.retention_mode, item.retain_until, item.validation_status = evidence_service.settings.s3_object_lock_mode, stored["retain_until"], "preserved"
    metadata = dict(item.metadata_json); metadata.pop("staged_path", None); item.metadata_json = metadata
    evidence_service.cleanup_stage(staged)
    await append_evidence_event(session, evidence_id=item.id, tenant_id=item.tenant_id, actor_id=principal.user_id, event_type="object_lock_stored", details={"bucket": item.storage_bucket, "key": item.storage_key, "version_id": item.storage_version_id, "retain_until": item.retain_until.isoformat() if item.retain_until else None})
    await append_audit(session, principal, request, action="evidence.finalize", resource_type="evidence", resource_id=item.id, correlation_id=cid, metadata_safe={"object_lock_mode": item.retention_mode})
    await session.commit(); return {"id": item.id, "status": item.validation_status, "version_id": item.storage_version_id}


@router.post("/evidences/{evidence_id}/verify")
async def verify_evidence(evidence_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.verify")); item = await _evidence(session, principal.tenant_id, evidence_id)
    if not item.storage_bucket or not item.storage_key:
        raise HTTPException(status_code=409, detail="Evidência ainda não foi preservada no cofre.")
    try:
        valid = evidence_service.verify_remote_hash(item.storage_bucket, item.storage_key, item.storage_version_id, item.sha256)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Verificação remota indisponível.") from exc
    item.validation_status = "validated" if valid else "integrity_failed"
    await append_evidence_event(session, evidence_id=item.id, tenant_id=item.tenant_id, actor_id=principal.user_id, event_type="integrity_check", details={"remote_hash_valid": valid, "sha256": item.sha256})
    await append_audit(session, principal, request, action="evidence.verify", resource_type="evidence", resource_id=item.id, correlation_id=cid); await session.commit()
    return {"evidence_id": item.id, "manifest_valid": valid, "sha256": item.sha256, "storage_version_id": item.storage_version_id}


@router.post("/evidences/{evidence_id}/attest")
async def attest_evidence(evidence_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.verify"))
    item = await _evidence(session, principal.tenant_id, evidence_id)
    item.validation_status = "validated"
    await append_evidence_event(session, evidence_id=item.id, tenant_id=item.tenant_id, actor_id=principal.user_id, event_type="human_attestation", details={"reviewer_name": principal.display_name})
    await append_audit(session, principal, request, action="evidence.attest", resource_type="evidence", resource_id=item.id, correlation_id=cid, metadata_safe={"reviewer_name": principal.display_name})
    await session.commit()
    return {"evidence_id": item.id, "status": item.validation_status, "reviewer_name": principal.display_name}


@router.post("/evidences/{evidence_id}/legal-hold", status_code=status.HTTP_202_ACCEPTED)
async def request_legal_hold(evidence_id: uuid.UUID, body: LegalHoldRequest, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.legal_hold", requires_mfa=False)); item = await _evidence(session, principal.tenant_id, evidence_id)
    hold = LegalHold(evidence_id=item.id, tenant_id=item.tenant_id, requested_by=principal.user_id, reason=body.reason, active=False)
    session.add(hold); await session.flush(); await append_evidence_event(session, evidence_id=item.id, tenant_id=item.tenant_id, actor_id=principal.user_id, event_type="legal_hold_requested", details={"hold_id": str(hold.id)})
    await append_audit(session, principal, request, action="evidence.legal_hold.request", resource_type="evidence", resource_id=item.id, correlation_id=cid); await session.commit(); return {"hold_id": hold.id, "status": "pending_second_confirmation"}


@router.post("/evidences/{evidence_id}/legal-hold/{hold_id}/confirm")
async def confirm_legal_hold(evidence_id: uuid.UUID, hold_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    if not principal.has_any_role("manager", "administrator", "auditor"): raise HTTPException(status_code=403, detail="Perfil sem competência para confirmar legal hold.")
    cid, _ = await _policy(session, principal, request, PolicyContext(action="evidence.legal_hold", requires_mfa=False)); item = await _evidence(session, principal.tenant_id, evidence_id)
    hold = await session.scalar(select(LegalHold).where(LegalHold.id == hold_id, LegalHold.evidence_id == item.id, LegalHold.tenant_id == principal.tenant_id))
    if not hold or hold.requested_by == principal.user_id: raise HTTPException(status_code=409, detail="Confirmação exige segundo usuário habilitado.")
    if not item.storage_bucket or not item.storage_key: raise HTTPException(status_code=409, detail="Evidência ainda não foi preservada no cofre.")
    try: evidence_service.apply_legal_hold(item.storage_bucket, item.storage_key, item.storage_version_id, True)
    except Exception as exc: raise HTTPException(status_code=503, detail="Não foi possível aplicar legal hold no cofre.") from exc
    hold.confirmed_by, hold.active, item.legal_hold = principal.user_id, True, True
    await append_evidence_event(session, evidence_id=item.id, tenant_id=item.tenant_id, actor_id=principal.user_id, event_type="legal_hold_confirmed", details={"hold_id": str(hold.id)})
    await append_audit(session, principal, request, action="evidence.legal_hold.confirm", resource_type="evidence", resource_id=item.id, correlation_id=cid); await session.commit(); return {"hold_id": hold.id, "status": "active"}
