"""Database-backed, browser-bound, single-use email verification challenges."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid

from fastapi import HTTPException, Request, Response
from sqlalchemy import case, delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.integrations.verification_email import DeliveryUnavailable, send_verification_code
from app.models import AuthenticationChallenge

_development_key = secrets.token_bytes(32)
_INVALID_CODE = "Código inválido ou expirado. Inicie novamente ou solicite outro código."


def _signing_key() -> bytes:
    settings = get_settings()
    if settings.auth_otp_signing_key and len(settings.auth_otp_signing_key) >= 32:
        return settings.auth_otp_signing_key.encode("utf-8")
    if settings.environment in {"development", "test"} and not settings.auth_otp_signing_key:
        return _development_key
    raise HTTPException(status_code=503, detail="Verificação de acesso indisponível. A configuração de segurança precisa ser concluída.")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _code_hash(challenge_id: uuid.UUID, version: int, code: str) -> str:
    return hmac.new(_signing_key(), f"{challenge_id}:{version}:{code}".encode(), hashlib.sha256).hexdigest()


def _active(challenge: AuthenticationChallenge, now: int) -> bool:
    return (challenge.consumed_at is None and challenge.expires_at > now
            and challenge.attempts < get_settings().auth_otp_max_attempts)


def metadata(challenge: AuthenticationChallenge) -> dict:
    local, domain = challenge.email.rsplit("@", 1)
    now = int(time.time())
    return {
        "purpose": challenge.purpose,
        "channel": "email",
        "masked_destination": f"{local[0]}***@{domain}",
        "expires_in": max(0, challenge.expires_at - now),
        "resend_after": max(0, challenge.resend_at - now),
        "account_type": challenge.account_type,
        "delivery_failed": challenge.delivery_state == "failed",
    }


def pending_response(challenge: AuthenticationChallenge) -> dict:
    return {"authenticated": False, "verification_required": True,
            "pending_verification": metadata(challenge)}


def set_challenge_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(settings.challenge_cookie_name, token, httponly=True,
                        secure=settings.environment in {"staging", "production"},
                        samesite="lax", max_age=settings.auth_otp_ttl_seconds,
                        path=f"{settings.api_v1_prefix}/auth")


def clear_challenge_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(settings.challenge_cookie_name, path=f"{settings.api_v1_prefix}/auth")


async def pending(session: AsyncSession, request: Request) -> AuthenticationChallenge | None:
    token = request.cookies.get(get_settings().challenge_cookie_name)
    if not token or len(token) > 128:
        return None
    challenge = await session.scalar(select(AuthenticationChallenge).where(AuthenticationChallenge.token_hash == token_hash(token)))
    if not challenge:
        return None
    if not _active(challenge, int(time.time())):
        # Remove pending password hashes after expiry or consumption without
        # deleting other browsers' challenges or touching established accounts.
        await session.execute(update(AuthenticationChallenge).where(AuthenticationChallenge.id == challenge.id)
                              .values(password_hash=None))
        await session.commit()
        return None
    return challenge


def _scope(challenge: AuthenticationChallenge, now: int):
    return (
        AuthenticationChallenge.id == challenge.id,
        AuthenticationChallenge.version == challenge.version,
        AuthenticationChallenge.consumed_at.is_(None),
        AuthenticationChallenge.expires_at > now,
        AuthenticationChallenge.attempts < get_settings().auth_otp_max_attempts,
    )


async def _deliver(session: AsyncSession, challenge: AuthenticationChallenge, code: str, *, initial: bool) -> None:
    try:
        await send_verification_code(challenge.email, code, challenge.purpose)
    except DeliveryUnavailable as exc:
        if initial:
            await session.execute(delete(AuthenticationChallenge).where(AuthenticationChallenge.id == challenge.id))
        else:
            await session.execute(update(AuthenticationChallenge).where(
                AuthenticationChallenge.id == challenge.id,
                AuthenticationChallenge.version == challenge.version,
            ).values(delivery_state="failed"))
        await session.commit()
        raise HTTPException(status_code=503, detail="Não foi possível enviar o código por e-mail. O acesso não foi liberado; tente novamente mais tarde.") from exc
    result = await session.execute(update(AuthenticationChallenge).where(
        *_scope(challenge, int(time.time())),
        AuthenticationChallenge.delivery_state == "pending",
    ).values(delivery_state="sent"))
    await session.commit()
    if result.rowcount != 1:
        raise HTTPException(status_code=400, detail=_INVALID_CODE)
    challenge.delivery_state = "sent"


async def begin(session: AsyncSession, response: Response, *, purpose: str, email: str,
                account_type: str | None, password_hash: str, display_name: str | None = None,
                organization_name: str | None = None, user_id: uuid.UUID | None = None,
                tenant_id: uuid.UUID | None = None) -> dict:
    settings = get_settings()
    _signing_key()  # Fail before persisting or sending without a stable production key.
    now = int(time.time())
    previous = await session.scalar(select(AuthenticationChallenge).where(AuthenticationChallenge.email == email))
    if previous:
        if _active(previous, now) and previous.resend_at > now:
            delay = previous.resend_at - now
            raise HTTPException(status_code=429, detail="Aguarde antes de solicitar outro código.", headers={"Retry-After": str(delay)})
        removed = await session.execute(delete(AuthenticationChallenge).where(
            AuthenticationChallenge.id == previous.id, AuthenticationChallenge.version == previous.version,
        ))
        if removed.rowcount != 1:
            await session.rollback()
            raise HTTPException(status_code=409, detail="Uma nova verificação já foi iniciada. Tente novamente.")
    # Keep expired temporary credentials out of long-lived storage.
    await session.execute(delete(AuthenticationChallenge).where(AuthenticationChallenge.expires_at <= now))
    token = secrets.token_urlsafe(32)
    code = f"{secrets.randbelow(1_000_000):06d}"
    challenge_id = uuid.uuid4()
    challenge = AuthenticationChallenge(
        id=challenge_id, token_hash=token_hash(token), code_hash=_code_hash(challenge_id, 1, code),
        email=email, purpose=purpose, account_type=account_type, password_hash=password_hash,
        display_name=display_name, organization_name=organization_name, user_id=user_id,
        tenant_id=tenant_id, expires_at=now + settings.auth_otp_ttl_seconds,
        resend_at=now + settings.auth_otp_cooldown_seconds, attempts=0, version=1,
        delivery_state="pending",
    )
    session.add(challenge)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=429, detail="Aguarde antes de solicitar outro código.",
                            headers={"Retry-After": str(settings.auth_otp_cooldown_seconds)}) from exc
    await _deliver(session, challenge, code, initial=True)
    set_challenge_cookie(response, token)
    return pending_response(challenge)


async def resend(session: AsyncSession, request: Request, response: Response) -> dict:
    challenge = await pending(session, request)
    if not challenge:
        raise HTTPException(status_code=400, detail=_INVALID_CODE)
    settings = get_settings()
    now = int(time.time())
    if challenge.resend_at > now:
        raise HTTPException(status_code=429, detail="Aguarde antes de reenviar o código.",
                            headers={"Retry-After": str(challenge.resend_at - now)})
    code = f"{secrets.randbelow(1_000_000):06d}"
    while hmac.compare_digest(_code_hash(challenge.id, challenge.version, code), challenge.code_hash):
        code = f"{secrets.randbelow(1_000_000):06d}"
    next_version = challenge.version + 1
    result = await session.execute(update(AuthenticationChallenge).where(
        *_scope(challenge, now), AuthenticationChallenge.resend_at <= now,
    ).values(code_hash=_code_hash(challenge.id, next_version, code), version=next_version,
             resend_at=now + settings.auth_otp_cooldown_seconds, expires_at=now + settings.auth_otp_ttl_seconds,
             delivery_state="pending"))
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(status_code=429, detail="Um código já está sendo enviado. Aguarde para tentar novamente.")
    await session.commit()
    await session.refresh(challenge)
    await _deliver(session, challenge, code, initial=False)
    set_challenge_cookie(response, request.cookies[settings.challenge_cookie_name])
    return pending_response(challenge)


async def claim(session: AsyncSession, request: Request, code: str) -> AuthenticationChallenge:
    """Claim in the caller's transaction; identity creation and consumption commit together."""
    challenge = await pending(session, request)
    now = int(time.time())
    if not challenge or challenge.delivery_state != "sent":
        raise HTTPException(status_code=400, detail=_INVALID_CODE)
    valid = hmac.compare_digest(_code_hash(challenge.id, challenge.version, code), challenge.code_hash)
    max_attempts = get_settings().auth_otp_max_attempts
    values = {"attempts": AuthenticationChallenge.attempts + 1}
    if valid:
        values["consumed_at"] = now
    else:
        values["consumed_at"] = case((AuthenticationChallenge.attempts >= max_attempts - 1, now), else_=None)
        values["password_hash"] = case((AuthenticationChallenge.attempts >= max_attempts - 1, None), else_=AuthenticationChallenge.password_hash)
    result = await session.execute(update(AuthenticationChallenge).where(
        *_scope(challenge, now), AuthenticationChallenge.delivery_state == "sent",
    ).values(**values).execution_options(synchronize_session=False))
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(status_code=400, detail=_INVALID_CODE)
    if not valid:
        await session.commit()
        raise HTTPException(status_code=400, detail=_INVALID_CODE)
    return challenge


async def finish(session: AsyncSession, challenge: AuthenticationChallenge) -> None:
    await session.execute(update(AuthenticationChallenge).where(AuthenticationChallenge.id == challenge.id)
                          .values(password_hash=None, display_name=None, organization_name=None))


async def cancel(session: AsyncSession, request: Request, response: Response) -> None:
    token = request.cookies.get(get_settings().challenge_cookie_name)
    if token:
        await session.execute(update(AuthenticationChallenge).where(AuthenticationChallenge.token_hash == token_hash(token))
                              .values(consumed_at=int(time.time()), password_hash=None,
                                      display_name=None, organization_name=None))
        await session.commit()
    clear_challenge_cookie(response)
