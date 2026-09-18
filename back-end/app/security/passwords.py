"""Password hashing with a random salt; passwords are never stored or logged."""
from __future__ import annotations

import base64
import binascii
import hashlib
import secrets

# OWASP's 32 MiB scrypt profile: N=2^15, r=8, p=3.
_N, _R, _P = 2**15, 8, 3
_PREFIX = f"scrypt${_N}${_R}${_P}"
_DUMMY_SALT = secrets.token_bytes(16)


def _derive(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_N, r=_R, p=_P,
        maxmem=64 * 1024 * 1024, dklen=32,
    )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = _derive(password, salt)
    return f"{_PREFIX}${base64.b64encode(salt).decode('ascii')}${base64.b64encode(digest).decode('ascii')}"


def verify_password(password: str, encoded: str | None) -> bool:
    """Also perform scrypt for unknown accounts to avoid a cheap timing oracle."""
    try:
        algorithm, n, r, p, raw_salt, raw_digest = (encoded or "").split("$")
        if f"{algorithm}${n}${r}${p}" != _PREFIX:
            raise ValueError("Unsupported password hash")
        salt = base64.b64decode(raw_salt, validate=True)
        digest = base64.b64decode(raw_digest, validate=True)
        if len(salt) != 16 or len(digest) != 32:
            raise ValueError("Invalid password hash")
    except (ValueError, binascii.Error):
        _derive(password, _DUMMY_SALT)
        return False
    return secrets.compare_digest(_derive(password, salt), digest)
