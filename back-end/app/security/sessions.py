from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from datetime import UTC, datetime

from redis.asyncio import Redis

from app.core.config import get_settings
from app.security.auth import Principal


class SessionStore:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._memory: dict[str, tuple[float, dict]] = {}

    async def _redis(self) -> Redis | None:
        client = None
        try:
            client = Redis.from_url(self.settings.redis_url, decode_responses=True,
                                    socket_connect_timeout=1, socket_timeout=2)
            await client.ping()
            return client
        except Exception:
            if client:
                await client.aclose()
            return None

    async def create(self, principal: Principal, *, password_hash: str | None = None) -> str:
        session_id = secrets.token_urlsafe(32)
        payload = {
            "user_id": str(principal.user_id), "tenant_id": str(principal.tenant_id),
            "email": principal.email, "display_name": principal.display_name,
            "roles": sorted(principal.roles),
            "mfa_verified_at": principal.mfa_verified_at.isoformat() if principal.mfa_verified_at else None,
            "auth_method": principal.auth_method,
            "account_type": principal.account_type,
        }
        if principal.auth_method == "password":
            if password_hash is None:
                from app.db import SessionLocal
                from app.models import User

                async with SessionLocal() as session:
                    user = await session.get(User, principal.user_id)
                    password_hash = user.password_hash if user else None
            if not password_hash:
                raise RuntimeError("Credencial de sessão indisponível.")
            # Compare on every request: changing a password revokes every old
            # session, across Redis instances and local fallback, atomically
            # with the database update. No password hash leaves the backend.
            payload["credential_version"] = hashlib.sha256(password_hash.encode()).hexdigest()
        if principal.auth_method in {"password", "oidc"}:
            from sqlalchemy import select

            from app.db import SessionLocal
            from app.models import Membership
            from app.models.organization import OrganizationSessionVersion

            async with SessionLocal() as session:
                payload["membership_version"] = await session.scalar(
                    select(OrganizationSessionVersion.version).join(
                        Membership, Membership.id == OrganizationSessionVersion.membership_id
                    ).where(Membership.tenant_id == principal.tenant_id, Membership.user_id == principal.user_id)
                )
        redis = await self._redis()
        if redis:
            try:
                await redis.setex(f"semperfi:session:{session_id}", self.settings.session_ttl_seconds, json.dumps(payload))
            finally:
                await redis.aclose()
        elif self.settings.environment in {"development", "test"}:
            self._memory[session_id] = (time.monotonic() + self.settings.session_ttl_seconds, payload)
        else:
            raise RuntimeError("Armazenamento de sessão indisponível.")
        return session_id

    async def get(self, session_id: str | None) -> Principal | None:
        if not session_id:
            return None
        raw: str | None = None
        redis = await self._redis()
        if redis:
            try:
                raw = await redis.get(f"semperfi:session:{session_id}")
            finally:
                await redis.aclose()
        elif self.settings.environment in {"development", "test"}:
            memory = self._memory.get(session_id)
            if memory and memory[0] > time.monotonic():
                raw = json.dumps(memory[1])
            elif memory:
                self._memory.pop(session_id, None)
        if not raw:
            return None
        from uuid import UUID
        try:
            payload = json.loads(raw)
            mfa = datetime.fromisoformat(payload["mfa_verified_at"]) if payload.get("mfa_verified_at") else None
            principal = Principal(UUID(payload["user_id"]), UUID(payload["tenant_id"]), payload["email"], payload["display_name"], frozenset(payload["roles"]), mfa.astimezone(UTC) if mfa else None, payload["auth_method"], payload.get("account_type"))
        except (ValueError, KeyError, TypeError):
            return None
        return await self._current_identity(principal, payload.get("credential_version"), payload.get("membership_version"))

    async def _current_identity(self, principal: Principal, credential_version: str | None = None,
                                membership_version: str | None = None) -> Principal | None:
        if principal.auth_method == "development-header":
            return principal if (self.settings.environment in {"development", "test"}
                                 and self.settings.auth_mode == "development"
                                 and self.settings.allow_development_identity_headers) else None
        if principal.auth_method not in {"password", "oidc"} or self.settings.auth_mode != principal.auth_method:
            return None
        if principal.auth_method == "password" and principal.mfa_verified_at is None:
            return None
        # Account suspension, organization suspension and changed permissions take
        # effect on the next request, including the public session-status endpoint.
        from sqlalchemy import select

        from app.db import SessionLocal
        from app.models import Membership, Tenant, User
        from app.models.organization import OrganizationSessionVersion

        async with SessionLocal() as session:
            row = (await session.execute(
                select(User, Membership, Tenant)
                .join(Membership, Membership.user_id == User.id)
                .join(Tenant, Tenant.id == Membership.tenant_id)
                .where(User.id == principal.user_id, User.is_active.is_(True), User.deleted_at.is_(None),
                       Membership.tenant_id == principal.tenant_id, Membership.is_active.is_(True), Tenant.is_active.is_(True))
            )).first()
            current_version = await session.get(OrganizationSessionVersion, row[1].id) if row else None
        if not row:
            return None
        # Suspension remains revoked after later reactivation. The boundary is
        # scoped to this membership, preserving the user's other organizations.
        if current_version and (
            not isinstance(membership_version, str)
            or not hmac.compare_digest(current_version.version, membership_version)
        ):
            return None
        user, membership, tenant = row
        if principal.auth_method == "password" and (
            not user.password_hash or not isinstance(credential_version, str)
            or not hmac.compare_digest(credential_version, hashlib.sha256(user.password_hash.encode()).hexdigest())
        ):
            return None
        return Principal(user.id, membership.tenant_id, user.email, user.display_name,
                         frozenset([membership.role, *membership.permissions]), principal.mfa_verified_at, principal.auth_method, tenant.account_type)

    async def delete(self, session_id: str | None) -> None:
        if not session_id:
            return
        redis = await self._redis()
        if redis:
            try:
                await redis.delete(f"semperfi:session:{session_id}")
            finally:
                await redis.aclose()
        elif self.settings.environment not in {"development", "test"}:
            raise RuntimeError("Armazenamento de sessão indisponível.")
        self._memory.pop(session_id, None)


session_store = SessionStore()
