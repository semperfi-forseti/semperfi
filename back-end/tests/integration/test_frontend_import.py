from copy import deepcopy
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import legal, legal_extra
from app.db import get_db
from app.models.base import Base
from app.security import Principal, get_current_principal


@pytest.fixture
async def import_api(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'import.sqlite'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    principal = Principal(uuid4(), uuid4(), "fixture@example.test", "Importação isolada", frozenset({"administrator"}), None, "test")

    async def database():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.include_router(legal.router, prefix="/v1")
    app.include_router(legal_extra.router, prefix="/v1")
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[get_current_principal] = lambda: principal
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://isolated.test") as client:
        yield client
    await engine.dispose()


def valid_batch():
    return {
        "clients": [{"id": "legacy-client", "name": "Pessoa isolada", "type": "PF", "document": "00000000000", "email": "fixture@example.test", "notes": "Anotação preservada", "createdAt": 0}],
        "processes": [{"id": "legacy-process", "clientId": "legacy-client", "number": "PROCESSO-TESTE", "value": "123.45", "notes": "Processo importado"}],
        "deadlines": [{"id": "legacy-deadline", "processId": "legacy-process", "title": "Prazo importado", "date": "2026-10-01", "type": "manifestation"}],
    }


@pytest.mark.parametrize("invalid", [
    "null_collection", "not_collection", "null_row", "array_row", "missing_id", "blank_name",
    "duplicate_client", "duplicate_process", "missing_client", "missing_process",
    "negative_value", "nonfinite_value", "excess_precision", "overlong_court", "invalid_date", "missing_date",
])
async def test_invalid_batch_is_rejected_before_importing_any_record(import_api, invalid):
    body = deepcopy(valid_batch())
    if invalid == "null_collection": body["clients"] = None
    elif invalid == "not_collection": body["deadlines"] = {"title": "Inválido"}
    elif invalid == "null_row": body["clients"].append(None)
    elif invalid == "array_row": body["processes"].append([])
    elif invalid == "missing_id": del body["clients"][0]["id"]
    elif invalid == "blank_name": body["clients"][0]["name"] = "  "
    elif invalid == "duplicate_client": body["clients"].append(deepcopy(body["clients"][0]))
    elif invalid == "duplicate_process": body["processes"].append(deepcopy(body["processes"][0]))
    elif invalid == "missing_client": body["processes"][0]["clientId"] = str(uuid4())
    elif invalid == "missing_process": body["deadlines"][0]["processId"] = str(uuid4())
    elif invalid == "negative_value": body["processes"][0]["value"] = "-1"
    elif invalid == "nonfinite_value": body["processes"][0]["value"] = "NaN"
    elif invalid == "excess_precision": body["processes"][0]["value"] = "1.001"
    elif invalid == "overlong_court": body["processes"][0]["court"] = "A" * 121
    elif invalid == "invalid_date": body["deadlines"][0]["date"] = "2026-02-30"
    elif invalid == "missing_date": del body["deadlines"][0]["date"]
    result = await import_api.post("/v1/imports/frontend-demo", json={"payload": body})
    assert result.status_code == 422, result.text
    assert isinstance(result.json()["detail"], list)
    assert result.json()["detail"][0]["loc"][:2] == ["body", "payload"]
    for resource in ("clients", "processes", "deadlines"):
        saved = await import_api.get(f"/v1/{resource}")
        assert saved.status_code == 200, saved.text
        assert saved.json() == []


async def test_valid_batch_remaps_identifiers_and_preserves_values(import_api):
    result = await import_api.post("/v1/imports/frontend-demo", json={"payload": valid_batch()})
    assert result.status_code == 202, result.text
    assert result.json() == {"status": "imported", "clients": 1, "processes": 1}
    clients = (await import_api.get("/v1/clients")).json()
    processes = (await import_api.get("/v1/processes")).json()
    deadlines = (await import_api.get("/v1/deadlines")).json()
    assert len(clients) == len(processes) == len(deadlines) == 1
    UUID(clients[0]["id"])
    assert processes[0]["client_id"] == clients[0]["id"]
    assert deadlines[0]["process_id"] == processes[0]["id"]
    assert Decimal(str(processes[0]["claim_value"])) == Decimal("123.45")
    assert deadlines[0]["due_date"] == "2026-10-01"
    detail = (await import_api.get(f"/v1/clients/{clients[0]['id']}")).json()
    assert detail["document"] == "00000000000"
    assert detail["email"] == "fixture@example.test"
    assert detail["notes"] == "Anotação preservada"


async def test_import_does_not_silently_link_to_existing_client_outside_file(import_api):
    created = await import_api.post("/v1/clients", json={"name": "Cliente já existente"})
    assert created.status_code == 201, created.text
    body = valid_batch()
    body["processes"][0]["clientId"] = created.json()["id"]
    result = await import_api.post("/v1/imports/frontend-demo", json={"payload": body})
    assert result.status_code == 422, result.text
    assert len((await import_api.get("/v1/clients")).json()) == 1
    assert (await import_api.get("/v1/processes")).json() == []


async def test_client_only_legacy_import_remains_supported(import_api):
    result = await import_api.post("/v1/imports/frontend-demo", json={"payload": {"clients": valid_batch()["clients"]}})
    assert result.status_code == 202, result.text
    assert result.json() == {"status": "imported", "clients": 1, "processes": 0}
