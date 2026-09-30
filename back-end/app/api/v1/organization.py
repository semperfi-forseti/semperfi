from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth_routes import start_session
from app.api.v1.dependencies import correlation_id
from app.audit import append_audit
from app.db import get_db
from app.models import Membership, Tenant, User
from app.models.organization import OrganizationInvitation, OrganizationSessionVersion
from app.security import Principal, get_current_principal, require_recent_mfa

router = APIRouter(prefix="/organization", tags=["Organization"])
Role = Literal["administrator", "manager", "lawyer", "investigator", "auditor"]
ROLE_NAMES = {"administrator": "Administrador", "manager": "Gestor", "lawyer": "Advogado", "investigator": "Investigador", "auditor": "Auditor"}


class MemberUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Role | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def require_change(self):
        if self.role is None and self.is_active is None:
            raise ValueError("Informe o perfil ou a situação do acesso.")
        return self


class InvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr = Field(max_length=320)
    role: Role = "lawyer"

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class InvitationToken(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class OrganizationSwitch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: uuid.UUID


def _now() -> datetime:
    return datetime.now(UTC)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def _is_admin(member: Membership) -> bool:
    return member.role == "administrator" or "administrator" in member.permissions


def _admin(principal: Principal) -> None:
    if not principal.has_any_role("administrator"):
        raise HTTPException(403, "A gestão da equipe é restrita ao administrador.")


async def _tenant_lock(session: AsyncSession, tenant_id: uuid.UUID) -> Tenant:
    # Every membership/invitation writer acquires this same row first. PostgreSQL
    # serializes last-administrator decisions across processes and web workers.
    tenant = await session.scalar(select(Tenant).where(Tenant.id == tenant_id, Tenant.is_active.is_(True)).with_for_update())
    if tenant is None:
        raise HTTPException(404, "Organização indisponível.")
    return tenant


async def _admin_lock(session: AsyncSession, principal: Principal) -> Tenant:
    _admin(principal)
    tenant = await _tenant_lock(session, principal.tenant_id)
    # Recheck after waiting on the lock: a preceding admin may have revoked this
    # actor while this request was waiting, after authentication had completed.
    member = await session.scalar(select(Membership).join(User, User.id == Membership.user_id).where(
        Membership.tenant_id == tenant.id, Membership.user_id == principal.user_id,
        Membership.is_active.is_(True), User.is_active.is_(True), User.deleted_at.is_(None)))
    if member is None or not _is_admin(member):
        raise HTTPException(403, "Seu acesso administrativo foi alterado. Entre novamente.")
    return tenant


async def _audit(session: AsyncSession, principal: Principal, request: Request, action: str, resource_id: uuid.UUID, metadata: dict | None = None) -> None:
    await append_audit(session, principal, request, action=action, resource_type="organization",
                       resource_id=resource_id, correlation_id=correlation_id(request), metadata_safe=metadata or {})


async def _invalidate_membership(session: AsyncSession, membership: Membership) -> None:
    version = await session.get(OrganizationSessionVersion, membership.id)
    if version is None:
        session.add(OrganizationSessionVersion(membership_id=membership.id, version=secrets.token_hex(32)))
    else:
        version.version = secrets.token_hex(32)


def _member(member: Membership, user: User, principal: Principal) -> dict:
    return {"id": str(member.id), "display_name": user.display_name, "email": user.email,
            "role": member.role, "role_label": ROLE_NAMES.get(member.role, "Perfil personalizado"),
            "is_active": member.is_active, "account_active": user.is_active and user.deleted_at is None,
            "is_self": user.id == principal.user_id}


def _invitation(invite: OrganizationInvitation) -> dict:
    state = "accepted" if invite.accepted_at else "revoked" if invite.revoked_at else "expired" if _utc(invite.expires_at) <= _now() else "pending"
    return {"id": str(invite.id), "email": invite.email, "role": invite.role,
            "role_label": ROLE_NAMES[invite.role], "status": state, "expires_at": _utc(invite.expires_at),
            "created_at": _utc(invite.created_at)}


@router.get("/mine")
async def my_organizations(response: Response, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    rows = (await session.execute(select(Membership, Tenant).join(Tenant, Tenant.id == Membership.tenant_id).where(
        Membership.user_id == principal.user_id, Membership.is_active.is_(True), Tenant.is_active.is_(True)).order_by(Tenant.name))).all()
    return {"items": [{"tenant_id": str(tenant.id), "name": tenant.name, "role": member.role,
                      "role_label": ROLE_NAMES.get(member.role, "Perfil personalizado"),
                      "current": tenant.id == principal.tenant_id} for member, tenant in rows],
            "can_manage": principal.has_any_role("administrator")}


@router.post("/switch")
async def switch_organization(body: OrganizationSwitch, request: Request, response: Response,
                              session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    tenant = await _tenant_lock(session, body.tenant_id)
    row = (await session.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(
        Membership.tenant_id == tenant.id, Membership.user_id == principal.user_id,
        Membership.is_active.is_(True), User.is_active.is_(True), User.deleted_at.is_(None)))).first()
    if not row:
        raise HTTPException(403, "Você não tem acesso a esta organização.")
    member, user = row
    target = replace(principal, tenant_id=tenant.id, roles=frozenset([member.role, *member.permissions]), account_type=tenant.account_type)
    # Keep the original MFA timestamp. Switching context is not a new proof.
    await start_session(request, response, target, password_hash=user.password_hash)
    return {"switched": True, "name": tenant.name}


@router.get("/members")
async def members(response: Response, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=100),
                  session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    _admin(principal)
    query = select(Membership, User).join(User, User.id == Membership.user_id).where(Membership.tenant_id == principal.tenant_id)
    total = await session.scalar(select(func.count()).select_from(query.subquery()))
    rows = (await session.execute(query.order_by(User.display_name, Membership.id).offset(offset).limit(limit))).all()
    return {"items": [_member(member, user, principal) for member, user in rows], "total": total, "offset": offset, "limit": limit}


@router.patch("/members/{membership_id}")
async def update_member(membership_id: uuid.UUID, body: MemberUpdate, request: Request, response: Response,
                        session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    await _admin_lock(session, principal)
    row = (await session.execute(select(Membership, User).join(User, User.id == Membership.user_id).where(
        Membership.id == membership_id, Membership.tenant_id == principal.tenant_id))).first()
    if row is None:
        raise HTTPException(404, "Membro não encontrado.")
    member, user = row
    role = body.role if body.role is not None else member.role
    active = body.is_active if body.is_active is not None else member.is_active
    permissions = [] if body.role is not None else member.permissions
    loses_admin = _is_admin(member) and (not active or (role != "administrator" and "administrator" not in permissions))
    if loses_admin:
        active_members = (await session.scalars(select(Membership).join(User, User.id == Membership.user_id).where(
            Membership.tenant_id == principal.tenant_id, Membership.is_active.is_(True),
            User.is_active.is_(True), User.deleted_at.is_(None)))).all()
        if not any(other.id != member.id and _is_admin(other) for other in active_members):
            raise HTTPException(409, "A organização precisa manter pelo menos um administrador ativo.")
    if member.user_id == principal.user_id and (not active or role != member.role or permissions != member.permissions):
        raise HTTPException(409, "Peça a outro administrador para alterar seu acesso. Você não pode suspender ou reduzir o próprio acesso.")
    if active and (not user.is_active or user.deleted_at is not None):
        raise HTTPException(409, "Esta conta está indisponível. A reativação da equipe não altera a conta pessoal.")
    changed = (role, active, permissions) != (member.role, member.is_active, member.permissions)
    if changed:
        member.role, member.is_active, member.permissions = role, active, permissions
        await _invalidate_membership(session, member)
        await _audit(session, principal, request, "organization.member.updated", member.id, {"role": role, "is_active": active})
        await session.flush()
    result = _member(member, user, principal)
    await session.commit()
    return result


@router.get("/invitations")
async def invitations(response: Response, session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    _admin(principal)
    rows = (await session.scalars(select(OrganizationInvitation).where(OrganizationInvitation.tenant_id == principal.tenant_id)
                                  .order_by(OrganizationInvitation.created_at.desc(), OrganizationInvitation.id).limit(100))).all()
    return {"items": [_invitation(item) for item in rows], "limit": 100}


@router.post("/invitations", status_code=201)
async def create_invitation(body: InvitationCreate, request: Request, response: Response,
                            session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    await _admin_lock(session, principal)
    existing = await session.scalar(select(Membership).join(User, User.id == Membership.user_id).where(
        Membership.tenant_id == principal.tenant_id, func.lower(User.email) == str(body.email), Membership.is_active.is_(True)))
    if existing:
        raise HTTPException(409, "Esta pessoa já tem acesso à organização. Use a gestão da equipe para alterar o perfil.")
    pending = (await session.scalars(select(OrganizationInvitation).where(
        OrganizationInvitation.tenant_id == principal.tenant_id, OrganizationInvitation.accepted_at.is_(None),
        OrganizationInvitation.revoked_at.is_(None), OrganizationInvitation.expires_at > _now()))).all()
    if len(pending) >= 100:
        raise HTTPException(409, "Há 100 convites pendentes. Revogue os convites desnecessários antes de criar outro.")
    # Resending explicitly invalidates old links, including expired invitations.
    prior = (await session.scalars(select(OrganizationInvitation).where(
        OrganizationInvitation.tenant_id == principal.tenant_id, OrganizationInvitation.email == str(body.email),
        OrganizationInvitation.accepted_at.is_(None), OrganizationInvitation.revoked_at.is_(None)))).all()
    for item in prior:
        item.revoked_at = _now()
    token = secrets.token_urlsafe(32)
    invite = OrganizationInvitation(tenant_id=principal.tenant_id, invited_by=principal.user_id, email=str(body.email), role=body.role,
                                    token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=_now() + timedelta(days=7))
    session.add(invite)
    await session.flush()
    await _audit(session, principal, request, "organization.invitation.created", invite.id, {"role": invite.role})
    result = {"invitation": _invitation(invite), "token": token, "share_path": f"/#organization_invite={token}", "delivery": "manual"}
    await session.commit()
    return result


@router.delete("/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(invitation_id: uuid.UUID, request: Request, response: Response,
                            session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    await _admin_lock(session, principal)
    invite = await session.scalar(select(OrganizationInvitation).where(
        OrganizationInvitation.id == invitation_id, OrganizationInvitation.tenant_id == principal.tenant_id))
    if invite is None:
        raise HTTPException(404, "Convite não encontrado.")
    if invite.accepted_at:
        raise HTTPException(409, "Este convite já foi aceito. Altere o acesso na equipe.")
    if invite.revoked_at is None:
        invite.revoked_at = _now()
        await _audit(session, principal, request, "organization.invitation.revoked", invite.id)
        await session.commit()


async def _resolve_invitation(session: AsyncSession, principal: Principal, token: str, *, lock: bool) -> tuple[OrganizationInvitation, Tenant]:
    digest = hashlib.sha256(token.encode()).hexdigest()
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT set_config('app.organization_invite_hash', :digest, true)"), {"digest": digest})
    query = select(OrganizationInvitation).where(OrganizationInvitation.token_hash == digest)
    invite = await session.scalar(query)
    if invite is None or invite.email.casefold() != principal.email.casefold():
        raise HTTPException(404, "Convite indisponível para esta conta. Entre com o e-mail que recebeu o convite.")
    tenant = await _tenant_lock(session, invite.tenant_id) if lock else await session.get(Tenant, invite.tenant_id)
    if lock:
        invite = await session.scalar(query.with_for_update().execution_options(populate_existing=True))
    if tenant is None or not tenant.is_active or invite is None or invite.revoked_at or invite.accepted_at or _utc(invite.expires_at) <= _now():
        raise HTTPException(409, "Este convite expirou, foi revogado ou já foi utilizado. Solicite um novo convite.")
    issuer = await session.scalar(select(Membership).join(User, User.id == Membership.user_id).where(
        Membership.tenant_id == invite.tenant_id, Membership.user_id == invite.invited_by,
        Membership.is_active.is_(True), User.is_active.is_(True), User.deleted_at.is_(None)))
    if issuer is None or not _is_admin(issuer):
        raise HTTPException(409, "O responsável por este convite não administra mais a organização. Solicite um novo convite.")
    return invite, tenant


@router.post("/invitations/preview")
async def preview_invitation(body: InvitationToken, response: Response, session: AsyncSession = Depends(get_db),
                             principal: Principal = Depends(get_current_principal)):
    response.headers["Cache-Control"] = "no-store"
    invite, tenant = await _resolve_invitation(session, principal, body.token, lock=False)
    return {"organization_name": tenant.name, "role_label": ROLE_NAMES[invite.role], "expires_at": _utc(invite.expires_at)}


@router.post("/invitations/accept")
async def accept_invitation(body: InvitationToken, request: Request, response: Response,
                            session: AsyncSession = Depends(get_db), principal: Principal = Depends(require_recent_mfa)):
    response.headers["Cache-Control"] = "no-store"
    invite, tenant = await _resolve_invitation(session, principal, body.token, lock=True)
    member = await session.scalar(select(Membership).where(Membership.tenant_id == invite.tenant_id, Membership.user_id == principal.user_id))
    if member and member.is_active:
        raise HTTPException(409, "Você já pertence a esta organização. Selecione-a em Minhas organizações.")
    if member:
        member.is_active, member.role, member.permissions = True, invite.role, []
        await _invalidate_membership(session, member)
    else:
        member = Membership(tenant_id=invite.tenant_id, user_id=principal.user_id, role=invite.role, permissions=[], is_active=True)
        session.add(member)
    invite.accepted_at, invite.accepted_by = _now(), principal.user_id
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT set_config('app.tenant_id', :tenant, true)"), {"tenant": str(tenant.id)})
    await _audit(session, replace(principal, tenant_id=tenant.id), request, "organization.invitation.accepted", invite.id)
    await session.commit()
    # Accept and switch are separate: a session-storage outage cannot consume an
    # invitation without a recoverable way to access the newly accepted team.
    return {"accepted": True, "tenant_id": str(tenant.id), "organization_name": tenant.name}
