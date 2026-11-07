from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
from urllib.parse import urlparse

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential


class SafeHttpClient:
    def __init__(self, allowed_hosts: set[str], timeout_seconds: float = 15.0) -> None:
        self.allowed_hosts = allowed_hosts
        self.timeout = httpx.Timeout(timeout_seconds)

    def ensure_allowed(self, url: str) -> None:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.hostname not in self.allowed_hosts:
            raise ValueError("Destino externo não autorizado pela allowlist.")
        try:
            ip = ipaddress.ip_address(parsed.hostname)
        except ValueError:
            return
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("Destino de rede privado bloqueado.")

    @retry(retry=retry_if_exception_type((httpx.HTTPError, TimeoutError)), wait=wait_exponential(min=1, max=10), stop=stop_after_attempt(3), reraise=True)
    async def get_json(self, url: str, headers: dict[str, str] | None = None, params: dict | None = None) -> dict:
        self.ensure_allowed(url)
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            response = await client.get(url, headers=headers, params=params)
            response.raise_for_status()
            return response.json()

    @retry(retry=retry_if_exception_type((httpx.HTTPError, TimeoutError)), wait=wait_exponential(min=1, max=10), stop=stop_after_attempt(3), reraise=True)
    async def post_json(self, url: str, body: dict, headers: dict[str, str] | None = None) -> dict:
        self.ensure_allowed(url)
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False) as client:
            response = await client.post(url, headers=headers, json=body)
            response.raise_for_status()
            return response.json()

    async def bounded_json(self, url: str, *, params: dict | None = None,
                           headers: dict[str, str] | None = None, data: dict | None = None,
                           max_bytes: int = 2_000_000) -> dict | list:
        """One bounded public API request, without redirects, proxy env or retries."""
        self.ensure_allowed(url)
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise ValueError("Destino externo inválido.")
        async with asyncio.timeout(20), httpx.AsyncClient(
            timeout=self.timeout, follow_redirects=False, trust_env=False,
            headers={"User-Agent": "SEMPER-FI/0.1 public-source-lookup", "Accept": "application/json"},
        ) as client:
            async with client.stream("POST" if data is not None else "GET", url,
                                     params=params, headers=headers, data=data) as response:
                response.raise_for_status()
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > max_bytes:
                        raise ValueError("A resposta da fonte ultrapassou o limite permitido.")
        def reject_constant(_):
            raise ValueError("A fonte retornou JSON inválido.")
        try:
            result = json.loads(chunks.decode("utf-8-sig"), parse_constant=reject_constant)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("A fonte não retornou JSON válido.") from exc
        if not isinstance(result, (dict, list)):
            raise ValueError("A fonte não retornou um objeto ou lista.")
        return result

    async def public_head(self, url: str) -> dict:
        """Resolve once, reject nonpublic answers, connect to that IP with TLS SNI.

        Pinning closes DNS rebinding; redirects and environment proxies are never
        followed. No target-supplied HTTP headers or credentials are accepted.
        https://www.python-httpx.org/advanced/extensions/#sni_hostname
        """
        self.ensure_allowed(url)
        parsed = urlparse(url)
        if parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise ValueError("Use uma URL HTTPS pública sem credenciais e na porta padrão.")
        host = parsed.hostname
        addresses = await resolve_public_addresses(host)
        pinned = httpx.URL(url).copy_with(host=addresses[0])
        async with asyncio.timeout(20), httpx.AsyncClient(
            timeout=self.timeout, follow_redirects=False, trust_env=False,
        ) as client:
            async with client.stream("HEAD", pinned, headers={"Host": host,
                "User-Agent": "SEMPER-FI/0.1 authorized-header-check"},
                extensions={"sni_hostname": host}) as response:
                allowed = {"server", "content-type", "content-length", "cache-control", "expires",
                    "last-modified", "etag", "location", "strict-transport-security", "content-security-policy",
                    "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy",
                    "x-powered-by", "access-control-allow-origin"}
                return {"status": response.status_code,
                        "headers": {key: value[:4096] for key, value in response.headers.items() if key in allowed},
                        "redirect_followed": False}


def require_public_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise ValueError("Informe um endereço IP público válido.") from exc
    if (not address.is_global or address.is_multicast or address.is_unspecified
        or address.is_reserved or (isinstance(address, ipaddress.IPv6Address)
            and (address.ipv4_mapped or address.sixtofour or address.teredo))):
        raise ValueError("Endereços privados ou especiais não são permitidos.")
    return address.compressed


async def resolve_public_addresses(host: str) -> list[str]:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        loop = asyncio.get_running_loop()
        async with asyncio.timeout(5):
            answers = await loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(require_public_ip(answer[4][0]) for answer in answers))
        if not addresses:
            raise ValueError("O domínio não possui endereço público confirmado.")
        return addresses
    return [require_public_ip(host)]
