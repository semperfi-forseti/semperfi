from __future__ import annotations

import re
from typing import Any

from app.connectors.base import ConnectorContext, ConnectorResult
from app.connectors.http import SafeHttpClient
from app.core.config import get_settings


class BrasilApiConnector:
    connector_id = "brasilapi"
    kinds = {"cnpj": "cnpj/v1/{value}", "cep": "cep/v2/{value}", "ddd": "ddd/v1/{value}", "bank": "banks/v1/{value}", "holidays": "feriados/v1/{value}"}

    async def validate_input(self, payload: dict[str, Any]) -> None:
        kind, value = payload.get("kind"), str(payload.get("value", ""))
        if kind not in self.kinds or not value:
            raise ValueError("Consulta BrasilAPI inválida.")
        if kind in {"cnpj", "cep", "ddd", "bank", "holidays"} and not re.fullmatch(r"[0-9./-]+", value):
            raise ValueError("Valor deve conter apenas caracteres numéricos permitidos.")

    async def execute(self, payload: dict[str, Any], context: ConnectorContext) -> ConnectorResult:
        await self.validate_input(payload)
        settings = get_settings()
        kind, value = payload["kind"], re.sub(r"\D", "", str(payload["value"]))
        url = f"{settings.brasil_api_base_url.rstrip('/')}/{self.kinds[kind].format(value=value)}"
        raw = await SafeHttpClient({"brasilapi.com.br"}).get_json(url)
        return ConnectorResult("BrasilAPI", "v1", raw, await self.normalize(raw), ["Fonte de conveniência; validar decisões relevantes em fonte oficial."], url)

    async def normalize(self, raw: dict[str, Any]) -> dict[str, Any]:
        keys = ("cnpj", "razao_social", "nome_fantasia", "descricao_situacao_cadastral", "cep", "city", "state", "name", "code")
        return {key: raw.get(key) for key in keys if raw.get(key) is not None}
