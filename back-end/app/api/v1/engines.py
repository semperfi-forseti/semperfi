from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.engine_schemas import EngineReviewCreate, EngineRunCreate
from app.audit import append_audit
from app.connectors.registry import CONNECTORS
from app.db import get_db
from app.investigation_engines.service import engine_catalog, run_siera, run_tacer
from app.models.investigation import InvestigationScope
from app.models.investigation_engine_run import InvestigationEngineRun
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.security import Principal, cipher, get_current_principal
from app.services.agent_runs import validate_references
from app.services.worker_context import set_worker_tenant_context

router = APIRouter(tags=["Investigation Engines"])
WRITE_ROLES = ("administrator", "manager", "lawyer", "investigator", "analyst")
READ_ROLES = (*WRITE_ROLES, "auditor")


def _role(principal: Principal, *, write: bool = False) -> None:
    if not principal.has_any_role(*(WRITE_ROLES if write else READ_ROLES)):
        raise HTTPException(status_code=403, detail="Perfil não autorizado para esta operação de planejamento.")


def _protected_json(value: dict) -> str:
    try:
        return cipher.encrypt(json.dumps(value, ensure_ascii=False, allow_nan=False)) or ""
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="O armazenamento protegido está indisponível.") from exc


def _decode(value: str) -> dict:
    try:
        result = json.loads(cipher.decrypt(value) or "{}")
        if not isinstance(result, dict):
            raise ValueError("Invalid stored content")
        return result
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="O registro protegido está indisponível.") from exc


def _summary(item: InvestigationEngineRun) -> dict:
    # History deliberately omits input, target, authorization and generated hypotheses.
    return {"id": item.id, "run_id": item.id, "engine": item.engine,
            "target_type": item.target_type, "investigation_id": item.investigation_id,
            "created_at": item.created_at, "review_status": item.review_status,
            "reviewed_at": item.reviewed_at}


def _detail(item: InvestigationEngineRun) -> dict:
    payload = _decode(item.input_ciphertext)
    safe_keys = {"target", "target_type", "purpose", "legal_basis", "declared_scope", "connectors_allowed", "risk_level"}
    return {**_summary(item), "input_safe": {key: value for key, value in payload.items() if key in safe_keys},
            "result": _decode(item.result_ciphertext),
            "review_notes": _decode(item.review_notes_ciphertext).get("notes") if item.review_notes_ciphertext else None}


def _legacy_result(item: InvestigationEngineRun) -> dict:
    return {**_decode(item.result_ciphertext), "run_id": item.id,
            "investigation_id": item.investigation_id, "created_at": item.created_at,
            "review_status": item.review_status}


async def _find(session: AsyncSession, principal: Principal, run_id: uuid.UUID) -> InvestigationEngineRun:
    item = await session.scalar(select(InvestigationEngineRun).where(
        InvestigationEngineRun.id == run_id, InvestigationEngineRun.tenant_id == principal.tenant_id))
    if item is None:
        raise HTTPException(status_code=404, detail="Planejamento não encontrado.")
    return item


async def _authorize(session: AsyncSession, principal: Principal, request: Request, body: EngineRunCreate) -> str:
    _role(principal, write=True)
    await validate_references(session, principal.tenant_id, body.investigation_id, [])
    if body.investigation_id:
        allowed = set((await session.scalars(select(InvestigationScope.scope_code).where(
            InvestigationScope.investigation_id == body.investigation_id, InvestigationScope.approved.is_(True)))).all())
        if not set(body.declared_scope).issubset(allowed):
            raise HTTPException(status_code=403, detail="O escopo informado não está aprovado nesta investigação.")
    cid = correlation_id(request)
    decision = await policy_engine.evaluate(session, principal, PolicyContext(
        action="engine.run", purpose=body.purpose, legal_basis=body.legal_basis,
        authorization_reference=body.authorization_reference, investigation_id=body.investigation_id,
        risk_level=body.risk_level, scope_codes=set(body.declared_scope)), cid)
    if decision.effect != PolicyEffect.ALLOW:
        code = 202 if decision.effect == PolicyEffect.REQUIRE_APPROVAL else 429 if decision.effect == PolicyEffect.RATE_LIMITED else 403
        raise HTTPException(status_code=code, detail={"policy_code": decision.code, "reason": decision.reason,
                            **({"status": "approval_required"} if code == 202 else {})})
    return cid


@router.get("/investigation-engines/catalog")
async def get_engine_catalog(request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _role(principal)
    catalog = engine_catalog()
    catalog["connectors"] = [{"connector_id": value, "execution_mode": "server_side", "frontend_secret_exposure": False,
                              "status": "configured_by_environment"} for value in sorted(CONNECTORS)]
    await append_audit(session, principal, request, action="engine.catalog", resource_type="investigation_engine",
                       resource_id=None, correlation_id=correlation_id(request))
    await session.commit()
    return catalog


async def _run(engine: str, body: EngineRunCreate, request: Request, session: AsyncSession, principal: Principal) -> dict:
    cid = await _authorize(session, principal, request, body)
    payload = body.model_dump(mode="json", exclude={"request_id"})
    fingerprint = cipher.fingerprint(json.dumps({"engine": engine, "input": payload}, sort_keys=True, ensure_ascii=False))
    existing = await session.scalar(select(InvestigationEngineRun).where(
        InvestigationEngineRun.tenant_id == principal.tenant_id, InvestigationEngineRun.request_id == body.request_id))
    if existing:
        if existing.request_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="Esta solicitação já foi utilizada com outros dados.")
        return _legacy_result(existing)
    result = (run_tacer if engine == "tacer" else run_siera)(payload)
    result["correlation_id"] = cid
    item = InvestigationEngineRun(tenant_id=principal.tenant_id, created_by=principal.user_id,
        investigation_id=body.investigation_id, request_id=body.request_id, request_fingerprint=fingerprint,
        engine=engine, target_type=body.target_type, input_ciphertext=_protected_json(payload),
        result_ciphertext=_protected_json(result), review_status="pending")
    session.add(item)
    try:
        await session.flush()
        await append_audit(session, principal, request, action=f"engine.{engine}.run", resource_type="investigation_engine",
            resource_id=item.id, correlation_id=cid,
            metadata_safe={"target_type": body.target_type, "risk_level": body.risk_level, "classification": "planning_only"})
        response = _legacy_result(item)
        await session.commit()
        return response
    except IntegrityError:
        await session.rollback()
        await set_worker_tenant_context(session, principal.tenant_id)
        existing = await session.scalar(select(InvestigationEngineRun).where(
            InvestigationEngineRun.tenant_id == principal.tenant_id, InvestigationEngineRun.request_id == body.request_id))
        if existing and existing.request_fingerprint == fingerprint:
            return _legacy_result(existing)
        raise HTTPException(status_code=409, detail="A solicitação foi alterada ou já está em processamento.") from None


@router.post("/investigation-engines/tacer/run")
async def run_tacer_engine(body: EngineRunCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    return await _run("tacer", body, request, session, principal)


@router.post("/investigation-engines/siera/run")
async def run_siera_engine(body: EngineRunCreate, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    return await _run("siera", body, request, session, principal)


@router.get("/investigation-engines/runs")
async def list_runs(request: Request, investigation_id: uuid.UUID | None = None,
                    engine: Literal["tacer", "siera"] | None = None, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0, le=100000),
                    session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _role(principal)
    query = select(InvestigationEngineRun).where(InvestigationEngineRun.tenant_id == principal.tenant_id)
    if investigation_id:
        query = query.where(InvestigationEngineRun.investigation_id == investigation_id)
    if engine:
        query = query.where(InvestigationEngineRun.engine == engine)
    rows = list((await session.scalars(query.order_by(InvestigationEngineRun.created_at.desc(), InvestigationEngineRun.id.desc()).limit(limit).offset(offset))).all())
    response = [_summary(item) for item in rows]
    await append_audit(session, principal, request, action="engine.run.list", resource_type="investigation_engine",
                       resource_id=None, correlation_id=correlation_id(request), metadata_safe={"count": len(rows)})
    await session.commit()
    return response


@router.get("/investigation-engines/runs/{run_id}")
async def get_run(run_id: uuid.UUID, request: Request, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _role(principal)
    item = await _find(session, principal, run_id)
    response = _detail(item)
    await append_audit(session, principal, request, action="engine.run.read", resource_type="investigation_engine",
                       resource_id=item.id, correlation_id=correlation_id(request))
    await session.commit()
    return response


@router.patch("/investigation-engines/runs/{run_id}/review")
async def review_run(run_id: uuid.UUID, body: EngineReviewCreate, request: Request,
                     session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    _role(principal, write=True)
    item = await _find(session, principal, run_id)
    await validate_references(session, principal.tenant_id, item.investigation_id, [])
    if item.review_status != "pending":
        raise HTTPException(status_code=409, detail="Este planejamento já possui uma revisão registrada.")
    changed = await session.execute(update(InvestigationEngineRun).where(
        InvestigationEngineRun.id == item.id, InvestigationEngineRun.tenant_id == principal.tenant_id,
        InvestigationEngineRun.review_status == "pending").values(
        review_status=body.decision, review_notes_ciphertext=_protected_json({"notes": body.notes}),
        reviewed_by=principal.user_id, reviewed_at=datetime.now(UTC)))
    if not changed.rowcount:
        raise HTTPException(status_code=409, detail="Este planejamento já possui uma revisão registrada.")
    await session.refresh(item)
    response = _detail(item)
    await append_audit(session, principal, request, action="engine.run.review", resource_type="investigation_engine",
        resource_id=item.id, correlation_id=correlation_id(request), metadata_safe={"decision": body.decision})
    await session.commit()
    return response
