from datetime import date

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.legal import _policy, _record
from app.db import get_db
from app.security import Principal, get_current_principal
from app.services import dashboard

router = APIRouter(prefix="/dashboard", tags=["Dashboard"])


async def finish(session, principal, request, response, action, cid):
    await _record(session, principal, request, action, "dashboard", None, cid)
    await session.flush()
    response.headers["Cache-Control"] = "no-store"


@router.get("")
async def get_dashboard(request: Request, response: Response, month: str | None = Query(None, pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
                        session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "frontend.bootstrap")
    current_day = dashboard.today()
    start, end = dashboard.month_bounds(month, current_day)
    result = await dashboard.summary(session, principal.tenant_id, current_day, start, end)
    await finish(session, principal, request, response, "dashboard.read", cid)
    result["counts"]["total_audit_events"] = await dashboard.audit_total(session, principal.tenant_id)
    await session.commit()
    result["generated_at"] = dashboard.now()
    return result


@router.get("/alerts")
async def get_alerts(request: Request, response: Response, offset: int = Query(0, ge=0, le=1000000), limit: int = Query(20, ge=1, le=100),
                     session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "frontend.bootstrap")
    result = await dashboard.alerts(session, principal.tenant_id, dashboard.today(), offset, limit)
    await finish(session, principal, request, response, "dashboard.alerts.read", cid)
    await session.commit()
    result["generated_at"] = dashboard.now()
    return result


@router.get("/day")
async def get_day(request: Request, response: Response, date: date, offset: int = Query(0, ge=0, le=1000000), limit: int = Query(20, ge=1, le=100),
                  session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "frontend.bootstrap")
    result = await dashboard.day_events(session, principal.tenant_id, date, offset, limit)
    await finish(session, principal, request, response, "dashboard.day.read", cid)
    await session.commit()
    result["generated_at"] = dashboard.now()
    return result
