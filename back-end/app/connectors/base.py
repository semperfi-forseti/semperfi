from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class ConnectorContext:
    tenant_id: str
    actor_id: str
    correlation_id: str
    purpose: str
    authorization_reference: str
    allowed_scopes: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class ConnectorResult:
    source_name: str
    source_version: str
    raw: dict[str, Any]
    normalized: dict[str, Any]
    limitations: list[str]
    source_url: str | None = None


class BaseConnector(Protocol):
    connector_id: str

    async def validate_input(self, payload: dict[str, Any]) -> None: ...
    async def execute(self, payload: dict[str, Any], context: ConnectorContext) -> ConnectorResult: ...
    async def normalize(self, raw: dict[str, Any]) -> dict[str, Any]: ...
