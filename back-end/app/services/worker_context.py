from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def require_tenant_id(value: str | uuid.UUID | None) -> uuid.UUID:
    """Reject legacy/unscoped messages before opening a database session."""
    if not value:
        raise ValueError("TENANT_CONTEXT_REQUIRED")
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("INVALID_TENANT_CONTEXT") from exc


async def set_worker_tenant_context(session: AsyncSession, tenant_id: uuid.UUID) -> None:
    # Transaction-local: every new transaction must establish its own context.
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT set_config('app.tenant_id', :tenant_id, true)"),
            {"tenant_id": str(tenant_id)},
        )
