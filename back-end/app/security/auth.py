from __future__ import annotations

import hashlib
import hmac
import ipaddress
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException, Request, status

from app.core.config import get_settings


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    tenant_id: uuid.UUID
    email: str
    display_name: str
    roles: frozenset[str]
    mfa_verified_at: datetime | None
    auth_method: str
    account_type: str | None = None

    def has_any_role(self, *roles: str) -> bool:
        return bool(self.roles.intersection(roles))


def _dev_uuid(value: str | None, fallback: str) -> uuid.UUID:
    try:
        return uuid.UUID(value) if value else uuid.UUID(fallback)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Cabeçalho de identidade inválido.") from exc


async def get_current_principal(request: Request) -> Principal:
    settings = get_settings()
    from app.security.sessions import session_store
    session_principal = await session_store.get(request.cookies.get(settings.session_cookie_name))
    if session_principal:
        request.state.principal = session_principal
        return session_principal
    if settings.auth_mode == "development" and settings.environment in {"development", "test"} and settings.allow_development_identity_headers:
        principal = Principal(
            user_id=_dev_uuid(request.headers.get("X-Semperfi-User-Id"), "00000000-0000-0000-0000-000000000001"),
            tenant_id=_dev_uuid(request.headers.get("X-Semperfi-Tenant-Id"), "00000000-0000-0000-0000-000000000010"),
            email=request.headers.get("X-Semperfi-Email", "dev@semperfi.local"),
            display_name=request.headers.get("X-Semperfi-Name", "Desenvolvedor SEMPER-FI"),
            roles=frozenset(filter(None, request.headers.get("X-Semperfi-Roles", "administrator,manager,lawyer,investigator,auditor").split(","))),
            mfa_verified_at=datetime.now(UTC),
            auth_method="development-header",
        )
        request.state.principal = principal
        return principal
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Autenticação necessária. Entre novamente.",
    )


def require_roles(*roles: str):
    async def dependency(principal: Principal = Depends(get_current_principal)) -> Principal:
        if not principal.has_any_role(*roles):
            raise HTTPException(status_code=403, detail={"policy_code": "RBAC_ROLE_DENIED", "reason": "Perfil insuficiente."})
        return principal
    return dependency


def require_recent_mfa(principal: Principal = Depends(get_current_principal)) -> Principal:
    age = get_settings().mfa_max_age_seconds
    if principal.mfa_verified_at is None or (datetime.now(UTC) - principal.mfa_verified_at).total_seconds() > age:
        raise HTTPException(status_code=403, detail={"policy_code": "MFA_REAUTH_REQUIRED", "reason": "Reautenticação MFA obrigatória."})
    return principal


def mask_ip(raw_ip: str | None) -> str | None:
    if not raw_ip:
        return None
    try:
        value = ipaddress.ip_address(raw_ip)
        return f"{value.exploded.rsplit(':', 1)[0]}::/64" if value.version == 6 else f"{'.'.join(value.exploded.split('.')[:3])}.0/24"
    except ValueError:
        return None


class FieldCipher:
    def __init__(self) -> None:
        raw = get_settings().field_encryption_key
        self._fernet = Fernet(raw.encode()) if raw else None

    def encrypt(self, value: str | None) -> str | None:
        if value is None:
            return None
        if not self._fernet:
            if get_settings().environment == "production":
                raise RuntimeError("FIELD_ENCRYPTION_KEY é obrigatório em produção.")
            return f"dev::{value}"
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, value: str | None) -> str | None:
        if value is None:
            return None
        if value.startswith("dev::"):
            return value.removeprefix("dev::")
        if not self._fernet:
            raise RuntimeError("Chave de criptografia indisponível.")
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken as exc:
            raise RuntimeError("Falha de integridade no campo protegido.") from exc

    @staticmethod
    def fingerprint(value: str | None) -> str | None:
        if not value:
            return None
        secret = (get_settings().field_encryption_key or "development-fingerprint-key").encode()
        return hmac.new(secret, value.strip().lower().encode(), hashlib.sha256).hexdigest()


cipher = FieldCipher()
