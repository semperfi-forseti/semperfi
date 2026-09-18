from __future__ import annotations

import smtplib
import ssl
from email.errors import MessageError
from email.headerregistry import Address
from email.message import EmailMessage

from starlette.concurrency import run_in_threadpool

from app.core.config import Settings, get_settings


class DeliveryUnavailable(Exception):
    """Verification email cannot be delivered through the configured SMTP service."""


def _send_verification_code(
    settings: Settings, destination: str, code: str, purpose: str
) -> None:
    if (
        not settings.smtp_host
        or not settings.smtp_host.strip()
        or not settings.smtp_from_address
        or bool(settings.smtp_username) != bool(settings.smtp_password)
        or settings.smtp_security not in {"starttls", "ssl"}
    ):
        raise DeliveryUnavailable("Serviço de envio de e-mail indisponível.")

    try:
        # Bare mailbox addresses prevent header injection and ambiguous recipients.
        sender = Address(addr_spec=settings.smtp_from_address)
        recipient = Address(addr_spec=destination)
        if not sender.domain or not recipient.domain:
            raise ValueError("A mailbox domain is required.")
        message = EmailMessage()
        message["From"] = sender
        message["To"] = recipient
        message["Subject"] = "Seu código de verificação SEMPER-FI"
        action = "concluir seu cadastro" if purpose in {"register", "registration"} else "acessar sua conta"
        message.set_content(
            f"Use o código {code} para {action} no SEMPER-FI.\n\n"
            f"O código expira em {settings.auth_otp_ttl_seconds} segundos e pode ser usado uma única vez.\n"
            "Não compartilhe este código. Se você não solicitou este acesso, ignore esta mensagem.\n"
        )
        context = ssl.create_default_context()
        if settings.smtp_security == "ssl":
            connection = smtplib.SMTP_SSL(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
                context=context,
            )
        else:
            connection = smtplib.SMTP(
                settings.smtp_host,
                settings.smtp_port,
                timeout=settings.smtp_timeout_seconds,
            )
        with connection as smtp:
            if settings.smtp_security == "starttls":
                smtp.ehlo()
                smtp.starttls(context=context)
                smtp.ehlo()
            if settings.smtp_username and settings.smtp_password:
                smtp.login(settings.smtp_username, settings.smtp_password)
            refused = smtp.send_message(
                message,
                from_addr=sender.addr_spec,
                to_addrs=[recipient.addr_spec],
            )
            if refused:
                raise DeliveryUnavailable("Serviço de envio de e-mail indisponível.")
    except (OSError, smtplib.SMTPException, MessageError, ValueError, IndexError):
        # SMTP responses can contain sensitive payloads; never expose their contents.
        raise DeliveryUnavailable("Serviço de envio de e-mail indisponível.") from None


async def send_verification_code(destination: str, code: str, purpose: str) -> None:
    """Send the code without blocking the event loop or exposing it through a fallback."""
    await run_in_threadpool(_send_verification_code, get_settings(), destination, code, purpose)
