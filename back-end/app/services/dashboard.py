"""Dashboard projections from persisted records; no browser-supplied totals."""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import String, and_, case, cast, func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Appointment,
    AuditEvent,
    Deadline,
    Evidence,
    FinancialEntry,
    Intimation,
    LegalProcess,
)

TIMEZONE = "America/Sao_Paulo"
PENDING = ("pending", "pendente")
CANCELLED = ("cancelled", "canceled", "cancelado")
COMPLETED = ("completed", "concluido")
RECEIVED = ("received", "recebido")
PAID = ("paid", "pago")
FORECAST = ("forecast", "previsto")
OVERDUE = ("overdue", "vencido")
REVENUE = ("revenue", "receita")
EXPENSE = ("expense", "despesa")
TRIAGE = ("triage", "triagem")


def now() -> datetime:
    return datetime.now(UTC)


def today() -> date:
    return now().astimezone(ZoneInfo(TIMEZONE)).date()


def month_bounds(month: str | None, current_day: date) -> tuple[date, date]:
    try:
        start = date.fromisoformat(f"{month}-01") if month else current_day.replace(day=1)
        if not 1900 <= start.year <= 2100:
            raise ValueError("Unsupported calendar range")
        end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        return start, end
    except ValueError as exc:
        raise HTTPException(422, "Selecione um mês válido entre 1900 e 2100.") from exc


def scope(model, tenant: uuid.UUID):
    clauses = [model.tenant_id == tenant]
    if hasattr(model, "deleted_at"):
        clauses.append(model.deleted_at.is_(None))
    return and_(*clauses)


def count_if(condition):
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


def sum_if(condition):
    return func.coalesce(func.sum(case((condition, FinancialEntry.amount), else_=0)), 0)


def money(value) -> str:
    return format(Decimal(value or 0).quantize(Decimal("0.01")), "f")


async def audit_total(session: AsyncSession, tenant: uuid.UUID) -> int:
    return int(await session.scalar(select(func.count()).select_from(AuditEvent).where(scope(AuditEvent, tenant))) or 0)


def alerts_query(tenant: uuid.UUID, current_day: date):
    # PostgreSQL resolves nested UNION types from left to right. Untyped NULLs
    # in both leading branches resolve as text before the monetary branch.
    no_amount = cast(literal(None), FinancialEntry.amount.type)
    deadline = select(
        Deadline.id.label("id"), literal("deadline").label("kind"), Deadline.title.label("title"),
        literal("Prazo pendente").label("description"), cast(Deadline.due_date, String).label("date"),
        literal("danger").label("severity"), literal("deadlines").label("section"),
        case((Deadline.due_date < current_day, 0), else_=1).label("priority"), no_amount.label("amount"),
    ).where(scope(Deadline, tenant), Deadline.status.in_(PENDING), Deadline.due_date <= current_day + timedelta(days=2))
    intimation = select(
        Intimation.id, literal("intimation"), literal("Intimação aguardando triagem"), Intimation.source,
        cast(Intimation.received_at, String), literal("warning"), literal("intimations"), literal(2), no_amount,
    ).where(scope(Intimation, tenant), Intimation.status.in_(TRIAGE))
    receivable = FinancialEntry.entry_type.in_(REVENUE)
    financial = select(
        FinancialEntry.id, case((receivable, "receivable"), else_="payable"),
        case((receivable, "Receita vencida"), else_="Despesa vencida"), FinancialEntry.description,
        cast(FinancialEntry.entry_date, String), literal("warning"), literal("financial"),
        case((receivable, 3), else_=4), FinancialEntry.amount,
    ).where(scope(FinancialEntry, tenant), FinancialEntry.status.in_(OVERDUE), FinancialEntry.entry_type.in_((*REVENUE, *EXPENSE)))
    return union_all(deadline, intimation, financial).subquery()


async def alerts(session: AsyncSession, tenant: uuid.UUID, current_day: date, offset: int = 0, limit: int = 20) -> dict:
    query = alerts_query(tenant, current_day)
    total = int(await session.scalar(select(func.count()).select_from(query)) or 0)
    rows = (await session.execute(select(query).order_by(query.c.priority, query.c.date, query.c.id).offset(offset).limit(limit))).mappings().all()
    items = []
    for row in rows:
        item = {key: row[key] for key in ("id", "kind", "title", "description", "date", "severity", "section")}
        if item["kind"] == "deadline":
            remaining = (date.fromisoformat(item["date"]) - current_day).days
            item["description"] = f"Vencido há {-remaining} dia(s)" if remaining < 0 else "Vence hoje" if remaining == 0 else f"Vence em {remaining} dia(s)"
        elif item["kind"] == "intimation":
            received = datetime.fromisoformat(item["date"])
            item["date"] = (received.replace(tzinfo=UTC) if received.tzinfo is None else received).astimezone(ZoneInfo(TIMEZONE)).date().isoformat()
        if row["amount"] is not None:
            item["amount"] = money(row["amount"])
        items.append(item)
    return {"total": total, "offset": offset, "limit": limit, "items": items}


async def calendar_days(session: AsyncSession, tenant: uuid.UUID, start: date, end: date) -> dict:
    appointments = select(Appointment.appointment_date.label("date"), func.count().label("appointments"), literal(0).label("deadlines")).where(
        scope(Appointment, tenant), Appointment.status.not_in(CANCELLED), Appointment.appointment_date >= start, Appointment.appointment_date < end,
    ).group_by(Appointment.appointment_date)
    deadlines = select(Deadline.due_date, literal(0), func.count()).where(
        scope(Deadline, tenant), Deadline.status.in_(PENDING), Deadline.due_date >= start, Deadline.due_date < end,
    ).group_by(Deadline.due_date)
    combined = union_all(appointments, deadlines).subquery()
    rows = (await session.execute(select(combined.c.date, func.sum(combined.c.appointments), func.sum(combined.c.deadlines)).group_by(combined.c.date).order_by(combined.c.date))).all()
    return {"days": [{"date": day, "appointments": int(appts), "deadlines": int(dues)} for day, appts, dues in rows]}


async def day_events(session: AsyncSession, tenant: uuid.UUID, day: date, offset: int, limit: int) -> dict:
    process_join = and_(LegalProcess.id == Deadline.process_id, scope(LegalProcess, tenant))
    deadlines = select(
        Deadline.id.label("id"), literal("deadline").label("kind"), Deadline.title.label("title"),
        literal(None).label("time"), literal(None).label("location"), LegalProcess.number.label("process_number"),
        Deadline.status.label("status"), Deadline.due_date.label("date"), literal(0).label("sort"),
    ).outerjoin(LegalProcess, process_join).where(scope(Deadline, tenant), Deadline.due_date == day, Deadline.status.in_(PENDING))
    appointments = select(
        Appointment.id, literal("appointment"), Appointment.title, cast(Appointment.appointment_time, String), Appointment.location,
        LegalProcess.number, Appointment.status, Appointment.appointment_date, literal(1),
    ).outerjoin(LegalProcess, and_(LegalProcess.id == Appointment.process_id, scope(LegalProcess, tenant))).where(
        scope(Appointment, tenant), Appointment.appointment_date == day, Appointment.status.not_in(CANCELLED),
    )
    query = union_all(deadlines, appointments).subquery()
    total = int(await session.scalar(select(func.count()).select_from(query)) or 0)
    rows = (await session.execute(select(query).order_by(query.c.sort, query.c.time, query.c.id).offset(offset).limit(limit))).mappings().all()
    return {"date": day, "total": total, "offset": offset, "limit": limit,
            "items": [{key: row[key] for key in ("id", "kind", "title", "time", "location", "process_number", "status", "date")} for row in rows]}


async def summary(session: AsyncSession, tenant: uuid.UUID, current_day: date, start: date, end: date) -> dict:
    active_processes = await session.scalar(select(func.count()).select_from(LegalProcess).where(scope(LegalProcess, tenant), LegalProcess.status.in_(("active", "ativo", "critical", "critico"))))
    critical, late = (await session.execute(select(
        count_if(Deadline.due_date <= current_day + timedelta(days=7)), count_if(Deadline.due_date < current_day),
    ).where(scope(Deadline, tenant), Deadline.status.in_(PENDING)))).one()
    appts, completed = (await session.execute(select(func.count(), count_if(Appointment.status.in_(COMPLETED))).where(
        scope(Appointment, tenant), Appointment.appointment_date == current_day, Appointment.status.not_in(CANCELLED),
    ))).one()
    pending, triage = (await session.execute(select(func.count(), count_if(Intimation.status.in_(TRIAGE))).where(
        scope(Intimation, tenant), Intimation.status.in_((*TRIAGE, "received", "recebida")),
    ))).one()
    storage_ready = and_(Evidence.validation_status.in_(("preserved", "validated")),
                         func.length(func.trim(Evidence.storage_bucket)) > 0,
                         func.length(func.trim(Evidence.storage_key)) > 0,
                         func.length(func.trim(Evidence.storage_version_id)) > 0)
    all_files, stored = (await session.execute(select(func.count(), count_if(storage_ready)).where(scope(Evidence, tenant)))).one()
    revenue, expense = FinancialEntry.entry_type.in_(REVENUE), FinancialEntry.entry_type.in_(EXPENSE)
    overdue = FinancialEntry.status.in_(OVERDUE)
    month = and_(FinancialEntry.entry_date >= start, FinancialEntry.entry_date < end)
    sums = (await session.execute(select(
        sum_if(and_(revenue, FinancialEntry.status.in_(FORECAST))), sum_if(and_(revenue, overdue)), count_if(and_(revenue, overdue)),
        sum_if(and_(expense, overdue)), count_if(and_(expense, overdue)),
        sum_if(and_(revenue, FinancialEntry.status.in_(RECEIVED), month)), sum_if(and_(expense, FinancialEntry.status.in_(PAID), month)),
    ).where(scope(FinancialEntry, tenant)))).one()
    forecast, receivables, receivable_count, payables, payable_count, received_month, paid_month = sums
    deadline_query = select(Deadline, LegalProcess.number).outerjoin(LegalProcess, and_(LegalProcess.id == Deadline.process_id, scope(LegalProcess, tenant))).where(scope(Deadline, tenant), Deadline.status.in_(PENDING))
    deadline_total = int(await session.scalar(select(func.count()).select_from(Deadline).where(scope(Deadline, tenant), Deadline.status.in_(PENDING))) or 0)
    deadline_rows = (await session.execute(deadline_query.order_by(Deadline.due_date, Deadline.id).limit(5))).all()
    return {
        "today": current_day, "month": start.strftime("%Y-%m"), "timezone": TIMEZONE,
        "counts": {"active_processes": int(active_processes or 0), "critical_deadlines": int(critical), "overdue_deadlines": int(late),
                   "appointments_today": int(appts), "completed_appointments_today": int(completed), "pending_intimations": int(pending),
                   "triage_intimations": int(triage), "stored_files": int(stored), "pending_files": int(all_files - stored)},
        "financial": {"forecast_revenue": money(forecast), "overdue_receivables": money(receivables), "overdue_receivables_count": int(receivable_count),
                      "overdue_payables": money(payables), "overdue_payables_count": int(payable_count), "received_month": money(received_month),
                      "paid_month": money(paid_month), "net_month": money(received_month - paid_month),
                      "period_start": start, "period_end": end - timedelta(days=1), "basis": "entry_date"},
        "upcoming_deadlines": {"total": deadline_total, "items": [{"id": item.id, "title": item.title, "date": item.due_date,
            "process_number": number, "days_remaining": (item.due_date - current_day).days} for item, number in deadline_rows]},
        "urgent_actions": await alerts(session, tenant, current_day, limit=5),
        "calendar": await calendar_days(session, tenant, start, end),
    }
