import pytest

from app.connectors.http import SafeHttpClient


def test_ssrf_blocks_private_ip():
    client = SafeHttpClient({'127.0.0.1'})
    with pytest.raises(ValueError):
        client.ensure_allowed('https://127.0.0.1/internal')


def test_ssrf_blocks_unapproved_host():
    client = SafeHttpClient({'brasilapi.com.br'})
    with pytest.raises(ValueError):
        client.ensure_allowed('https://example.com/')
