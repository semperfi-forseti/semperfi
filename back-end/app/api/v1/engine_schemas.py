from __future__ import annotations

import json
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.api.v1.schemas import InvestigationEngineRunCreate

ScopeCode = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=96)]


class EngineRunCreate(InvestigationEngineRunCreate):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    purpose: str = Field(min_length=10, max_length=2000)
    declared_scope: list[ScopeCode] = Field(min_length=1, max_length=20)
    request_id: uuid.UUID = Field(default_factory=uuid.uuid4)

    @field_validator("seed_facts")
    @classmethod
    def bounded_facts(cls, value: dict) -> dict:
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 16000:
            raise ValueError("Fatos declarados excedem o limite de 16.000 bytes.")
        return value


class EngineReviewCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    decision: Literal["reviewed", "rejected"]
    notes: str = Field(min_length=10, max_length=4000)

