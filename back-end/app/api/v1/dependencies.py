from __future__ import annotations

import secrets

from fastapi import Request


def correlation_id(request: Request) -> str:
    return request.headers.get("X-Correlation-Id") or secrets.token_hex(12)
