"""Validate the complete legacy frontend export before adding any database row."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.api.v1.schemas import ClientCreate, DeadlineCreate, ProcessCreate


class ImportedClient(ClientCreate):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=255)
    kind: str = Field(default="PF", alias="type", pattern="^(PF|PJ)$")
    status: str = Field(default="active", min_length=1, max_length=32)


class ImportedProcess(ProcessCreate):
    model_config = ConfigDict(str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=255)
    client_id: str = Field(alias="clientId", min_length=1, max_length=255)
    court: str | None = Field(default=None, max_length=120)
    area: str | None = Field(default=None, max_length=64)
    phase: str | None = Field(default=None, max_length=64)
    responsible: str | None = Field(default=None, max_length=160)
    status: str = Field(default="active", min_length=1, max_length=32)
    claim_value: Decimal | None = Field(default=None, alias="value", ge=0, max_digits=14, decimal_places=2, allow_inf_nan=False)


class ImportedDeadline(DeadlineCreate):
    model_config = ConfigDict(str_strip_whitespace=True)
    process_id: str = Field(alias="processId", min_length=1, max_length=255)
    due_date: date = Field(alias="date")
    deadline_type: str = Field(default="other", alias="type", min_length=1, max_length=64)
    responsible: str | None = Field(default=None, max_length=160)
    status: str = Field(default="pending", min_length=1, max_length=32)


class FrontendImportBatch(BaseModel):
    clients: list[ImportedClient] = Field(default_factory=list)
    processes: list[ImportedProcess] = Field(default_factory=list)
    deadlines: list[ImportedDeadline] = Field(default_factory=list)


def validate_frontend_import(payload: dict) -> FrontendImportBatch:
    try:
        batch = FrontendImportBatch.model_validate(payload)
    except ValidationError as exc:
        errors = exc.errors(include_url=False, include_context=False, include_input=False)
        for error in errors:
            error["loc"] = ["body", "payload", *error["loc"]]
        raise HTTPException(status_code=422, detail=errors) from exc

    def reject(collection: str, index: int, field: str, message: str):
        raise HTTPException(status_code=422, detail=[{
            "type": "value_error", "loc": ["body", "payload", collection, index, field], "msg": message,
        }])

    client_ids, process_ids = set(), set()
    for collection, rows, seen in (("clients", batch.clients, client_ids), ("processes", batch.processes, process_ids)):
        for index, row in enumerate(rows):
            if row.id in seen:
                reject(collection, index, "id", "Identificador duplicado no arquivo. Nenhum registro foi importado.")
            seen.add(row.id)
    for index, row in enumerate(batch.processes):
        if row.client_id not in client_ids:
            reject("processes", index, "clientId", "O cliente do processo precisa estar presente no arquivo. Nenhum registro foi importado.")
    for index, row in enumerate(batch.deadlines):
        if row.process_id not in process_ids:
            reject("deadlines", index, "processId", "O processo do prazo precisa estar presente no arquivo. Nenhum registro foi importado.")
    return batch
