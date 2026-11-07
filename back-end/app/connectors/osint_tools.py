"""Public-source tools, executed and persisted through ConnectorRun workers.

Provider contracts: Google DoH JSON, GitHub/GitLab public users, BrasilAPI,
crt.sh JSON, Internet Archive availability, IPWhois HTTPS, URLhaus v1.
No SMTP probing, private APIs, target crawling or third-party script execution.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from email_validator import EmailNotValidError, validate_email

from app.connectors.base import ConnectorContext, ConnectorResult
from app.connectors.http import SafeHttpClient, require_public_ip
from app.core.config import get_settings

TOOLS = frozenset({"domain", "dns", "ip", "email", "github", "cep", "phone",
                   "urlthreat", "username", "headers", "crt", "wayback"})
DNS_TYPES = ("A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA")
SOURCE_NAMES = {"domain": "Google DNS, crt.sh e Internet Archive", "dns": "Google Public DNS",
    "ip": "IPWhois", "email": "Validação de formato e Google DNS", "github": "GitHub",
    "cep": "BrasilAPI", "phone": "Formato brasileiro e BrasilAPI", "urlthreat": "URLhaus",
    "username": "GitHub e GitLab", "headers": "Servidor HTTPS autorizado", "crt": "crt.sh",
    "wayback": "Internet Archive"}


class ProviderNotConfigured(ValueError):
    pass


class ProviderResponseError(ValueError):
    pass


def domain_name(value: str) -> str:
    try:
        name = value.rstrip(".").lower().encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise ValueError("Informe um domínio válido.") from exc
    labels = name.split(".")
    if (len(name) > 253 or len(labels) < 2 or not re.fullmatch(r"[a-z][a-z0-9-]{1,62}", labels[-1])
        or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
        or labels[-1] in {"local", "localhost", "internal", "lan", "home", "onion", "invalid", "test"}):
        raise ValueError("Informe um domínio público válido, sem caminho ou porta.")
    return name


def public_url(value: str, *, https_only: bool = False) -> str:
    if any(ord(char) < 33 or char == "\\" for char in value) or len(value) > 2048:
        raise ValueError("Informe uma URL pública válida.")
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ({"https"} if https_only else {"http", "https"})
            or not parsed.hostname or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443 if parsed.scheme == "https" else 80)):
            raise ValueError("URL não permitida.")
        host = parsed.hostname
        try:
            ipaddress.ip_address(host)
        except ValueError:
            host = domain_name(host)
        else:
            host = require_public_ip(host)
        authority = f"[{host}]" if ":" in host else host
        return urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))
    except ValueError as exc:
        raise ValueError("Use uma URL pública sem credenciais e com porta padrão.") from exc


def normalized_input(payload: dict) -> tuple[str, str]:
    tool, value = payload.get("tool"), payload.get("value")
    if not isinstance(tool, str) or tool not in TOOLS or not isinstance(value, str) or not value.strip() or len(value) > 2048:
        raise ValueError("Ferramenta ou alvo inválido.")
    if payload.get("authorized") is not True:
        raise ValueError("Confirme a finalidade legítima e a autorização para a consulta.")
    value = value.strip()
    if tool in {"domain", "dns", "crt"}:
        value = domain_name(value)
    elif tool == "ip":
        value = require_public_ip(value)
    elif tool in {"urlthreat", "headers", "wayback"}:
        if tool == "wayback" and "://" not in value:
            value = "https://" + domain_name(value)
        value = public_url(value, https_only=tool == "headers")
    elif tool == "email":
        try:
            address = validate_email(value, check_deliverability=False, allow_smtputf8=False)
            domain_name(address.domain)
            value = address.normalized
        except EmailNotValidError as exc:
            raise ValueError("Informe um e-mail com formato válido.") from exc
    elif tool in {"github", "username"}:
        pattern = r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?" if tool == "github" else r"[a-zA-Z0-9](?:[a-zA-Z0-9_.-]{0,253}[a-zA-Z0-9])?"
        if not re.fullmatch(pattern, value) or ".." in value:
            raise ValueError("Informe um nome de usuário válido, sem URL.")
    elif tool == "cep":
        if not re.fullmatch(r"\d{5}-?\d{3}", value):
            raise ValueError("Informe um CEP com oito dígitos.")
        value = value.replace("-", "")
    elif tool == "phone":
        if not re.fullmatch(r"[+\d() .-]{10,24}", value):
            raise ValueError("Informe um telefone brasileiro com DDD.")
        digits = re.sub(r"\D", "", value)
        if len(digits) in (12, 13) and digits.startswith("55"):
            digits = digits[2:]
        if not re.fullmatch(r"[1-9]\d(?:[2-5]\d{7}|9\d{8})", digits):
            raise ValueError("Informe um telefone brasileiro válido com DDD.")
        value = "+55" + digits
    return tool, value


def object_response(value) -> dict:
    if not isinstance(value, dict):
        raise ProviderResponseError("A fonte retornou formato inesperado.")
    return value


class OsintToolsConnector:
    connector_id = "osint_tools"

    async def validate_input(self, payload: dict) -> None:
        normalized_input(payload)

    async def _json(self, host: str, path: str, **kwargs):
        return await SafeHttpClient({host}, timeout_seconds=10).bounded_json("https://" + host + path, **kwargs)

    async def _dns_record(self, domain: str, record: str) -> dict:
        response = object_response(await self._json("dns.google", "/resolve",
            params={"name": domain, "type": record, "edns_client_subnet": "0.0.0.0/0"}))
        if response.get("Status") not in (0, 3) or response.get("TC") is True:
            raise ProviderResponseError("A fonte DNS não confirmou a consulta completa.")
        answers = response.get("Answer", [])
        if not isinstance(answers, list) or any(not isinstance(row, dict) for row in answers):
            raise ProviderResponseError("Resposta DNS inválida.")
        return {"status": response["Status"], "answers": answers[:100], "truncated": len(answers) > 100}

    async def _dns(self, domain: str) -> tuple[dict, list[str]]:
        responses = await asyncio.gather(*(self._dns_record(domain, record) for record in DNS_TYPES), return_exceptions=True)
        records, missing = {}, []
        for record, response in zip(DNS_TYPES, responses, strict=True):
            if isinstance(response, Exception):
                missing.append(record)
            else:
                records[record] = response
        if not records:
            raise ProviderResponseError("As fontes DNS não responderam. Nenhum resultado foi confirmado.")
        notes = ["Tipos DNS indisponíveis: " + ", ".join(missing) + "."] if missing else []
        if any(row["truncated"] for row in records.values()):
            notes.append("Resultados DNS limitados a 100 respostas por tipo.")
        return {"records": records}, notes

    async def _certificates(self, domain: str) -> dict:
        rows = await self._json("crt.sh", "/", params={"q": domain, "output": "json"})
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ProviderResponseError("Resposta de certificados inválida.")
        return {"certificates": rows[:100], "returned": min(100, len(rows)), "truncated": len(rows) > 100}

    async def _wayback(self, value: str) -> dict:
        response = object_response(await self._json("archive.org", "/wayback/available", params={"url": value}))
        if not isinstance(response.get("archived_snapshots"), dict):
            raise ProviderResponseError("O arquivo histórico não confirmou a consulta.")
        return response

    async def _github(self, username: str) -> dict:
        try:
            profile = object_response(await self._json("api.github.com", "/users/" + quote(username, safe=""),
                headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}))
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return {"found": False}
            raise
        if str(profile.get("login", "")).casefold() != username.casefold() or not isinstance(profile.get("id"), int):
            raise ProviderResponseError("O GitHub não confirmou o perfil solicitado.")
        fields = {"login", "id", "html_url", "type", "name", "company", "blog", "location", "bio",
                  "public_repos", "public_gists", "followers", "following", "created_at", "updated_at"}
        return {"found": True, "profile": {key: val for key, val in profile.items() if key in fields}}

    async def _gitlab(self, username: str) -> dict:
        rows = await self._json("gitlab.com", "/api/v4/users", params={"username": username, "per_page": 20})
        if not isinstance(rows, list) or any(not isinstance(row, dict) or not isinstance(row.get("username"), str) for row in rows):
            raise ProviderResponseError("O GitLab não confirmou a consulta.")
        matching = [row for row in rows if row["username"].casefold() == username.casefold()]
        return {"found": bool(matching), "profiles": [{key: row[key] for key in ("id", "username", "name", "web_url") if key in row} for row in matching[:20]]}

    async def execute(self, payload: dict, context: ConnectorContext) -> ConnectorResult:
        tool, value = normalized_input(payload)
        async with asyncio.timeout(45):
            data, partial_notes = await self._execute(tool, value)
        notes = ["Resultados de fonte pública exigem conferência; ausência de resultado não comprova inexistência.", *partial_notes]
        raw = {"tool": tool, "target": value, "data": data, "partial": bool(partial_notes), "limitations": notes}
        return ConnectorResult(SOURCE_NAMES[tool], "1", raw, dict(raw), notes)

    async def _execute(self, tool: str, value: str) -> tuple[dict, list[str]]:
        if tool in {"dns", "domain"}:
            if tool == "dns":
                return await self._dns(value)
            responses = await asyncio.gather(self._dns(value), self._certificates(value), self._wayback("https://" + value), return_exceptions=True)
            data, notes = {}, []
            for name, response in zip(("dns", "certificates", "wayback"), responses, strict=True):
                if isinstance(response, Exception):
                    notes.append("Fonte indisponível: " + name + ".")
                elif name == "dns":
                    data[name], dns_notes = response
                    notes.extend(dns_notes)
                else:
                    data[name] = response
            if not data:
                raise ProviderResponseError("Nenhuma fonte confirmou informações para o domínio.")
            return data, notes
        if tool == "crt":
            data = await self._certificates(value)
            return data, ["Amostra limitada a 100 certificados."] if data["truncated"] else []
        if tool == "wayback":
            return await self._wayback(value), []
        if tool == "github":
            return await self._github(value), []
        if tool == "username":
            responses = await asyncio.gather(self._github(value), self._gitlab(value), return_exceptions=True)
            data, notes = {}, []
            for name, response in zip(("GitHub", "GitLab"), responses, strict=True):
                if isinstance(response, Exception):
                    notes.append("Fonte indisponível: " + name + ".")
                else:
                    data[name] = response
            if not data:
                raise ProviderResponseError("Nenhuma plataforma confirmou a consulta.")
            return data, notes
        if tool == "ip":
            response = object_response(await self._json("ipwho.is", "/" + quote(value, safe=":"), params={"lang": "pt-BR"}))
            if response.get("success") is not True or response.get("ip") != value:
                raise ProviderResponseError("A fonte não confirmou informações para o IP.")
            response["limitation"] = "Geolocalização aproximada da rede; não identifica pessoa ou posição em tempo real. VPN/proxy não foram verificados."
            return response, []
        if tool == "email":
            response = await self._dns_record(value.rsplit("@", 1)[1], "MX")
            mx = [row.get("data") for row in response["answers"] if row.get("type") == 15]
            return {"format_valid": True, "mx_records": mx, "dns_status": response["status"],
                    "null_mx": any(str(row).strip() == "0 ." for row in mx), "mailbox_confirmed": None,
                    "disposable_confirmed": None,
                    "limitation": "Formato e DNS não confirmam existência, entrega, titularidade ou caráter descartável da caixa postal."}, []
        if tool == "cep":
            response = object_response(await self._json("brasilapi.com.br", "/api/cep/v2/" + value))
            if str(response.get("cep", "")).replace("-", "") != value or not response.get("state"):
                raise ProviderResponseError("A fonte não confirmou o CEP solicitado.")
            return response, []
        if tool == "phone":
            ddd = value[3:5]
            response = object_response(await self._json("brasilapi.com.br", "/api/ddd/v1/" + ddd))
            if not response.get("state") or not isinstance(response.get("cities"), list):
                raise ProviderResponseError("A fonte não confirmou o DDD.")
            return {"normalized": value, "valid_format": True, "ddd": ddd, "ddd_data": response,
                    "line_confirmed": None, "limitation": "Não confirma existência da linha, operadora atual ou titularidade."}, []
        if tool == "urlthreat":
            key = getattr(get_settings(), "urlhaus_auth_key", None)
            if not key:
                raise ProviderNotConfigured("O administrador precisa configurar a credencial URLhaus no servidor.")
            response = object_response(await self._json("urlhaus-api.abuse.ch", "/v1/url/", data={"url": value}, headers={"Auth-Key": key}))
            if response.get("query_status") not in {"ok", "no_results"}:
                raise ProviderResponseError("O URLhaus não confirmou a consulta.")
            response["limitation"] = "Ausência de registro na fonte não significa que a URL é segura. O endereço consultado não foi acessado."
            return response, []
        if tool == "headers":
            host = urlsplit(value).hostname
            data = await SafeHttpClient({host}, timeout_seconds=10).public_head(value)
            data["limitation"] = "Somente cabeçalhos públicos de uma resposta HTTPS; redirecionamentos não são seguidos e tecnologias não são inferidas."
            return data, []
        raise ValueError("Ferramenta não suportada.")

    async def normalize(self, raw: dict) -> dict:
        return dict(raw)
