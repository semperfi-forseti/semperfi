from __future__ import annotations

import re
from typing import Any

from app.connectors.base import ConnectorContext, ConnectorResult
from app.connectors.http import SafeHttpClient
from app.core.config import get_settings


class DataJudConnector:
    connector_id = "datajud"

    async def validate_input(self, payload: dict[str, Any]) -> None:
        if not re.fullmatch(r"\d{7}-?\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}", str(payload.get("process_number", ""))):
            raise ValueError("Número CNJ de processo inválido.")
        if not re.fullmatch(r"[a-z0-9_]+", str(payload.get("tribunal_alias", ""))):
            raise ValueError("Alias de tribunal inválido.")
        if not get_settings().datajud_api_key:
            raise ValueError("Conector DataJud não configurado.")

    async def execute(self, payload: dict[str, Any], context: ConnectorContext) -> ConnectorResult:
        await self.validate_input(payload)
        settings = get_settings()
        number = re.sub(r"\D", "", payload["process_number"])
        alias = payload["tribunal_alias"]
        url = f"{settings.datajud_base_url.rstrip('/')}/api_publica_{alias}/_search"
        query = {"query": {"term": {"numeroProcesso": number}}, "size": 1}
        raw = await SafeHttpClient({"api-publica.datajud.cnj.jus.br"}).post_json(url, query, headers={"Authorization": f"APIKey {settings.datajud_api_key}"})
        return ConnectorResult("DataJud/CNJ", "api-publica", raw, await self.normalize(raw), ["Metadados públicos; sigilo processual deve ser respeitado."], url)

    async def normalize(self, raw: dict[str, Any]) -> dict[str, Any]:
        hits = raw.get("hits", {}).get("hits", [])
        if not hits:
            return {"found": False}
        source = hits[0].get("_source", {})
        return {"found": True, "numeroProcesso": source.get("numeroProcesso"), "classe": source.get("classe"), "assuntos": source.get("assuntos"), "movimentos": source.get("movimentos", [])}
