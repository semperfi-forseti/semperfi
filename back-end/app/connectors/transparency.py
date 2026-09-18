from __future__ import annotations

from typing import Any

from app.connectors.base import ConnectorContext, ConnectorResult
from app.connectors.http import SafeHttpClient
from app.core.config import get_settings


class TransparencyConnector:
    connector_id = "transparency"
    endpoint_map = {"ceis": "ceis", "cnep": "cnep", "cepim": "cepim"}

    async def validate_input(self, payload: dict[str, Any]) -> None:
        if payload.get("dataset") not in self.endpoint_map or not (payload.get("document") or payload.get("name")):
            raise ValueError("Consulta de integridade pública inválida.")
        if not get_settings().transparency_api_key:
            raise ValueError("Conector do Portal da Transparência não configurado.")

    async def execute(self, payload: dict[str, Any], context: ConnectorContext) -> ConnectorResult:
        await self.validate_input(payload)
        settings = get_settings()
        dataset = self.endpoint_map[payload["dataset"]]
        url = f"https://api.portaldatransparencia.gov.br/api-de-dados/{dataset}"
        headers = {"chave-api-dados": settings.transparency_api_key or ""}
        params = {"pagina": 1, "tamanhoPagina": 20}
        if payload.get("document"):
            params["cpfCnpj"] = str(payload["document"])
        if payload.get("name"):
            params["nomeSancionado"] = str(payload["name"])
        raw = await SafeHttpClient({"api.portaldatransparencia.gov.br"}).get_json(url, headers=headers, params=params)
        return ConnectorResult("Portal da Transparência", "api-de-dados", {"items": raw}, await self.normalize({"items": raw}), ["Resultado depende dos parâmetros e da atualização da base pública."], url)

    async def normalize(self, raw: dict[str, Any]) -> dict[str, Any]:
        return {"count": len(raw.get("items", [])), "items": raw.get("items", [])[:20]}
