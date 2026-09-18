import smtplib
import ssl
from unittest.mock import AsyncMock, MagicMock, call

import pytest

from app.core.config import Settings
from app.integrations import verification_email
from app.integrations.verification_email import DeliveryUnavailable


@pytest.fixture
def smtp_setup(monkeypatch):
    settings = Settings(
        _env_file=None,
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_username="sender",
        smtp_password="smtp-password",
        smtp_from_address="no-reply@example.com",
    )
    monkeypatch.setattr(verification_email, "get_settings", lambda: settings)
    smtp = MagicMock()
    smtp.__enter__.return_value = smtp
    smtp.send_message.return_value = {}
    starttls_factory = MagicMock(return_value=smtp)
    ssl_factory = MagicMock(return_value=smtp)
    monkeypatch.setattr(verification_email.smtplib, "SMTP", starttls_factory)
    monkeypatch.setattr(verification_email.smtplib, "SMTP_SSL", ssl_factory)
    return settings, smtp, starttls_factory, ssl_factory


@pytest.mark.asyncio
async def test_starttls_sends_only_after_tls_and_authentication(smtp_setup):
    settings, smtp, starttls_factory, ssl_factory = smtp_setup

    result = await verification_email.send_verification_code("user@example.com", "123456", "register")

    assert result is None
    starttls_factory.assert_called_once_with("smtp.example.com", 587, timeout=10.0)
    ssl_factory.assert_not_called()
    context = smtp.starttls.call_args.kwargs["context"]
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    calls = smtp.method_calls
    assert [entry[0] for entry in calls] == ["ehlo", "starttls", "ehlo", "login", "send_message"]
    assert calls[3] == call.login("sender", "smtp-password")
    message = smtp.send_message.call_args.args[0]
    assert message["To"] == "user@example.com"
    assert message["From"] == settings.smtp_from_address
    assert "123456" in message.get_content()
    assert "concluir seu cadastro" in message.get_content()
    assert smtp.send_message.call_args.kwargs == {
        "from_addr": "no-reply@example.com", "to_addrs": ["user@example.com"]
    }
    smtp.__exit__.assert_called_once()


@pytest.mark.asyncio
async def test_implicit_tls_uses_ssl_without_starttls(smtp_setup):
    settings, smtp, starttls_factory, ssl_factory = smtp_setup
    settings.smtp_security = "ssl"
    settings.smtp_port = 465

    await verification_email.send_verification_code("user@example.com", "123456", "login")

    starttls_factory.assert_not_called()
    assert ssl_factory.call_args.args == ("smtp.example.com", 465)
    assert ssl_factory.call_args.kwargs["timeout"] == 10.0
    assert ssl_factory.call_args.kwargs["context"].verify_mode == ssl.CERT_REQUIRED
    smtp.starttls.assert_not_called()
    smtp.login.assert_called_once()
    smtp.send_message.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing_field", ["smtp_host", "smtp_from_address", "smtp_username", "smtp_password"]
)
async def test_missing_configuration_never_connects(smtp_setup, missing_field):
    settings, smtp, starttls_factory, ssl_factory = smtp_setup
    setattr(settings, missing_field, None)

    with pytest.raises(DeliveryUnavailable):
        await verification_email.send_verification_code("user@example.com", "123456", "login")

    starttls_factory.assert_not_called()
    ssl_factory.assert_not_called()
    smtp.send_message.assert_not_called()


@pytest.mark.asyncio
async def test_trusted_relay_still_requires_tls(smtp_setup):
    settings, smtp, _, _ = smtp_setup
    settings.smtp_username = None
    settings.smtp_password = None

    await verification_email.send_verification_code("user@example.com", "123456", "login")

    smtp.starttls.assert_called_once()
    smtp.login.assert_not_called()
    smtp.send_message.assert_called_once()


@pytest.mark.asyncio
async def test_tls_failure_never_authenticates_or_sends(smtp_setup):
    _, smtp, _, _ = smtp_setup
    smtp.starttls.side_effect = smtplib.SMTPNotSupportedError("TLS unavailable")

    with pytest.raises(DeliveryUnavailable):
        await verification_email.send_verification_code("user@example.com", "123456", "login")

    smtp.login.assert_not_called()
    smtp.send_message.assert_not_called()
    smtp.__exit__.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [TimeoutError("123456"), smtplib.SMTPDataError(550, b"123456")]
)
async def test_transport_failures_do_not_expose_code(smtp_setup, capsys, caplog, failure):
    _, smtp, _, _ = smtp_setup
    smtp.send_message.side_effect = failure

    with pytest.raises(DeliveryUnavailable) as caught:
        await verification_email.send_verification_code("user@example.com", "123456", "login")

    assert "123456" not in str(caught.value)
    assert caught.value.__suppress_context__ is True
    assert "123456" not in capsys.readouterr().out + caplog.text
    smtp.__exit__.assert_called_once()


@pytest.mark.asyncio
async def test_refused_recipient_is_delivery_failure(smtp_setup):
    _, smtp, _, _ = smtp_setup
    smtp.send_message.return_value = {"user@example.com": (550, b"Refused")}

    with pytest.raises(DeliveryUnavailable):
        await verification_email.send_verification_code("user@example.com", "123456", "login")


@pytest.mark.asyncio
async def test_header_injection_never_connects(smtp_setup):
    _, _, starttls_factory, ssl_factory = smtp_setup

    with pytest.raises(DeliveryUnavailable):
        await verification_email.send_verification_code(
            "user@example.com\r\nBcc: attacker@example.com", "123456", "login"
        )

    starttls_factory.assert_not_called()
    ssl_factory.assert_not_called()


@pytest.mark.asyncio
async def test_smtp_work_is_dispatched_to_threadpool(smtp_setup, monkeypatch):
    settings, _, _, _ = smtp_setup
    worker = AsyncMock()
    monkeypatch.setattr(verification_email, "run_in_threadpool", worker)

    await verification_email.send_verification_code("user@example.com", "123456", "login")

    worker.assert_awaited_once_with(
        verification_email._send_verification_code, settings, "user@example.com", "123456", "login"
    )
