from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Request
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

settings = get_settings()
engine = create_async_engine(settings.database_url, pool_pre_ping=True, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db(request: Request) -> AsyncGenerator[AsyncSession, None]:
    # Revalida a identidade no servidor e estabelece o contexto de tenant para RLS.
    from app.security.auth import get_current_principal
    principal = await get_current_principal(request)
    async with SessionLocal() as session:
        if session.bind and session.bind.dialect.name == "postgresql":
            await session.execute(text("SELECT set_config('app.tenant_id', :tenant_id, true)"), {"tenant_id": str(principal.tenant_id)})
        yield session


async def init_db() -> None:
    import app.models  # noqa: F401 - registra todos os mapeamentos
    from app.models.base import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Existing local SQLite databases predate password accounts. Add only the
        # nullable column; never rebuild tables or discard the user's data.
        # PostgreSQL and production schemas are upgraded through Alembic.
        if conn.dialect.name == "sqlite" and settings.environment in {"development", "test"}:
            columns = await conn.run_sync(lambda sync: {c["name"] for c in inspect(sync).get_columns("users")})
            if "password_hash" not in columns:
                await conn.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(512)"))
            tenant_columns = await conn.run_sync(lambda sync: {c["name"] for c in inspect(sync).get_columns("tenants")})
            if "account_type" not in tenant_columns:
                await conn.execute(text("ALTER TABLE tenants ADD COLUMN account_type VARCHAR(2)"))

async def get_unauth_db() -> AsyncGenerator[AsyncSession, None]:
    """Uso exclusivo nas rotas de identidade anteriores à autenticação da sessão."""
    async with SessionLocal() as session:
        yield session
