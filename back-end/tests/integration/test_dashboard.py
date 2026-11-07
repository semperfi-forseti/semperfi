"""Dashboard acceptance against populated, isolated SQLite tenants."""

import json
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.dialects import postgresql

from app.core.config import get_settings
from app.db import SessionLocal
from app.main import app
from app.models import (
    Appointment,
    AuditEvent,
    Client,
    Deadline,
    Evidence,
    FinancialEntry,
    Intimation,
    LegalProcess,
)
from app.services import dashboard

NOW = datetime(2026, 10, 2, 15, 30, tzinfo=UTC)
TODAY = date(2026, 10, 2)


def identity(role="administrator"):
    return {"X-Semperfi-User-Id": str(uuid4()), "X-Semperfi-Tenant-Id": str(uuid4()), "X-Semperfi-Roles": role}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setattr(dashboard, "now", lambda: NOW)
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


def seed(api, headers, *, label="Operação", audit_count=0):
    """Fixtures remain in the test database; no SMTP, storage or live API calls."""
    tenant = UUID(headers["X-Semperfi-Tenant-Id"])

    async def create():
        async with SessionLocal() as session:
            client = Client(id=uuid4(), tenant_id=tenant, name=f"{label} cliente", document_ciphertext="private-document")
            process = LegalProcess(id=uuid4(), tenant_id=tenant, client_id=client.id, number=f"{label}-processo", status="active")
            session.add_all([client, process,
                LegalProcess(tenant_id=tenant, client_id=client.id, number=f"{label}-crítico", status="critical"),
                LegalProcess(tenant_id=tenant, client_id=client.id, number=f"{label}-encerrado", status="closed"),
                LegalProcess(tenant_id=tenant, client_id=client.id, number=f"{label}-excluído", status="active", deleted_at=NOW),
            ])
            await session.flush()
            for days in (-4, 0, 2, 7, 8):
                session.add(Deadline(tenant_id=tenant, process_id=process.id, title=f"{label} prazo {days}",
                                     due_date=TODAY + timedelta(days=days), deadline_type="manifestation", status="pending"))
            for status, deleted in (("completed", None), ("cancelled", None), ("pending", NOW)):
                session.add(Deadline(tenant_id=tenant, process_id=process.id, title=f"{label} prazo omitido",
                                     due_date=TODAY, deadline_type="manifestation", status=status, deleted_at=deleted))
            for hour, status, deleted in ((9, "confirmed", None), (10, "completed", None), (11, "cancelled", None), (12, "confirmed", NOW)):
                session.add(Appointment(tenant_id=tenant, process_id=process.id, title=f"{label} compromisso {hour}",
                    appointment_date=TODAY, appointment_time=time(hour), appointment_type="meeting", location="Sala de teste",
                    status=status, deleted_at=deleted))
            session.add(Appointment(tenant_id=tenant, title=f"{label} reunião anterior", appointment_date=date(2026, 9, 30),
                                    appointment_type="meeting", status="confirmed"))
            for status, deleted in (("triage", None), ("received", None), ("launched", None), ("triage", NOW)):
                session.add(Intimation(tenant_id=tenant, process_id=process.id, source=f"{label} tribunal", intimation_type="intimation",
                    received_at=datetime(2026, 10, 2, 2, tzinfo=UTC), content_ciphertext="private-content", status=status, deleted_at=deleted))
            entries = [
                ("revenue", "forecast", "100.25", date(2026, 10, 3), None),
                ("revenue", "forecast", "40.10", date(2026, 9, 20), None),
                ("revenue", "overdue", "50.20", date(2026, 9, 20), None),
                ("expense", "overdue", "20.50", date(2026, 9, 21), None),
                ("expense", "forecast", "9.30", date(2026, 9, 20), None),
                ("revenue", "received", "100.10", TODAY, None),
                ("revenue", "received", "20.05", date(2026, 10, 1), None),
                ("revenue", "received", "30.00", date(2026, 10, 31), None),
                ("expense", "paid", "30.10", TODAY, None),
                ("revenue", "received", "600.00", date(2026, 9, 30), None),
                ("expense", "paid", "70.00", date(2026, 9, 1), None),
                ("revenue", "received", "1000.00", date(2026, 11, 1), None),
                ("revenue", "received", "900.00", TODAY, NOW),
                ("revenue", "overdue", "900.00", TODAY, NOW),
                ("revenue", "forecast", "900.00", TODAY, NOW),
            ]
            for kind, status, amount, day, deleted in entries:
                session.add(FinancialEntry(tenant_id=tenant, entry_date=day, entry_type=kind, status=status,
                    description=f"{label} {kind} {status} {amount}", amount=Decimal(amount), deleted_at=deleted))
            for status, version in (("preserved", "version-1"), ("validated", "version-2"),
                                    ("pending", "version-3"), ("preserved", None), ("integrity_failed", "version-4")):
                session.add(Evidence(tenant_id=tenant, original_filename=f"{label}.txt", mime_type="text/plain", size_bytes=5,
                    sha256="a" * 64, source_type="manual", collection_method="upload", collected_at=NOW,
                    storage_bucket="private-bucket", storage_key="private-key", storage_version_id=version,
                    validation_status=status, metadata_json={"private": "never returned"}))
            for number in range(audit_count):
                session.add(AuditEvent(tenant_id=tenant, action="fixture.read", resource_type="fixture", result="success",
                    correlation_id=str(uuid4()), occurred_at=NOW + timedelta(microseconds=number), event_hash=f"{number:064x}"))
            await session.commit()
            return {"tenant": tenant, "process": process.id}

    return api.portal.call(create)


def get_ok(api, path, headers):
    response = api.get(path, headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert datetime.fromisoformat(response.json()["generated_at"]) == NOW
    return response.json()


def test_populated_dashboard_uses_persisted_counts_and_exact_monthly_money(api):
    owner, foreign = identity(), identity()
    seeded = seed(api, owner, audit_count=501)
    seed(api, foreign, label="Outro escritório", audit_count=25)
    body = get_ok(api, "/v1/dashboard", owner)
    assert body["today"] == "2026-10-02"
    assert body["month"] == "2026-10"
    assert body["timezone"] == "America/Sao_Paulo"
    assert body["counts"] == {
        "active_processes": 2, "critical_deadlines": 4, "overdue_deadlines": 1,
        "appointments_today": 2, "completed_appointments_today": 1,
        "pending_intimations": 2, "triage_intimations": 1, "stored_files": 2,
        "pending_files": 3, "total_audit_events": 502,
    }
    assert body["financial"] == {
        "forecast_revenue": "140.35", "overdue_receivables": "50.20", "overdue_receivables_count": 1,
        "overdue_payables": "20.50", "overdue_payables_count": 1,
        "received_month": "150.15", "paid_month": "30.10", "net_month": "120.05",
        "period_start": "2026-10-01", "period_end": "2026-10-31", "basis": "entry_date",
    }
    # entry_date is a booking date, not a due date: a past forecast must not be
    # reclassified as delinquent without the persisted overdue status.
    assert body["urgent_actions"]["total"] == 6
    assert [item["kind"] for item in body["urgent_actions"]["items"]] == ["deadline"] * 3 + ["intimation", "receivable"]
    assert body["upcoming_deadlines"]["total"] == 5
    assert [item["days_remaining"] for item in body["upcoming_deadlines"]["items"]] == [-4, 0, 2, 7, 8]
    assert body["calendar"]["days"] == [
        {"date": "2026-10-02", "appointments": 2, "deadlines": 1},
        {"date": "2026-10-04", "appointments": 0, "deadlines": 1},
        {"date": "2026-10-09", "appointments": 0, "deadlines": 1},
        {"date": "2026-10-10", "appointments": 0, "deadlines": 1},
    ]
    assert all(text not in json.dumps(body, ensure_ascii=False) for text in ("Outro escritório", "private-document", "private-content", "private-bucket", "private-key", "metadata", "storage_"))

    async def persisted_audits():
        async with SessionLocal() as session:
            return await session.scalar(select(func.count()).select_from(AuditEvent).where(AuditEvent.tenant_id == seeded["tenant"]))
    assert api.portal.call(persisted_audits) == body["counts"]["total_audit_events"]
    assert get_ok(api, "/v1/dashboard", owner)["counts"]["total_audit_events"] == 503


def test_selected_month_limits_financial_and_calendar_without_changing_today_counts(api):
    headers = identity()
    seed(api, headers)
    body = get_ok(api, "/v1/dashboard?month=2026-09", headers)
    assert body["month"] == "2026-09"
    assert body["today"] == "2026-10-02"
    assert body["counts"]["appointments_today"] == 2
    assert body["financial"]["received_month"] == "600.00"
    assert body["financial"]["paid_month"] == "70.00"
    assert body["financial"]["net_month"] == "530.00"
    assert body["financial"]["period_end"] == "2026-09-30"
    assert body["calendar"]["days"] == [
        {"date": "2026-09-28", "appointments": 0, "deadlines": 1},
        {"date": "2026-09-30", "appointments": 1, "deadlines": 0},
    ]


def test_empty_dashboard_returns_explicit_zeroes_and_persisted_read_audit(api):
    headers = identity()
    body = get_ok(api, "/v1/dashboard", headers)
    assert all(value == (1 if key == "total_audit_events" else 0) for key, value in body["counts"].items())
    assert body["financial"]["net_month"] == "0.00"
    assert body["financial"]["received_month"] == "0.00"
    assert body["calendar"] == {"days": []}
    assert body["upcoming_deadlines"] == {"total": 0, "items": []}
    assert body["urgent_actions"]["total"] == 0
    assert body["urgent_actions"]["items"] == []
    assert get_ok(api, "/v1/dashboard/alerts", headers)["items"] == []
    assert get_ok(api, "/v1/dashboard/day?date=2026-10-02", headers)["items"] == []


def test_alerts_and_day_results_are_complete_stable_and_paginated(api):
    headers = identity()
    seed(api, headers)
    full = get_ok(api, "/v1/dashboard/alerts?limit=100", headers)
    pages = [get_ok(api, f"/v1/dashboard/alerts?offset={offset}&limit=2", headers) for offset in (0, 2, 4)]
    assert full["total"] == 6
    assert [item for page in pages for item in page["items"]] == full["items"]
    assert full["items"][0]["description"] == "Vencido há 4 dia(s)"
    assert full["items"][1]["description"] == "Vence hoje"
    assert full["items"][3]["date"] == "2026-10-01"  # 02:00 UTC is the previous local day.
    assert full["items"][4]["kind"] == "receivable"
    assert full["items"][4]["amount"] == "50.20"
    assert full["items"][5]["kind"] == "payable"
    assert full["items"][5]["amount"] == "20.50"
    assert get_ok(api, "/v1/dashboard/alerts?offset=6", headers)["items"] == []
    all_day = get_ok(api, "/v1/dashboard/day?date=2026-10-02", headers)
    assert all_day["total"] == 3
    assert [item["kind"] for item in all_day["items"]] == ["deadline", "appointment", "appointment"]
    assert [item["status"] for item in all_day["items"]] == ["pending", "confirmed", "completed"]
    assert all_day["items"][1]["time"].startswith("09:00")
    assert all_day["items"][2]["location"] == "Sala de teste"
    assert all(item["process_number"] == "Operação-processo" for item in all_day["items"])
    assert [get_ok(api, f"/v1/dashboard/day?date=2026-10-02&offset={offset}&limit=1", headers)["items"][0] for offset in range(3)] == all_day["items"]
    assert get_ok(api, "/v1/dashboard/day?date=2026-10-02&offset=3", headers)["items"] == []


def test_joined_process_numbers_never_disclose_foreign_or_soft_deleted_process(api):
    headers, foreign = identity(), identity()
    own = seed(api, headers)
    other = seed(api, foreign, label="Segredo de outro escritório")

    async def create_broken_links():
        async with SessionLocal() as session:
            process = await session.get(LegalProcess, own["process"])
            process.deleted_at = NOW
            session.add(Deadline(tenant_id=own["tenant"], process_id=other["process"], title="Referência inconsistente",
                                 due_date=TODAY, deadline_type="manifestation", status="pending"))
            session.add(Appointment(tenant_id=own["tenant"], process_id=other["process"], title="Compromisso inconsistente",
                                   appointment_date=TODAY, appointment_type="meeting", status="confirmed"))
            await session.commit()
    api.portal.call(create_broken_links)
    body = get_ok(api, "/v1/dashboard", headers)
    assert all(item["process_number"] is None for item in body["upcoming_deadlines"]["items"])
    day = get_ok(api, "/v1/dashboard/day?date=2026-10-02", headers)
    assert all(item["process_number"] is None for item in day["items"])
    assert "Segredo" not in json.dumps(body) + json.dumps(day)


def test_local_midnight_and_month_default_are_calculated_in_sao_paulo(api, monkeypatch):
    monkeypatch.setattr(dashboard, "now", lambda: datetime(2026, 10, 1, 2, 59, tzinfo=UTC))
    response = api.get("/v1/dashboard", headers=identity())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["today"] == "2026-09-30"
    assert body["month"] == "2026-09"
    assert body["financial"]["period_end"] == "2026-09-30"
    monkeypatch.setattr(dashboard, "now", lambda: datetime(2026, 10, 1, 3, tzinfo=UTC))
    body = api.get("/v1/dashboard", headers=identity()).json()
    assert body["today"] == "2026-10-01"
    assert body["month"] == "2026-10"


@pytest.mark.parametrize("role", ["administrator", "manager", "lawyer", "investigator", "analyst", "auditor"])
def test_legal_read_roles_can_access_all_dashboard_routes(api, role):
    headers = identity(role)
    for path in ("/v1/dashboard", "/v1/dashboard/alerts", "/v1/dashboard/day?date=2026-10-02"):
        assert api.get(path, headers=headers).status_code == 200


@pytest.mark.parametrize("path", ["/v1/dashboard", "/v1/dashboard/alerts", "/v1/dashboard/day?date=2026-10-02"])
def test_dashboard_requires_authentication_and_legal_read_role(api, path, monkeypatch):
    # Development identity headers deliberately supply a default test identity.
    # Exercise anonymous access with that development-only facility disabled.
    with monkeypatch.context() as auth:
        auth.setattr(get_settings(), "allow_development_identity_headers", False)
        assert api.get(path).status_code == 401
    assert api.get(path, headers=identity("unknown")).status_code == 403


@pytest.mark.parametrize("query", ["month=2026-13", "month=2026-1", "month=1899-12", "month=2101-01", "month=2026-02-01", "month=invalid"])
def test_invalid_month_is_rejected(api, query):
    assert api.get(f"/v1/dashboard?{query}", headers=identity()).status_code == 422


@pytest.mark.parametrize("path", [
    "/v1/dashboard/day", "/v1/dashboard/day?date=2026-02-30", "/v1/dashboard/day?date=invalid",
    "/v1/dashboard/day?date=2026-10-02&offset=-1", "/v1/dashboard/day?date=2026-10-02&limit=101",
    "/v1/dashboard/alerts?offset=-1", "/v1/dashboard/alerts?limit=0", "/v1/dashboard/alerts?limit=101",
])
def test_invalid_day_or_pagination_is_rejected(api, path):
    assert api.get(path, headers=identity()).status_code == 422


def test_leap_year_and_december_month_boundaries(api):
    headers = identity()
    leap = get_ok(api, "/v1/dashboard?month=2024-02", headers)
    assert leap["financial"]["period_start"] == "2024-02-01"
    assert leap["financial"]["period_end"] == "2024-02-29"
    december = get_ok(api, "/v1/dashboard?month=2026-12", headers)
    assert december["financial"]["period_end"] == "2026-12-31"


def test_refresh_requeries_persisted_changes_and_deadline_preview_is_bounded(api):
    headers = identity()
    seeded = seed(api, headers)
    original = get_ok(api, "/v1/dashboard", headers)

    async def change_records():
        async with SessionLocal() as session:
            late = await session.scalar(select(Deadline).where(Deadline.tenant_id == seeded["tenant"], Deadline.due_date == TODAY - timedelta(days=4)))
            late.status = "completed"
            for days in (20, 30, 40):
                session.add(Deadline(tenant_id=seeded["tenant"], process_id=seeded["process"], title=f"Novo prazo {days}",
                                     due_date=TODAY + timedelta(days=days), deadline_type="manifestation", status="pending"))
            revenue = await session.scalar(select(FinancialEntry).where(FinancialEntry.tenant_id == seeded["tenant"],
                FinancialEntry.entry_type == "revenue", FinancialEntry.status == "overdue", FinancialEntry.deleted_at.is_(None)))
            revenue.status = "received"
            revenue.entry_date = TODAY
            await session.commit()
    api.portal.call(change_records)
    refreshed = get_ok(api, "/v1/dashboard", headers)
    assert original["counts"]["overdue_deadlines"] == 1
    assert refreshed["counts"]["overdue_deadlines"] == 0
    assert refreshed["counts"]["critical_deadlines"] == 3
    assert refreshed["upcoming_deadlines"]["total"] == 7
    assert len(refreshed["upcoming_deadlines"]["items"]) == 5
    assert refreshed["financial"]["overdue_receivables"] == "0.00"
    assert refreshed["financial"]["received_month"] == "200.35"


@pytest.mark.parametrize("field,invalid", [("storage_bucket", None), ("storage_bucket", ""),
    ("storage_key", ""), ("storage_version_id", None), ("storage_version_id", ""), ("storage_version_id", "   ")])
def test_preserved_status_without_usable_storage_reference_is_pending(api, field, invalid):
    headers = identity()

    async def insert():
        async with SessionLocal() as session:
            record = Evidence(tenant_id=UUID(headers["X-Semperfi-Tenant-Id"]), original_filename="incompleto.txt",
                mime_type="text/plain", size_bytes=5, sha256="a" * 64, source_type="manual", collection_method="upload",
                collected_at=NOW, validation_status="preserved", storage_bucket="bucket", storage_key="key", storage_version_id="version")
            setattr(record, field, invalid)
            session.add(record)
            await session.commit()
    api.portal.call(insert)
    counts = get_ok(api, "/v1/dashboard", headers)["counts"]
    assert counts["stored_files"] == 0
    assert counts["pending_files"] == 1


def test_alert_union_keeps_numeric_type_in_postgresql_compilation():
    query = dashboard.alerts_query(uuid4(), TODAY)
    compiled = str(select(query).compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert compiled.count("CAST(NULL AS NUMERIC(14, 2))") == 2
    assert query.c.amount.type.precision == 14
    assert query.c.amount.type.scale == 2
