import importlib

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import create_async_engine


async def test_local_schema_adds_password_column_without_losing_existing_data(tmp_path, monkeypatch):
    db_module = importlib.import_module("app.db.session")
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    monkeypatch.setattr(db_module, "engine", engine)
    async with engine.begin() as connection:
        await connection.execute(text("CREATE TABLE users (id VARCHAR PRIMARY KEY, email VARCHAR(320))"))
        await connection.execute(text("INSERT INTO users (id, email) VALUES ('preserved', 'existing@example.com')"))
    try:
        await db_module.init_db()
        await db_module.init_db()
        async with engine.connect() as connection:
            columns = await connection.run_sync(lambda sync: {c["name"] for c in inspect(sync).get_columns("users")})
            row = (await connection.execute(text("SELECT email, password_hash FROM users WHERE id = 'preserved'"))).first()
        assert "password_hash" in columns
        assert tuple(row) == ("existing@example.com", None)
    finally:
        await engine.dispose()
