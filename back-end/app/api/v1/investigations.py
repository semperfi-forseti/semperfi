from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import (
    ConnectorRunCreate,
    EntityCreate,
    FindingCreate,
    FindingUpdate,
    InvestigationCreate,
    InvestigationStatusUpdate,
    RelationCreate,
)
from app.audit import append_audit
from app.core.config import get_settings
from app.db import get_db
from app.models import (
    ConnectorRun,
    Entity,
    EntityIdentifier,
    EntityRelation,
    Finding,
    Investigation,
    InvestigationScope,
    JobExecution,
)
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.security import Principal, cipher, get_current_principal, rate_limiter
from app.services.connector_runs import execute_connector_run, request_hash
from app.services.outbox import enqueue_outbox

router = APIRouter(tags=["Investigations and OSINT"])
settings = get_settings()


async def _decision(session: AsyncSession, principal: Principal, request: Request, context: PolicyContext):
    cid = correlation_id(request); decision = await policy_engine.evaluate(session, principal, context, cid)
    if decision.effect == PolicyEffect.DENY: raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    if decision.effect == PolicyEffect.REQUIRE_MFA: raise HTTPException(status_code=403, detail={"policy_code": decision.code, "reason": decision.reason})
    return cid, decision


async def _investigation(session: AsyncSession, tenant_id: uuid.UUID, investigation_id: uuid.UUID) -> Investigation:
    item = await session.scalar(select(Investigation).where(Investigation.id == investigation_id, Investigation.tenant_id == tenant_id))
    if not item: raise HTTPException(status_code=404, detail="Investigação não encontrada.")
    return item


def _serialize_finding(item: Finding) -> dict:
    return {
        "id": item.id,
        "investigation_id": item.investigation_id,
        "entity_id": item.entity_id,
        "evidence_id": item.evidence_id,
        "classification": item.classification,
        "title": item.title,
        "statement": item.statement,
        "source_name": item.source_name,
        "source_url": item.source_url,
        "method": item.method,
        "collected_at": item.collected_at,
        "reliability_score": item.reliability_score,
        "limitations": item.limitations,
        "human_validated": item.human_validated,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


@router.get("/investigations")
async def list_investigations(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="investigation.list"))
    rows = list((await session.scalars(select(Investigation).where(Investigation.tenant_id == principal.tenant_id, Investigation.status != "deleted").order_by(Investigation.created_at.desc()))).all())
    scopes = list((await session.scalars(select(InvestigationScope).where(InvestigationScope.investigation_id.in_([row.id for row in rows]) if rows else False))).all()) if rows else []
    scopes_by_investigation: dict[uuid.UUID, list[str]] = {}
    for scope in scopes:
        scopes_by_investigation.setdefault(scope.investigation_id, []).append(scope.scope_code)
    await append_audit(session, principal, request, action="investigation.list", resource_type="investigation", resource_id=None, correlation_id=cid)
    await session.commit()
    return [
        {
            "id": row.id,
            "title": row.title,
            "category": row.category,
            "objective": row.objective,
            "hypothesis": row.hypothesis,
            "purpose": row.purpose,
            "legal_basis": row.legal_basis,
            "authorization_reference": row.authorization_reference,
            "proportionality_assessment": row.proportionality_assessment,
            "risk_level": row.risk_level,
            "status": row.status,
            "client_id": row.client_id,
            "process_id": row.process_id,
            "retention_until": row.retention_until,
            "scope_codes": scopes_by_investigation.get(row.id, []),
            "owner_id": row.owner_id,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }
        for row in rows
    ]


@router.post("/investigations", status_code=status.HTTP_201_CREATED)
async def create_investigation(body: InvestigationCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, decision = await _decision(session, principal, request, PolicyContext(action="investigation.create", purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, risk_level=body.risk_level, scope_codes=set(body.scope_codes)))
    item = Investigation(tenant_id=principal.tenant_id, owner_id=principal.user_id, title=body.title, category=body.category, objective=body.objective, hypothesis=body.hypothesis, purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, proportionality_assessment=body.proportionality_assessment, risk_level=body.risk_level, client_id=body.client_id, process_id=body.process_id, retention_until=body.retention_until, status="aguardando_aprovacao" if decision.effect == PolicyEffect.REQUIRE_APPROVAL else "em_coleta")
    session.add(item); await session.flush()
    for scope in body.scope_codes: session.add(InvestigationScope(investigation_id=item.id, scope_code=scope, approved=decision.effect == PolicyEffect.ALLOW))
    await append_audit(session, principal, request, action="investigation.create", resource_type="investigation", resource_id=item.id, correlation_id=cid, metadata_safe={"category": body.category, "risk_level": body.risk_level})
    await session.commit(); return {"id": item.id, "status": item.status, "policy_effect": decision.effect}


@router.get("/investigations/{investigation_id}")
async def get_investigation(investigation_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="investigation.read")); inv = await _investigation(session, principal.tenant_id, investigation_id)
    entities = list((await session.scalars(select(Entity).where(Entity.investigation_id == inv.id))).all())
    relations = list((await session.scalars(select(EntityRelation).where(EntityRelation.investigation_id == inv.id))).all())
    await append_audit(session, principal, request, action="investigation.read", resource_type="investigation", resource_id=inv.id, correlation_id=cid); await session.commit()
    return {"id": inv.id, "title": inv.title, "status": inv.status, "objective": inv.objective, "purpose": inv.purpose, "legal_basis": inv.legal_basis, "risk_level": inv.risk_level, "entities": [{"id": x.id, "type": x.entity_type, "name": x.display_name, "confidence": x.confidence} for x in entities], "relations": [{"id": x.id, "source_entity_id": x.source_entity_id, "target_entity_id": x.target_entity_id, "type": x.relation_type, "confidence": x.confidence, "human_validated": x.human_validated} for x in relations]}


@router.post("/investigations/{investigation_id}/entities", status_code=status.HTTP_201_CREATED)
async def create_entity(investigation_id: uuid.UUID, body: EntityCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="entity.create")); await _investigation(session, principal.tenant_id, investigation_id)
    entity = Entity(tenant_id=principal.tenant_id, investigation_id=investigation_id, entity_type=body.entity_type, display_name=body.display_name, normalized_name=body.normalized_name, verification_status=body.verification_status, confidence=body.confidence, notes=body.notes)
    session.add(entity); await session.flush()
    for identifier in body.identifiers:
        value = identifier.get("value", "")
        if not value: continue
        session.add(EntityIdentifier(entity_id=entity.id, identifier_type=identifier.get("type", "generic"), value_ciphertext=cipher.encrypt(value) or "", value_fingerprint=cipher.fingerprint(value) or "", is_primary=bool(identifier.get("primary", False))))
    await append_audit(session, principal, request, action="entity.create", resource_type="entity", resource_id=entity.id, correlation_id=cid)
    await session.commit()
    return {"id": entity.id, "verification_status": entity.verification_status, "confidence": entity.confidence}


@router.post("/investigations/{investigation_id}/relations", status_code=status.HTTP_201_CREATED)
async def create_relation(investigation_id: uuid.UUID, body: RelationCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="relation.create")); await _investigation(session, principal.tenant_id, investigation_id)
    relation = EntityRelation(tenant_id=principal.tenant_id, investigation_id=investigation_id, **body.model_dump(), human_validated=False)
    session.add(relation); await session.flush(); await append_audit(session, principal, request, action="relation.create", resource_type="entity_relation", resource_id=relation.id, correlation_id=cid, metadata_safe={"confidence": body.confidence}); await session.commit(); return {"id": relation.id, "human_validated": False}


@router.delete("/investigations/{investigation_id}")
async def delete_investigation(investigation_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="investigation.delete"))
    inv = await _investigation(session, principal.tenant_id, investigation_id)
    inv.status = "deleted"
    await append_audit(session, principal, request, action="investigation.delete", resource_type="investigation", resource_id=inv.id, correlation_id=cid)
    await session.commit()
    return {"id": inv.id, "deleted": True}


@router.patch("/investigations/{investigation_id}")
async def update_investigation_status(investigation_id: uuid.UUID, body: InvestigationStatusUpdate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="investigation.update"))
    inv = await _investigation(session, principal.tenant_id, investigation_id)
    inv.status = body.status
    await append_audit(session, principal, request, action="investigation.update", resource_type="investigation", resource_id=inv.id, correlation_id=cid, metadata_safe={"status": body.status})
    await session.commit()
    return {"id": inv.id, "status": inv.status}


@router.delete("/investigations/{investigation_id}/entities/{entity_id}")
async def delete_entity(investigation_id: uuid.UUID, entity_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="entity.delete"))
    await _investigation(session, principal.tenant_id, investigation_id)
    entity = await session.scalar(select(Entity).where(Entity.id == entity_id, Entity.investigation_id == investigation_id, Entity.tenant_id == principal.tenant_id))
    if not entity:
        raise HTTPException(status_code=404, detail="Entidade não encontrada.")
    entity.verification_status = "deleted"
    await append_audit(session, principal, request, action="entity.delete", resource_type="entity", resource_id=entity.id, correlation_id=cid)
    await session.commit()
    return {"id": entity.id, "deleted": True}


@router.post("/investigations/{investigation_id}/findings", status_code=status.HTTP_201_CREATED)
async def create_finding(investigation_id: uuid.UUID, body: FindingCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="finding.create"))
    await _investigation(session, principal.tenant_id, investigation_id)
    item = Finding(tenant_id=principal.tenant_id, investigation_id=investigation_id, **body.model_dump())
    session.add(item)
    await session.flush()
    await append_audit(session, principal, request, action="finding.create", resource_type="finding", resource_id=item.id, correlation_id=cid, metadata_safe={"classification": item.classification})
    await session.commit()
    return _serialize_finding(item)


@router.patch("/findings/{finding_id}")
async def update_finding(finding_id: uuid.UUID, body: FindingUpdate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="finding.update"))
    item = await session.scalar(select(Finding).where(Finding.id == finding_id, Finding.tenant_id == principal.tenant_id))
    if not item:
        raise HTTPException(status_code=404, detail="Achado não encontrado.")
    patch = body.model_dump(exclude_unset=True)
    for key, value in patch.items():
        setattr(item, key, value)
    await append_audit(session, principal, request, action="finding.update", resource_type="finding", resource_id=item.id, correlation_id=cid, metadata_safe={"human_validated": item.human_validated, "reviewer_name": principal.display_name if item.human_validated else None})
    await session.commit()
    return _serialize_finding(item)


@router.post("/osint/runs", status_code=status.HTTP_202_ACCEPTED)
async def create_connector_run(body: ConnectorRunCreate, request: Request, wait: bool = False, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    limits = {"brasilapi": 60, "transparency": 90, "datajud": 120, "rdap_dns": 30}
    permitted = await rate_limiter.allow(
        f"{principal.tenant_id}:{principal.user_id}:{body.connector_id}",
        limits[body.connector_id],
        60,
    )
    context = PolicyContext(action="osint.run", purpose=body.purpose, legal_basis=body.legal_basis, authorization_reference=body.authorization_reference, investigation_id=body.investigation_id, connector_id=body.connector_id, risk_level=body.risk_level, scope_codes=set(body.scope_codes), rate_limited=not permitted)
    cid, decision = await _decision(session, principal, request, context)
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL:
        raise HTTPException(status_code=202, detail={"policy_code": decision.code, "reason": decision.reason, "status": "approval_required"})
    if body.investigation_id: await _investigation(session, principal.tenant_id, body.investigation_id)
    payload = {**body.payload, "authorization_reference": body.authorization_reference, "scope_codes": body.scope_codes}
    run = ConnectorRun(tenant_id=principal.tenant_id, investigation_id=body.investigation_id, target_entity_id=body.target_entity_id, connector_id=body.connector_id, status="queued", purpose=body.purpose, correlation_id=cid, request_hash=request_hash(payload), request_payload=payload)
    session.add(run); await session.flush()
    run.job_id = str(uuid.uuid4())
    session.add(JobExecution(tenant_id=principal.tenant_id, job_id=run.job_id, task_name="process_connector_run", queue="default", status="queued", attempts=0, correlation_id=cid, result_summary={"run_id": str(run.id)}))
    await enqueue_outbox(session, tenant_id=principal.tenant_id, topic="connector.run", payload={"run_id": str(run.id), "job_id": run.job_id}, correlation_id=cid)
    await append_audit(session, principal, request, action="osint.run.queue", resource_type="connector_run", resource_id=run.id, correlation_id=cid, metadata_safe={"connector_id": body.connector_id})
    await session.commit()
    if wait and settings.environment in {"development", "test"}:
        await execute_connector_run(str(run.id))
        await session.refresh(run)
        return {
            "run_id": run.id,
            "job_id": run.job_id,
            "status": run.status,
            "correlation_id": cid,
            "normalized_result": run.normalized_result,
            "raw_snapshot": run.raw_snapshot,
            "limitations": run.limitations,
        }
    return {"run_id": run.id, "job_id": run.job_id, "status": run.status, "correlation_id": cid}


@router.get("/osint/runs/{run_id}")
async def get_connector_run(run_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="osint.run.read"))
    run = await session.scalar(select(ConnectorRun).where(ConnectorRun.id == run_id, ConnectorRun.tenant_id == principal.tenant_id))
    if not run: raise HTTPException(status_code=404, detail="Execução não encontrada.")
    await append_audit(session, principal, request, action="osint.run.read", resource_type="connector_run", resource_id=run.id, correlation_id=cid); await session.commit()
    return {"id": run.id, "connector_id": run.connector_id, "status": run.status, "normalized_result": run.normalized_result, "raw_snapshot": run.raw_snapshot, "limitations": run.limitations, "error_code": run.error_code, "correlation_id": run.correlation_id}


@router.get("/jobs/{job_id}/events")
async def get_job(job_id: str, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid, _ = await _decision(session, principal, request, PolicyContext(action="job.read")); job = await session.scalar(select(JobExecution).where(JobExecution.job_id == job_id, JobExecution.tenant_id == principal.tenant_id))
    if not job: raise HTTPException(status_code=404, detail="Job não encontrado.")
    await append_audit(session, principal, request, action="job.read", resource_type="job", resource_id=job.id, correlation_id=cid); await session.commit()
    return {"job_id": job.job_id, "status": job.status, "attempts": job.attempts, "result": job.result_summary, "error_code": job.error_code, "correlation_id": job.correlation_id}
