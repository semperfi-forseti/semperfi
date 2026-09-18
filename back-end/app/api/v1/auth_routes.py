from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db import get_unauth_db
from app.integrations.oidc import oidc_bff
from app.models import Membership, Tenant, User
from app.security import Principal, challenges, get_current_principal, rate_limiter
from app.security.passwords import hash_password, verify_password
from app.security.sessions import session_store

router = APIRouter(tags=["Authentication"])
settings = get_settings()
_oidc_states: dict[str, float] = {}


class PasswordLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr = Field(max_length=320)
    password: SecretStr = Field(min_length=12, max_length=128)
    account_type: Literal["PF", "PJ"] | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class AccountRegistration(PasswordLogin):
    account_type: Literal["PF", "PJ"]
    display_name: str = Field(min_length=2, max_length=160)
    organization_name: str | None = Field(default=None, min_length=2, max_length=160)

    @field_validator("display_name", "organization_name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @model_validator(mode="after")
    def require_organization(self):
        if self.account_type == "PJ" and not self.organization_name:
            raise ValueError("Informe o nome da organização para uma conta Pessoa Jurídica.")
        return self


class VerificationCode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(pattern=r"^[0-9]{6}$", min_length=6, max_length=6)


async def limit_password_attempts(request: Request, email: str, action: str) -> None:
    # Use the ASGI peer address; only a trusted deployment proxy may supply it.
    # Do not place addresses or e-mail addresses in Redis keys.
    peer = request.client.host if request.client else "unknown"
    ip_key = hashlib.sha256(peer.encode()).hexdigest()
    email_key = hashlib.sha256(email.encode()).hexdigest()
    window = 3600 if action == "register" else 300
    ip_limit = 10 if action == "register" else 40
    if not await rate_limiter.allow(f"auth:{action}:ip:{ip_key}", ip_limit, window):
        raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde alguns minutos e tente novamente.", headers={"Retry-After": str(window)})
    if not await rate_limiter.allow(f"auth:{action}:email:{email_key}", 10, 300):
        raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde alguns minutos e tente novamente.", headers={"Retry-After": "300"})


async def active_membership(session: AsyncSession, user_id: uuid.UUID, account_type: str | None = None) -> Membership | None:
    query = select(Membership).join(Tenant, Tenant.id == Membership.tenant_id)
    if account_type:
        # Old organizations retain their unknown legal status and may still log in.
        query = query.where(or_(Tenant.account_type == account_type, Tenant.account_type.is_(None)))
    return await session.scalar(query
        .where(Membership.user_id == user_id, Membership.is_active.is_(True), Tenant.is_active.is_(True))
        .order_by(Membership.created_at, Membership.id).limit(1)
    )


def password_principal(user: User, membership: Membership, account_type: str | None) -> Principal:
    return Principal(user.id, membership.tenant_id, user.email, user.display_name,
                     frozenset([membership.role, *membership.permissions]), datetime.now(UTC), "password", account_type)


async def start_session(request: Request, response: Response, principal: Principal) -> str:
    session_id = None
    try:
        session_id = await session_store.create(principal)
        await session_store.delete(request.cookies.get(settings.session_cookie_name))
    except Exception as exc:
        if session_id:
            try:
                await session_store.delete(session_id)
            except Exception:
                # The pending identifier has never been sent to the browser and
                # expires in session storage if the service is still unavailable.
                pass
        raise HTTPException(status_code=503, detail="Serviço de sessão indisponível. Tente novamente.") from exc
    response.set_cookie(
        key=settings.session_cookie_name, value=session_id, httponly=True,
        secure=settings.environment == "production", samesite="lax",
        max_age=settings.session_ttl_seconds, path="/",
    )
    return session_id


@router.get("/auth/status")
async def authentication_status(request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    """Public capabilities and cookie session; never creates a development identity."""
    response.headers["Cache-Control"] = "no-store"
    principal = await session_store.get(request.cookies.get(settings.session_cookie_name))
    challenge = await challenges.pending(session, request) if settings.auth_mode == "password" else None
    return {
        "authenticated": principal is not None,
        "mode": settings.auth_mode,
        "password_enabled": settings.auth_mode == "password",
        "verification_channel": "email",
        "pending_verification": challenges.metadata(challenge) if challenge else None,
        "registration_enabled": settings.auth_mode == "password" and settings.allow_self_registration,
        "development_enabled": settings.auth_mode == "development"
        and settings.environment in {"development", "test"}
        and settings.allow_development_identity_headers,
        "oidc_enabled": settings.auth_mode == "oidc" and bool(
            settings.oidc_issuer_url and settings.oidc_client_id
            and settings.oidc_client_secret and settings.oidc_redirect_uri
        ),
    }


@router.post("/auth/login")
async def password_login(body: PasswordLogin, request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    if settings.auth_mode != "password":
        raise HTTPException(status_code=403, detail="Acesso por senha não está habilitado neste ambiente.")
    email = str(body.email)
    await limit_password_attempts(request, email, "login")
    user = await session.scalar(select(User).where(func.lower(User.email) == email))
    valid = await run_in_threadpool(verify_password, body.password.get_secret_value(), user.password_hash if user else None)
    if not user or not valid or not user.is_active or user.deleted_at is not None:
        raise HTTPException(status_code=401, detail="E-mail ou senha inválidos.")
    membership = await active_membership(session, user.id, body.account_type)
    if not membership:
        raise HTTPException(status_code=401, detail="E-mail ou senha inválidos.")
    tenant = await session.get(Tenant, membership.tenant_id)
    return await challenges.begin(session, response, purpose="login", email=user.email,
                                  account_type=tenant.account_type, user_id=user.id,
                                  tenant_id=tenant.id, password_hash=user.password_hash)


@router.post("/auth/register", status_code=202)
async def register_account(body: AccountRegistration, request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    if settings.auth_mode != "password" or not settings.allow_self_registration:
        raise HTTPException(status_code=403, detail="Cadastro de novas contas não está habilitado neste ambiente.")
    email = str(body.email)
    await limit_password_attempts(request, email, "register")
    existing = await session.scalar(select(User.id).where(func.lower(User.email) == email))
    if existing:
        raise HTTPException(status_code=409, detail="Não foi possível cadastrar esta conta. Use outro e-mail ou entre com sua conta existente.")
    encoded = await run_in_threadpool(hash_password, body.password.get_secret_value())
    return await challenges.begin(session, response, purpose="register", email=email,
                                  account_type=body.account_type, password_hash=encoded,
                                  display_name=body.display_name,
                                  organization_name=body.organization_name if body.account_type == "PJ" else None)


@router.post("/auth/verify")
async def verify_code(body: VerificationCode, request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    if settings.auth_mode != "password":
        raise HTTPException(status_code=403, detail="Acesso por senha não está habilitado neste ambiente.")
    challenge = await challenges.claim(session, request, body.code)
    session_id = None
    try:
        if challenge.purpose == "register":
            if not settings.allow_self_registration:
                raise HTTPException(status_code=403, detail="Cadastro de novas contas não está habilitado neste ambiente.")
            tenant_id, user_id = uuid.uuid4(), uuid.uuid4()
            tenant = Tenant(id=tenant_id, name=challenge.organization_name or challenge.display_name,
                            account_type=challenge.account_type, slug=f"workspace-{tenant_id.hex}")
            user = User(id=user_id, email=challenge.email, display_name=challenge.display_name,
                        password_hash=challenge.password_hash)
            membership = Membership(tenant_id=tenant_id, user_id=user_id, role="administrator", permissions=[])
            session.add_all([tenant, user])
            await session.flush()
            session.add(membership)
            await session.flush()
        else:
            user = await session.get(User, challenge.user_id)
            row = (await session.execute(select(Membership, Tenant)
                    .join(Tenant, Tenant.id == Membership.tenant_id)
                    .where(Membership.user_id == challenge.user_id,
                           Membership.tenant_id == challenge.tenant_id,
                           Membership.is_active.is_(True), Tenant.is_active.is_(True)))).first()
            if (not user or not row or not user.is_active or user.deleted_at is not None
                    or user.email != challenge.email
                    or not hmac.compare_digest(user.password_hash or "", challenge.password_hash or "")):
                raise HTTPException(status_code=401, detail="Verificação de acesso inválida. Entre novamente.")
            membership, tenant = row
        await challenges.finish(session, challenge)
        session_id = await start_session(request, response, password_principal(user, membership, tenant.account_type))
        await session.commit()
    except Exception as exc:
        await session.rollback()
        if session_id:
            await session_store.delete(session_id)
        if isinstance(exc, IntegrityError):
            raise HTTPException(status_code=409, detail="Não foi possível concluir a verificação. Entre com sua conta existente.") from exc
        raise
    challenges.clear_challenge_cookie(response)
    return {"authenticated": True, "auth_mode": "password", "message": "Código verificado. Sessão iniciada."}


@router.post("/auth/resend")
async def resend_code(request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    if settings.auth_mode != "password":
        raise HTTPException(status_code=403, detail="Acesso por senha não está habilitado neste ambiente.")
    return await challenges.resend(session, request, response)


@router.post("/auth/cancel", status_code=204)
async def cancel_verification(request: Request, response: Response, session: AsyncSession = Depends(get_unauth_db)):
    await challenges.cancel(session, request, response)


@router.post("/auth/session")
async def create_or_read_session(request: Request, response: Response):
    principal = await get_current_principal(request)
    await start_session(request, response, principal)
    return {"authenticated": True, "auth_mode": principal.auth_method, "message": "Sessão opaca criada no backend."}


@router.post("/auth/logout", status_code=204)
async def logout(request: Request, response: Response):
    try:
        await session_store.delete(request.cookies.get(settings.session_cookie_name))
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Não foi possível encerrar sua sessão. Tente novamente.") from exc
    response.delete_cookie(settings.session_cookie_name, path="/")


@router.get("/auth/oidc/login")
async def oidc_login():
    if settings.auth_mode != "oidc":
        raise HTTPException(status_code=409, detail="OIDC não está habilitado.")
    state = secrets.token_urlsafe(32)
    now = datetime.now(UTC).timestamp()
    for expired in [key for key, created in _oidc_states.items() if now - created > 600]:
        _oidc_states.pop(expired, None)
    try:
        target = await oidc_bff.authorization_url(state)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Provedor de acesso indisponível. Tente novamente mais tarde.") from exc
    _oidc_states[state] = now
    redirect = RedirectResponse(target)
    redirect.set_cookie("semperfi_oidc_state", state, httponly=True,
                        secure=settings.environment == "production", samesite="lax",
                        max_age=600, path=f"{settings.api_v1_prefix}/auth/oidc")
    return redirect


@router.get("/auth/oidc/callback")
async def oidc_callback(code: str, state: str, request: Request, session: AsyncSession = Depends(get_unauth_db)):
    browser_state = request.cookies.get("semperfi_oidc_state", "")
    if not browser_state or not secrets.compare_digest(state, browser_state):
        raise HTTPException(status_code=400, detail="Estado OIDC inválido para este navegador.")
    created_at = _oidc_states.pop(state, None)
    if not created_at or datetime.now(UTC).timestamp() - created_at > 600:
        raise HTTPException(status_code=400, detail="Estado OIDC inválido ou expirado.")
    try:
        claims = await oidc_bff.exchange_code(code, state)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Não foi possível validar o acesso institucional. Inicie uma nova sessão.") from exc
    subject = claims.get("sub"); email = claims.get("email")
    if not subject or not email:
        raise HTTPException(status_code=403, detail="Provedor não retornou identificação suficiente.")
    # The provisioned subject is the identity key. E-mail alone never links an
    # external account to a local user, even when the provider verifies it.
    user = await session.scalar(select(User).where(User.oidc_subject == subject, User.is_active.is_(True), User.deleted_at.is_(None)))
    if not user:
        raise HTTPException(status_code=403, detail="Usuário não provisionado para o SEMPER-FI.")
    membership = await active_membership(session, user.id)
    if not membership:
        raise HTTPException(status_code=403, detail="Usuário sem organização ativa.")
    auth_time = claims.get("auth_time")
    mfa_time = datetime.fromtimestamp(auth_time, UTC) if auth_time and 'mfa' in claims.get('amr', []) else None
    principal = Principal(user.id, membership.tenant_id, user.email, user.display_name, frozenset([membership.role, *membership.permissions]), mfa_time, "oidc")
    redirect = RedirectResponse(url="/", status_code=302)
    redirect.delete_cookie("semperfi_oidc_state", path=f"{settings.api_v1_prefix}/auth/oidc")
    await start_session(request, redirect, principal)
    return redirect


@router.post("/auth/mfa/verify")
async def mfa_verify():
    return {"status": "delegated", "message": "MFA é validada pelo claim amr/auth_time do provedor OIDC; ações críticas exigem sessão recente."}

@router.get("/me")
async def me(principal: Principal = Depends(get_current_principal)):
    return {
        "id": principal.user_id,
        "tenant_id": principal.tenant_id,
        "email": principal.email,
        "display_name": principal.display_name,
        "roles": sorted(principal.roles),
        "mfa_verified_at": principal.mfa_verified_at,
        "account_type": principal.account_type,
    }
