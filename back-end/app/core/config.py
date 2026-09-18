from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    environment: Literal["development", "test", "staging", "production"] = "development"
    app_name: str = "SEMPER-FI API"
    api_v1_prefix: str = "/v1"
    database_url: str = "sqlite+aiosqlite:///./semperfi.db"
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"
    celery_result_backend: str = "redis://localhost:6379/2"
    cors_origins: list[str] | str = Field(default_factory=lambda: ["http://localhost:3000"])

    field_encryption_key: str | None = None
    auth_mode: Literal["password", "development", "oidc"] = "password"
    allow_self_registration: bool = True
    oidc_issuer_url: str | None = None
    oidc_audience: str = "semperfi-api"
    oidc_jwks_url: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_redirect_uri: str | None = None
    mfa_max_age_seconds: int = 900
    session_cookie_name: str = "semperfi_session"
    session_ttl_seconds: int = 28_800
    auth_otp_signing_key: str | None = None
    challenge_cookie_name: str = "semperfi_verification"
    auth_otp_ttl_seconds: int = Field(default=600, gt=0)
    auth_otp_cooldown_seconds: int = Field(default=60, gt=0)
    auth_otp_max_attempts: int = Field(default=5, gt=0)

    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_from_address: str | None = None
    smtp_security: Literal["starttls", "ssl"] = "starttls"
    smtp_timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_bucket_evidence: str = "semperfi-evidence"
    s3_kms_key_id: str | None = None
    s3_object_lock_mode: Literal["GOVERNANCE", "COMPLIANCE"] = "GOVERNANCE"
    s3_object_lock_enabled: bool = True
    s3_retention_days: int = 1825
    s3_presign_expires_seconds: int = 300

    transparency_api_key: str | None = None
    datajud_api_key: str | None = None
    datajud_base_url: str = "https://api-publica.datajud.cnj.jus.br"
    brasil_api_base_url: str = "https://brasilapi.com.br/api"
    max_upload_bytes: int = 52_428_800
    allowed_mime_types: list[str] | str = Field(
        default_factory=lambda: [
            "application/pdf", "image/jpeg", "image/png", "image/tiff", "video/mp4", "video/quicktime"
        ]
    )
    evidence_staging_dir: Path = Path("var/semperfi-evidence")
    sentry_dsn: str | None = None
    log_level: str = "INFO"
    allow_development_identity_headers: bool = False

    @field_validator("cors_origins", "allowed_mime_types", mode="before")
    @classmethod
    def split_csv(cls, value: list[str] | str) -> list[str]:
        return [item.strip() for item in value.split(",") if item.strip()] if isinstance(value, str) else value


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.evidence_staging_dir.mkdir(parents=True, exist_ok=True)
    return settings
