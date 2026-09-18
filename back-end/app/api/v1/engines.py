from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.dependencies import correlation_id
from app.api.v1.schemas import InvestigationEngineRunCreate
from app.audit import append_audit
from app.connectors.registry import CONNECTORS
from app.db import get_db
from app.investigation_engines.service import engine_catalog, run_siera, run_tacer
from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.security import Principal, get_current_principal

router = APIRouter(tags=["Investigation Engines"])


def _connector_catalog() -> list[dict]:
    return [
        {
            "connector_id": connector_id,
            "execution_mode": "server_side",
            "frontend_secret_exposure": False,
            "status": "configured_by_environment",
        }
        for connector_id in sorted(CONNECTORS)
    ]


async def _authorize(
    session: AsyncSession,
    principal: Principal,
    request: Request,
    body: InvestigationEngineRunCreate,
):
    cid = correlation_id(request)
    decision = await policy_engine.evaluate(
        session,
        principal,
        PolicyContext(
            action="engine.run",
            purpose=body.purpose,
            legal_basis=body.legal_basis,
            authorization_reference=body.authorization_reference,
            investigation_id=body.investigation_id,
            risk_level=body.risk_level,
            scope_codes=set(body.declared_scope),
        ),
        cid,
    )
    if decision.effect == PolicyEffect.DENY:
        raise HTTPException(
            status_code=403,
            detail={"policy_code": decision.code, "reason": decision.reason},
        )
    if decision.effect == PolicyEffect.REQUIRE_MFA:
        raise HTTPException(
            status_code=403,
            detail={"policy_code": decision.code, "reason": decision.reason},
        )
    if decision.effect == PolicyEffect.REQUIRE_APPROVAL:
        raise HTTPException(
            status_code=202,
            detail={"policy_code": decision.code, "reason": decision.reason, "status": "approval_required"},
        )
    return cid


@router.get("/investigation-engines/catalog")
async def get_engine_catalog(
    request: Request,
    session: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
):
    cid = correlation_id(request)
    catalog = engine_catalog()
    catalog["connectors"] = _connector_catalog()
    await append_audit(
        session,
        principal,
        request,
        action="engine.catalog",
        resource_type="investigation_engine",
        resource_id=None,
        correlation_id=cid,
    )
    await session.commit()
    return catalog


@router.post("/investigation-engines/tacer/run")
async def run_tacer_engine(
    body: InvestigationEngineRunCreate,
    request: Request,
    session: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
):
    cid = await _authorize(session, principal, request, body)
    result = run_tacer(body.model_dump(mode="json"))
    result["correlation_id"] = cid
    await append_audit(
        session,
        principal,
        request,
        action="engine.tacer.run",
        resource_type="investigation_engine",
        resource_id=body.investigation_id,
        correlation_id=cid,
        metadata_safe={"target_type": body.target_type, "risk_level": body.risk_level},
    )
    await session.commit()
    return result


@router.post("/investigation-engines/siera/run")
async def run_siera_engine(
    body: InvestigationEngineRunCreate,
    request: Request,
    session: AsyncSession = Depends(get_db),
    principal: Principal = Depends(get_current_principal),
):
    cid = await _authorize(session, principal, request, body)
    result = run_siera(body.model_dump(mode="json"))
    result["correlation_id"] = cid
    await append_audit(
        session,
        principal,
        request,
        action="engine.siera.run",
        resource_type="investigation_engine",
        resource_id=body.investigation_id,
        correlation_id=cid,
        metadata_safe={"target_type": body.target_type, "risk_level": body.risk_level},
    )
    await session.commit()
    return result
