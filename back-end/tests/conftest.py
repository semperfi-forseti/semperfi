import os
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest

TEST_DIR = Path(__file__).resolve().parents[1] / 'var' / 'test'
TEST_DIR.mkdir(parents=True, exist_ok=True)
TEST_DB = TEST_DIR / 'semperfi_pytest.db'
TEST_DB.unlink(missing_ok=True)
os.environ['ENVIRONMENT'] = 'test'
os.environ['DATABASE_URL'] = f'sqlite+aiosqlite:///{TEST_DB}'
os.environ['AUTH_MODE'] = 'development'
os.environ['ALLOW_DEVELOPMENT_IDENTITY_HEADERS'] = 'true'


@pytest.fixture(autouse=True)
def block_real_verification_transport(monkeypatch):
    from app.integrations import verification_email
    blocked = Mock(side_effect=AssertionError("Tests must mock SMTP delivery."))
    monkeypatch.setattr(verification_email.smtplib, "SMTP", blocked)
    monkeypatch.setattr(verification_email.smtplib, "SMTP_SSL", blocked)


@pytest.fixture
def verification_outbox(monkeypatch):
    from app.core.config import get_settings
    from app.security import challenges
    outbox = []

    async def deliver(destination, code, purpose):
        outbox.append({"destination": destination, "code": code, "purpose": purpose})

    monkeypatch.setattr(get_settings(), "auth_otp_signing_key", "test-only-signing-key-32-characters-minimum")
    monkeypatch.setattr(challenges, "send_verification_code", AsyncMock(side_effect=deliver))
    return outbox
