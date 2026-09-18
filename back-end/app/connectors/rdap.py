from __future__ import annotations

import re
from typing import Any

from app.connectors.base import ConnectorContext, ConnectorResult
from app.connectors.http import SafeHttpClient


class RdapConnector:
    connector_id = "rdap_dns"

    async def validate_input(self, payload: dict[str, Any]) -> None:
        domain = str(payload.get("domain", "")).lower()
        if not payload.get("authorized") or not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}", domain):
            raise ValueError("RDAP exige domínio válido e confirmação de autorização.")

    async def execute(self, payload: dict[str, Any], context: ConnectorContext) -> ConnectorResult:
        await self.validate_input(payload)
        domain = payload["domain"].lower()
        url = f"https://rdap.org/domain/{domain}"
        raw = await SafeHttpClient({"rdap.org"}).get_json(url)
        return ConnectorResult("RDAP", "rdap.org", raw, await self.normalize(raw), ["Somente para domínios próprios ou expressamente autorizados."], url)

    async def normalize(self, raw: dict[str, Any]) -> dict[str, Any]:
        return {"ldhName": raw.get("ldhName"), "status": raw.get("status", []), "events": raw.get("events", []), "nameservers": raw.get("nameservers", [])}
