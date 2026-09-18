from __future__ import annotations

import ipaddress
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
