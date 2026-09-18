from __future__ import annotations

import secrets
from urllib.parse import urlencode

import httpx
from jose import jwt

from app.core.config import get_settings


class OidcBff:
    async def discover(self) -> dict:
        settings = get_settings()
        if not settings.oidc_issuer_url:
            raise RuntimeError("OIDC_ISSUER_URL não configurada.")
        url = f"{settings.oidc_issuer_url.rstrip('/')}/.well-known/openid-configuration"
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.json()

    async def authorization_url(self, state: str) -> str:
        settings = get_settings(); discovery = await self.discover()
        if not settings.oidc_client_id or not settings.oidc_redirect_uri:
            raise RuntimeError("Cliente OIDC não configurado.")
        return f"{discovery['authorization_endpoint']}?{urlencode({'response_type':'code','client_id':settings.oidc_client_id,'redirect_uri':settings.oidc_redirect_uri,'scope':'openid profile email','state':state,'nonce':state})}"

    async def exchange_code(self, code: str, expected_nonce: str) -> dict:
        settings = get_settings(); discovery = await self.discover()
        if not settings.oidc_client_id or not settings.oidc_client_secret or not settings.oidc_redirect_uri:
            raise RuntimeError("Cliente OIDC não configurado.")
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(discovery['token_endpoint'], data={'grant_type':'authorization_code','code':code,'redirect_uri':settings.oidc_redirect_uri,'client_id':settings.oidc_client_id,'client_secret':settings.oidc_client_secret})
            response.raise_for_status(); tokens = response.json()
            jwks_url = settings.oidc_jwks_url or discovery['jwks_uri']
            jwks = (await client.get(jwks_url)).json()
        header = jwt.get_unverified_header(tokens['id_token'])
        key = next((item for item in jwks['keys'] if item.get('kid') == header.get('kid')), None)
        if not key:
            raise RuntimeError("Chave de assinatura OIDC não encontrada.")
        claims = jwt.decode(tokens['id_token'], key, algorithms=['RS256'], audience=settings.oidc_client_id, issuer=settings.oidc_issuer_url)
        if not secrets.compare_digest(str(claims.get('nonce', '')), expected_nonce):
            raise RuntimeError("Nonce OIDC inválido.")
        return claims


oidc_bff = OidcBff()
