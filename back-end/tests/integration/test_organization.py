"""Organization access is tenant scoped; no SMTP or operational database is used."""
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from app.api.v1 import organization
from app.core.config import get_settings
from app.db import SessionLocal, init_db
from app.models import Membership, Tenant, User
from app.models.organization import OrganizationInvitation
from app.security import Principal, get_current_principal
from app.security.sessions import session_store


@pytest.fixture
def team(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "auth_mode", "password")
    monkeypatch.setattr(settings, "allow_development_identity_headers", False)
    monkeypatch.setattr(session_store, "_redis", AsyncMock(return_value=None))

    @asynccontextmanager
    async def lifespan(app):
        await init_db()
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(organization.router, prefix="/v1")

    @app.get("/identity")
    async def identity(principal: Principal = Depends(get_current_principal)):
        return {"roles": sorted(principal.roles), "tenant_id": str(principal.tenant_id)}

    async def seed():
        async with SessionLocal() as session:
            tenants = [Tenant(name=f"Equipe {index}", slug=uuid4().hex, account_type="PJ") for index in range(2)]
            session.add_all(tenants)
            await session.flush()
            records = {}
            for label, role, index in [("admin", "administrator", 0), ("admin2", "administrator", 0),
                                       ("member", "lawyer", 0), ("auditor", "auditor", 0), ("outsider", "administrator", 1)]:
                user = User(email=f"{uuid4().hex}@example.com", display_name=label, password_hash="test-only-password-hash", mfa_enrolled=True)
                session.add(user)
                await session.flush()
                member = Membership(tenant_id=tenants[index].id, user_id=user.id, role=role, permissions=[])
                session.add(member)
                await session.flush()
                records[label] = {"user": user, "member": member, "tenant": tenants[index]}
            # The same user has a separate role in the second organization.
            other_member = Membership(tenant_id=tenants[1].id, user_id=records["member"]["user"].id, role="investigator", permissions=[])
            session.add(other_member)
            await session.commit()
            records["member_other"] = {**records["member"], "member": other_member, "tenant": tenants[1]}
        for record in records.values():
            user, member, tenant = record["user"], record["member"], record["tenant"]
            principal = Principal(user.id, tenant.id, user.email, user.display_name, frozenset([member.role]), datetime.now(UTC), "password", tenant.account_type)
            record["principal"] = principal
            record["cookie"] = await session_store.create(principal, password_hash=user.password_hash)
        return records

    with TestClient(app) as client:
        records = client.portal.call(seed)

        def authenticate(label):
            client.cookies.clear()
            client.cookies.set(settings.session_cookie_name, records[label]["cookie"])

        authenticate("admin")
        yield client, records, authenticate


def test_team_is_scoped_and_non_administrators_cannot_manage(team):
    client, records, authenticate = team
    result = client.get("/v1/organization/members")
    assert result.status_code == 200
    assert len(result.json()["items"]) == 4
    assert records["outsider"]["user"].email not in result.text
    outsider_id = records["outsider"]["member"].id
    assert client.patch(f"/v1/organization/members/{outsider_id}", json={"is_active": False}).status_code == 404
    authenticate("auditor")
    assert client.get("/v1/organization/members").status_code == 403
    assert client.post("/v1/organization/invitations", json={"email": "isolated@example.com"}).status_code == 403
    assert client.patch(f"/v1/organization/members/{records['member']['member'].id}", json={"role": "administrator"}).status_code == 403
    mine = client.get("/v1/organization/mine").json()
    assert mine["can_manage"] is False and len(mine["items"]) == 1


def test_self_lockout_and_last_admin_are_blocked(team):
    client, records, _ = team
    own_id = records["admin"]["member"].id
    assert client.patch(f"/v1/organization/members/{own_id}", json={"is_active": False}).status_code == 409
    assert client.patch(f"/v1/organization/members/{own_id}", json={"role": "lawyer"}).status_code == 409
    other_id = records["admin2"]["member"].id
    assert client.patch(f"/v1/organization/members/{other_id}", json={"role": "lawyer"}).status_code == 200
    blocked = client.patch(f"/v1/organization/members/{own_id}", json={"role": "lawyer"})
    assert blocked.status_code == 409 and "pelo menos um administrador" in blocked.text


def test_suspension_never_changes_global_user_or_other_memberships_and_old_session_stays_revoked(team):
    client, records, authenticate = team
    target = records["member"]["member"].id
    assert client.patch(f"/v1/organization/members/{target}", json={"is_active": False}).status_code == 200
    authenticate("member")
    assert client.get("/identity").status_code == 401
    authenticate("member_other")
    assert client.get("/identity").status_code == 200
    authenticate("admin")
    assert client.patch(f"/v1/organization/members/{target}", json={"is_active": True}).status_code == 200
    authenticate("member")
    assert client.get("/identity").status_code == 401, "Old cookies cannot revive after reactivation"

    async def new_session():
        async with SessionLocal() as session:
            user = await session.get(User, records["member"]["user"].id)
            assert user.is_active is True
        return await session_store.create(records["member"]["principal"], password_hash=user.password_hash)

    new_cookie = client.portal.call(new_session)
    client.cookies.set(get_settings().session_cookie_name, new_cookie)
    assert client.get("/identity").status_code == 200


def test_role_change_removes_old_extra_permissions_and_revokes_session(team):
    client, records, authenticate = team

    async def extra_permission():
        async with SessionLocal() as session:
            member = await session.get(Membership, records["member"]["member"].id)
            member.permissions = ["administrator"]
            await session.commit()

    client.portal.call(extra_permission)
    result = client.patch(f"/v1/organization/members/{records['member']['member'].id}", json={"role": "auditor"})
    assert result.status_code == 200 and result.json()["role"] == "auditor"
    authenticate("member")
    assert client.get("/identity").status_code == 401

    async def stored_permissions():
        async with SessionLocal() as session:
            return (await session.get(Membership, records["member"]["member"].id)).permissions

    assert client.portal.call(stored_permissions) == []


def test_invitation_is_hashed_email_bound_single_use_and_preserves_other_organization(team):
    client, records, authenticate = team
    email = records["outsider"]["user"].email
    response = client.post("/v1/organization/invitations", json={"email": email.upper(), "role": "investigator"})
    assert response.status_code == 201, response.text
    invite = response.json()
    assert invite["delivery"] == "manual" and len(invite["token"]) == 43
    assert "#organization_invite=" in invite["share_path"]
    assert invite["token"] not in client.get("/v1/organization/invitations").text

    async def stored_invitation():
        async with SessionLocal() as session:
            item = await session.scalar(select(OrganizationInvitation).where(OrganizationInvitation.email == email))
            return item.token_hash

    assert client.portal.call(stored_invitation) != invite["token"]
    payload = {"token": invite["token"]}
    assert client.post("/v1/organization/invitations/preview", json=payload).status_code == 404
    authenticate("outsider")
    preview = client.post("/v1/organization/invitations/preview", json=payload)
    assert preview.status_code == 200 and preview.json()["role_label"] == "Investigador"
    accepted = client.post("/v1/organization/invitations/accept", json=payload)
    assert accepted.status_code == 200
    assert client.post("/v1/organization/invitations/accept", json=payload).status_code == 409
    mine = client.get("/v1/organization/mine").json()["items"]
    assert len(mine) == 2
    assert sum(item["current"] for item in mine) == 1
    assert client.post("/v1/organization/switch", json={"tenant_id": accepted.json()["tenant_id"]}).status_code == 200
    identity = client.get("/identity").json()
    assert identity["roles"] == ["investigator"]
    assert identity["tenant_id"] == accepted.json()["tenant_id"]
    authenticate("outsider")
    assert client.get("/identity").status_code == 401, "Switch rotates the old session"


@pytest.mark.parametrize("invalidated", ["revoke", "resend", "expire", "issuer_demoted"])
def test_invalidated_invitation_cannot_be_accepted(team, invalidated):
    client, records, authenticate = team
    data = {"email": records["outsider"]["user"].email, "role": "lawyer"}
    invite = client.post("/v1/organization/invitations", json=data).json()
    if invalidated == "revoke":
        assert client.delete(f"/v1/organization/invitations/{invite['invitation']['id']}").status_code == 204
    elif invalidated == "resend":
        assert client.post("/v1/organization/invitations", json=data).status_code == 201
    elif invalidated == "expire":
        async def expire():
            async with SessionLocal() as session:
                item = await session.scalar(select(OrganizationInvitation).where(OrganizationInvitation.email == data["email"]))
                item.expires_at = datetime.now(UTC) - timedelta(seconds=1)
                await session.commit()
        client.portal.call(expire)
    else:
        authenticate("admin2")
        assert client.patch(f"/v1/organization/members/{records['admin']['member'].id}", json={"role": "lawyer"}).status_code == 200
    authenticate("outsider")
    assert client.post("/v1/organization/invitations/accept", json={"token": invite["token"]}).status_code == 409


def test_recent_mfa_required_for_invites_member_changes_and_switch(team):
    client, records, _ = team
    cookie = records["admin"]["cookie"]
    expiry, payload = session_store._memory[cookie]
    payload["mfa_verified_at"] = (datetime.now(UTC) - timedelta(days=2)).isoformat()
    session_store._memory[cookie] = expiry, payload
    operations = [
        ("post", "/v1/organization/invitations", {"email": "isolated@example.com"}),
        ("patch", f"/v1/organization/members/{records['member']['member'].id}", {"is_active": False}),
        ("post", "/v1/organization/switch", {"tenant_id": str(records['admin']['tenant'].id)}),
        ("post", "/v1/organization/invitations/accept", {"token": "a" * 43}),
    ]
    for method, path, body in operations:
        response = getattr(client, method)(path, json=body)
        assert response.status_code == 403
        assert response.json()["detail"]["policy_code"] == "MFA_REAUTH_REQUIRED"


async def test_membership_writers_use_postgres_tenant_row_lock():
    session = AsyncMock()
    session.scalar.return_value = Tenant(id=uuid4(), name="Isolated", slug=uuid4().hex)
    await organization._tenant_lock(session, uuid4())
    statement = session.scalar.call_args.args[0]
    sql = str(statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in sql and "tenants.id" in sql


def test_request_validation_and_cross_tenant_switch(team):
    client, records, _ = team
    assert client.post("/v1/organization/switch", json={"tenant_id": str(records["outsider"]["tenant"].id)}).status_code == 403
    target = records["member"]["member"].id
    assert client.patch(f"/v1/organization/members/{target}", json={"permissions": ["administrator"]}).status_code == 422
    assert client.patch(f"/v1/organization/members/{target}", json={}).status_code == 422
    assert client.post("/v1/organization/invitations", json={"email": records["member"]["user"].email}).status_code == 409
    assert client.post("/v1/organization/invitations", json={"email": "invalid"}).status_code == 422
