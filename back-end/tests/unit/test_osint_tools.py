import asyncio
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.connectors import http as connector_http
from app.connectors import osint_tools
from app.connectors.base import ConnectorContext

CONTEXT = ConnectorContext(
    tenant_id="test-tenant", actor_id="test-actor", correlation_id="test-run",
    purpose="Validação de fontes públicas autorizadas", authorization_reference="test-authorization",
    allowed_scopes={"digital_defensive"},
)


def payload(tool, value, **overrides):
    return {"tool": tool, "value": value, "authorized": True, **overrides}


def mock_transport(monkeypatch, handler):
    original_client = httpx.AsyncClient
    options = []

    def factory(**kwargs):
        options.append(kwargs)
        return original_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(connector_http.httpx, "AsyncClient", factory)
    return options


@pytest.mark.parametrize("tool,value,normalized", [
    ("domain", "EXAMPLE.COM.", "example.com"),
    ("dns", "ação.com.br", "xn--ao-siap.com.br"),
    ("crt", "example.com", "example.com"),
    ("ip", "2606:4700:4700:0000:0000:0000:0000:1111", "2606:4700:4700::1111"),
    ("email", "example@GMAIL.COM", "example@gmail.com"),
    ("github", "octocat", "octocat"),
    ("username", "example.name", "example.name"),
    ("cep", "01001-000", "01001000"),
    ("phone", "+55 (11) 99999-0000", "+5511999990000"),
    ("phone", "(55) 3222-0000", "+555532220000"),
    ("urlthreat", "http://example.com/path?q=1#section", "http://example.com/path?q=1"),
    ("headers", "https://example.com:443/", "https://example.com/"),
    ("wayback", "example.com", "https://example.com/"),
])
def test_all_tool_inputs_are_normalized(tool, value, normalized):
    assert osint_tools.normalized_input(payload(tool, value)) == (tool, normalized)


@pytest.mark.parametrize("authorization", [False, None, 1, "true"])
def test_authorization_requires_explicit_boolean(authorization):
    with pytest.raises(ValueError, match="autorização"):
        osint_tools.normalized_input(payload("dns", "example.com", authorized=authorization))


@pytest.mark.parametrize("tool,value", [
    ([], "example.com"), ({}, "example.com"), (None, "example.com"),
    ("unknown", "example.com"), ("dns", None), ("dns", []), ("dns", " "),
    ("dns", "x" * 2049), ("dns", "http://example.com"), ("domain", "example.local"),
    ("domain", "127.0.0.1"), ("domain", "localhost"), ("domain", "-invalid.com"),
    ("ip", "10.0.0.1"), ("ip", "not-an-ip"), ("github", "https://github.com/octocat"),
    ("username", "a..b"), ("github", "-octocat"), ("email", "no-at-sign"),
    ("cep", "0100100"), ("cep", "01001-000-injected"),
    ("phone", "+1 (212) 555-1234"), ("phone", "1199999000"),
    ("headers", "http://example.com"), ("headers", "https://example.com:8443"),
    ("urlthreat", "https://user:secret@example.com"), ("urlthreat", "https://127.0.0.1"),
    ("urlthreat", "https://example.com\\@127.0.0.1/"),
    ("wayback", "https://example.com/\ninvalid"),
])
def test_invalid_tool_inputs_are_rejected(tool, value):
    with pytest.raises(ValueError):
        osint_tools.normalized_input(payload(tool, value))


@pytest.mark.asyncio
async def test_dns_failures_are_partial_and_never_empty_success(monkeypatch):
    connector = osint_tools.OsintToolsConnector()

    async def dns_response(host, path, **kwargs):
        assert host == "dns.google" and path == "/resolve"
        assert kwargs["params"]["edns_client_subnet"] == "0.0.0.0/0"
        if kwargs["params"]["type"] != "A":
            raise httpx.ConnectError("provider unavailable")
        return {"Status": 0, "Answer": [{"type": 1, "data": "8.8.8.8"}]}

    monkeypatch.setattr(connector, "_json", dns_response)
    result = await connector.execute(payload("dns", "example.com"), CONTEXT)
    assert result.raw["partial"] is True
    assert set(result.raw["data"]["records"]) == {"A"}
    assert any("Tipos DNS indisponíveis" in note for note in result.limitations)
    assert result.normalized == result.raw

    monkeypatch.setattr(connector, "_json", AsyncMock(side_effect=httpx.ConnectError("offline")))
    with pytest.raises(osint_tools.ProviderResponseError, match="Nenhum resultado"):
        await connector.execute(payload("dns", "example.com"), CONTEXT)


@pytest.mark.parametrize("response", [{"Status": 2}, {"Status": 0, "TC": True},
    {"Status": 0, "Answer": {}}, {"Status": 0, "Answer": [None]}, []])
@pytest.mark.asyncio
async def test_dns_unconfirmed_or_malformed_responses_fail(monkeypatch, response):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value=response))
    with pytest.raises(osint_tools.ProviderResponseError):
        await connector._dns_record("example.com", "A")


@pytest.mark.asyncio
async def test_confirmed_nxdomain_is_distinct_from_provider_failure(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value={"Status": 3}))
    result = await connector.execute(payload("dns", "example.com"), CONTEXT)
    assert result.raw["partial"] is False
    assert all(record["status"] == 3 and record["answers"] == []
               for record in result.raw["data"]["records"].values())


@pytest.mark.asyncio
async def test_domain_collection_reports_each_missing_source(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_dns", AsyncMock(side_effect=httpx.ConnectError("offline")))
    monkeypatch.setattr(connector, "_certificates", AsyncMock(return_value={"certificates": []}))
    monkeypatch.setattr(connector, "_wayback", AsyncMock(side_effect=httpx.ReadTimeout("timeout")))
    result = await connector.execute(payload("domain", "example.com"), CONTEXT)
    assert result.raw["data"] == {"certificates": {"certificates": []}}
    assert result.raw["partial"] is True
    assert "Fonte indisponível: dns." in result.limitations
    assert "Fonte indisponível: wayback." in result.limitations
    monkeypatch.setattr(connector, "_certificates", AsyncMock(side_effect=ValueError("invalid response")))
    with pytest.raises(osint_tools.ProviderResponseError, match="Nenhuma fonte"):
        await connector.execute(payload("domain", "example.com"), CONTEXT)


@pytest.mark.asyncio
async def test_certificate_and_dns_samples_disclose_truncation(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value=[{"id": n} for n in range(101)]))
    result = await connector.execute(payload("crt", "example.com"), CONTEXT)
    assert len(result.raw["data"]["certificates"]) == 100
    assert result.raw["data"]["truncated"] is True and result.raw["partial"] is True
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value={"Status": 0,
        "Answer": [{"type": 1, "data": "8.8.8.8"}] * 101}))
    result = await connector.execute(payload("dns", "example.com"), CONTEXT)
    assert len(result.raw["data"]["records"]["A"]["answers"]) == 100
    assert result.raw["partial"] is True


@pytest.mark.asyncio
async def test_github_returns_confirmed_public_profile_fields_only(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    provider = AsyncMock(return_value={"id": 42, "login": "Octocat", "name": "Public name",
        "public_repos": 7, "email": "not-in-profile-contract@example.com", "private_gists": 9})
    monkeypatch.setattr(connector, "_json", provider)
    result = await connector.execute(payload("github", "octocat"), CONTEXT)
    assert result.raw["data"] == {"found": True, "profile": {
        "id": 42, "login": "Octocat", "name": "Public name", "public_repos": 7}}
    assert provider.call_args.args == ("api.github.com", "/users/octocat")
    provider.return_value = {"id": 42, "login": "another-user"}
    with pytest.raises(osint_tools.ProviderResponseError, match="perfil solicitado"):
        await connector.execute(payload("github", "octocat"), CONTEXT)


@pytest.mark.parametrize("status", [404, 403, 429, 500])
@pytest.mark.asyncio
async def test_github_not_found_is_only_confirmed_on_404(monkeypatch, status):
    connector = osint_tools.OsintToolsConnector()
    request = httpx.Request("GET", "https://api.github.com/users/example")
    error = httpx.HTTPStatusError("upstream", request=request, response=httpx.Response(status, request=request))
    monkeypatch.setattr(connector, "_json", AsyncMock(side_effect=error))
    if status == 404:
        result = await connector.execute(payload("github", "example"), CONTEXT)
        assert result.raw["data"] == {"found": False}
    else:
        with pytest.raises(httpx.HTTPStatusError):
            await connector.execute(payload("github", "example"), CONTEXT)


@pytest.mark.asyncio
async def test_username_uses_exact_matches_and_identifies_partial_sources(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_github", AsyncMock(side_effect=httpx.ConnectError("offline")))
    provider = AsyncMock(return_value=[{"id": 1, "username": "example-other"}])
    monkeypatch.setattr(connector, "_json", provider)
    result = await connector.execute(payload("username", "example"), CONTEXT)
    assert result.raw["data"] == {"GitLab": {"found": False, "profiles": []}}
    assert result.raw["partial"] is True
    assert "Fonte indisponível: GitHub." in result.limitations
    provider.return_value = [{"id": 2, "username": "EXAMPLE", "name": "Public", "private": "omit"}]
    result = await connector.execute(payload("username", "example"), CONTEXT)
    assert result.raw["data"]["GitLab"] == {"found": True, "profiles": [
        {"id": 2, "username": "EXAMPLE", "name": "Public"}]}
    provider.side_effect = httpx.ConnectError("also offline")
    with pytest.raises(osint_tools.ProviderResponseError, match="Nenhuma plataforma"):
        await connector.execute(payload("username", "example"), CONTEXT)


@pytest.mark.asyncio
async def test_email_mx_does_not_claim_mailbox_exists_or_is_disposable(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    provider = AsyncMock(return_value={"Status": 0, "Answer": [{"type": 15, "data": "0 ."}]})
    monkeypatch.setattr(connector, "_json", provider)
    result = await connector.execute(payload("email", "example@gmail.com"), CONTEXT)
    assert result.raw["data"]["null_mx"] is True
    assert result.raw["data"]["mailbox_confirmed"] is None
    assert result.raw["data"]["disposable_confirmed"] is None
    assert provider.call_args.kwargs["params"]["type"] == "MX"
    provider.side_effect = httpx.ConnectError("offline")
    with pytest.raises(httpx.ConnectError):
        await connector.execute(payload("email", "example@gmail.com"), CONTEXT)


@pytest.mark.parametrize("tool,value,response,expected", [
    ("ip", "8.8.8.8", {"ip": "8.8.8.8", "success": True}, ("ip", "8.8.8.8")),
    ("cep", "01001-000", {"cep": "01001000", "state": "SP"}, ("state", "SP")),
    ("phone", "11999990000", {"state": "SP", "cities": ["SÃO PAULO"]}, ("line_confirmed", None)),
    ("wayback", "example.com", {"archived_snapshots": {}}, ("archived_snapshots", {})),
])
@pytest.mark.asyncio
async def test_public_provider_confirmed_results(monkeypatch, tool, value, response, expected):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value=response))
    result = await connector.execute(payload(tool, value), CONTEXT)
    assert result.raw["data"][expected[0]] == expected[1]
    assert result.raw["partial"] is False
    assert result.limitations and result.source_name


@pytest.mark.parametrize("tool,value,response", [
    ("ip", "8.8.8.8", {"ip": "1.1.1.1", "success": True}),
    ("ip", "8.8.8.8", {"ip": "8.8.8.8", "success": False}),
    ("cep", "01001000", {"cep": "99999999", "state": "SP"}),
    ("cep", "01001000", {"cep": "01001000"}),
    ("phone", "11999990000", {"state": "SP", "cities": "invalid"}),
    ("wayback", "example.com", {"archived_snapshots": []}),
    ("crt", "example.com", {"error": "unavailable"}),
])
@pytest.mark.asyncio
async def test_unconfirmed_provider_results_fail(monkeypatch, tool, value, response):
    connector = osint_tools.OsintToolsConnector()
    monkeypatch.setattr(connector, "_json", AsyncMock(return_value=response))
    with pytest.raises(osint_tools.ProviderResponseError):
        await connector.execute(payload(tool, value), CONTEXT)


@pytest.mark.asyncio
async def test_urlhaus_requires_server_credential_before_request(monkeypatch):
    connector = osint_tools.OsintToolsConnector()
    provider = AsyncMock()
    monkeypatch.setattr(connector, "_json", provider)
    monkeypatch.setattr(osint_tools, "get_settings", lambda: SimpleNamespace(urlhaus_auth_key=None))
    with pytest.raises(osint_tools.ProviderNotConfigured):
        await connector.execute(payload("urlthreat", "https://example.com"), CONTEXT)
    provider.assert_not_awaited()


@pytest.mark.parametrize("status", ["ok", "no_results", "invalid_auth_key", "invalid_url", None])
@pytest.mark.asyncio
async def test_urlhaus_sends_server_key_and_does_not_claim_url_safety(monkeypatch, status):
    connector = osint_tools.OsintToolsConnector()
    provider = AsyncMock(return_value={"query_status": status})
    monkeypatch.setattr(connector, "_json", provider)
    monkeypatch.setattr(osint_tools, "get_settings", lambda: SimpleNamespace(urlhaus_auth_key="test-only-key"))
    if status not in {"ok", "no_results"}:
        with pytest.raises(osint_tools.ProviderResponseError):
            await connector.execute(payload("urlthreat", "https://example.com"), CONTEXT)
        return
    result = await connector.execute(payload("urlthreat", "https://example.com"), CONTEXT)
    assert provider.call_args.args == ("urlhaus-api.abuse.ch", "/v1/url/")
    assert provider.call_args.kwargs == {"data": {"url": "https://example.com/"},
                                       "headers": {"Auth-Key": "test-only-key"}}
    assert "não significa que a URL é segura" in result.raw["data"]["limitation"]
    assert "test-only-key" not in str(result.raw)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "192.0.2.1", "224.0.0.1", "0.0.0.0", "::1",
    "::", "fe80::1", "fc00::1", "ff02::1", "::ffff:8.8.8.8", "2002:0808:0808::1",
    "2001::1", "not-an-ip"])
def test_private_special_and_tunneled_ips_are_blocked(address):
    with pytest.raises(ValueError):
        connector_http.require_public_ip(address)


@pytest.mark.parametrize("answers", [[], ["8.8.8.8", "127.0.0.1"], ["169.254.169.254"]])
@pytest.mark.asyncio
async def test_dns_resolution_rejects_empty_or_any_private_answer(monkeypatch, answers):
    loop = asyncio.get_running_loop()
    resolver = AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (value, 443))
                                       for value in answers])
    monkeypatch.setattr(loop, "getaddrinfo", resolver)
    with pytest.raises(ValueError):
        await connector_http.resolve_public_addresses("example.com")


@pytest.mark.asyncio
async def test_header_fetch_pins_public_ip_and_preserves_tls_host_without_redirects(monkeypatch):
    resolver = AsyncMock(return_value=["8.8.8.8"])
    monkeypatch.setattr(connector_http, "resolve_public_addresses", resolver)
    requests = []

    def handler(request):
        requests.append(request)
        assert request.method == "HEAD"
        assert request.url.host == "8.8.8.8"
        assert request.url.path == "/authorized" and request.url.query == b"v=1"
        assert request.headers["Host"] == "example.com"
        assert request.extensions["sni_hostname"] == "example.com"
        return httpx.Response(302, headers={"Location": "https://127.0.0.1/private",
            "Set-Cookie": "private=value", "X-Secret": "private", "Server": "a" * 5000, "Content-Length": "0"})

    options = mock_transport(monkeypatch, handler)
    result = await connector_http.SafeHttpClient({"example.com"}).public_head("https://example.com/authorized?v=1")
    assert len(requests) == 1
    resolver.assert_awaited_once_with("example.com")
    assert result["redirect_followed"] is False and result["status"] == 302
    assert set(result["headers"]) == {"location", "server", "content-length"}
    assert len(result["headers"]["server"]) == 4096
    assert options[0]["follow_redirects"] is False and options[0]["trust_env"] is False


@pytest.mark.parametrize("url", ["http://example.com/", "https://elsewhere.com/",
    "https://user:secret@example.com/", "https://example.com:8443/", "https://example.com/#fragment"])
@pytest.mark.asyncio
async def test_json_and_head_refuse_unapproved_destinations_before_network(monkeypatch, url):
    def unexpected_request(_request):
        pytest.fail("A rejected destination must not make a network request")

    mock_transport(monkeypatch, unexpected_request)
    client = connector_http.SafeHttpClient({"example.com"})
    with pytest.raises(ValueError):
        await client.bounded_json(url)
    with pytest.raises(ValueError):
        await client.public_head(url)


@pytest.mark.parametrize("content", [b"null", b"42", b"true", b'"string"', b'{"value":NaN}',
    b'{"value":Infinity}', b"not-json", b"\xff"])
@pytest.mark.asyncio
async def test_json_client_rejects_malformed_scalars_and_nonfinite_numbers(monkeypatch, content):
    mock_transport(monkeypatch, lambda _request: httpx.Response(200, content=content))
    with pytest.raises(ValueError):
        await connector_http.SafeHttpClient({"example.com"}).bounded_json("https://example.com/")


@pytest.mark.asyncio
async def test_json_response_limits_apply_to_decoded_body(monkeypatch):
    import gzip

    compressed = gzip.compress(b'{"value":"' + b"x" * 1024 + b'"}')
    mock_transport(monkeypatch, lambda _request: httpx.Response(200, content=compressed,
                                                               headers={"Content-Encoding": "gzip"}))
    with pytest.raises(ValueError, match="limite"):
        await connector_http.SafeHttpClient({"example.com"}).bounded_json("https://example.com/", max_bytes=100)


@pytest.mark.parametrize("status", [302, 403, 429, 503])
@pytest.mark.asyncio
async def test_json_does_not_follow_redirects_or_retry_provider_errors(monkeypatch, status):
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(status, headers={"Location": "https://127.0.0.1/private"})

    mock_transport(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        await connector_http.SafeHttpClient({"example.com"}).bounded_json("https://example.com/")
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_json_form_post_has_no_proxy_or_redirect_and_reads_utf8_bom(monkeypatch):
    def handler(request):
        assert request.method == "POST"
        assert request.headers["Auth-Key"] == "test-only-key"
        assert request.headers["Content-Type"] == "application/x-www-form-urlencoded"
        assert request.content == b"url=https%3A%2F%2Fexample.com%2F"
        return httpx.Response(200, content='\ufeff{"observação":"válida"}'.encode())

    options = mock_transport(monkeypatch, handler)
    result = await connector_http.SafeHttpClient({"example.com"}).bounded_json("https://example.com/",
        data={"url": "https://example.com/"}, headers={"Auth-Key": "test-only-key"})
    assert result == {"observação": "válida"}
    assert options[0]["follow_redirects"] is False and options[0]["trust_env"] is False
