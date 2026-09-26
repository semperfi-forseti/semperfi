import json
from uuid import uuid4

import httpx
import pytest
from pydantic import ValidationError

from app.agents import providers
from app.services.agent_runs import normalize_input


def settings(**overrides):
    return providers.AISettings(_env_file=None, ai_provider="ollama", ollama_model="local-test:latest", **overrides)


def draft(**overrides):
    return {"facts": ["O texto relata uma reunião."], "inferences": [], "recommendations": [],
            "evidence_ids": [], "limitations": ["Sem fontes externas."], "confidence": 0.3, **overrides}


def mock_transport(monkeypatch, handler):
    client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(providers.httpx, "AsyncClient", lambda **kwargs: client(transport=transport, **kwargs))


@pytest.mark.parametrize("url", [
    "https://ollama.com", "http://8.8.8.8:11434", "http://169.254.169.254", "http://0.0.0.0",
    "http://localhost:0", "http://localhost:99999", "http://user:pass@localhost", "http://localhost/api",
    "http://localhost?key=secret", "http://localhost#fragment",
])
def test_provider_rejects_nonlocal_or_ambiguous_endpoints(url):
    with pytest.raises(ValidationError):
        settings(ollama_base_url=url)


@pytest.mark.parametrize("url", ["http://127.0.0.1:11434", "http://[::1]:11434", "http://ollama:11434", "http://192.168.1.8:11434"])
def test_local_endpoint_supported(url):
    assert settings(ollama_base_url=url).ollama_base_url == url


def test_disabled_provider_and_cloud_model_are_rejected(monkeypatch):
    monkeypatch.setattr(providers, "get_ai_settings", lambda: providers.AISettings(_env_file=None, ai_provider="disabled", ollama_model=""))
    with pytest.raises(providers.ProviderUnavailable):
        providers.get_agent_provider()
    with pytest.raises(ValidationError):
        providers.AISettings(_env_file=None, ollama_model="gpt-oss:cloud")


@pytest.mark.asyncio
async def test_structured_generation_uses_only_supplied_input(monkeypatch):
    evidence_id = str(uuid4())
    def handler(request):
        assert str(request.url) == "http://127.0.0.1:11434/api/chat"
        body = json.loads(request.content)
        assert body["stream"] is False
        assert body["format"]["additionalProperties"] is False
        assert body["options"]["temperature"] == 0
        assert "tools" not in body
        assert json.loads(body["messages"][1]["content"]) == {"text": "Reunião", "evidence_ids": [evidence_id]}
        return httpx.Response(200, json={"done": True, "message": {"role": "assistant", "content": json.dumps(draft(evidence_ids=[evidence_id]))}})
    mock_transport(monkeypatch, handler)
    result = await providers.OllamaProvider(settings()).generate("timeline", {"text": "Reunião", "evidence_ids": [evidence_id]})
    assert result.evidence_ids == [evidence_id]


@pytest.mark.parametrize("response", [
    {"done": False, "message": {"role": "assistant", "content": json.dumps(draft())}},
    {"done": True, "message": {"role": "assistant", "tool_calls": [{"name": "unsafe"}], "content": json.dumps(draft())}},
    {"done": True, "message": {"role": "assistant", "content": json.dumps(draft(evidence_ids=[str(uuid4())]))}},
    {"done": True, "message": {"role": "assistant", "content": "not-json"}},
    {"done": True, "message": {"role": "assistant", "content": json.dumps(draft(confidence=2))}},
    {"done": True, "message": {"role": "assistant", "content": json.dumps(draft(facts=["x" * 4001]))}},
    {"done": True, "message": {"role": "assistant", "content": json.dumps(draft(extra="unexpected"))}},
    [],
])
@pytest.mark.asyncio
async def test_invalid_model_output_never_becomes_a_draft(monkeypatch, response):
    mock_transport(monkeypatch, lambda request: httpx.Response(200, json=response))
    with pytest.raises(providers.InvalidAgentOutput):
        await providers.OllamaProvider(settings()).generate("report", {"text": "Texto", "evidence_ids": []})


@pytest.mark.asyncio
async def test_response_size_is_bounded(monkeypatch):
    mock_transport(monkeypatch, lambda request: httpx.Response(200, content=b"x" * 524289))
    with pytest.raises(providers.InvalidAgentOutput, match="limite"):
        await providers.OllamaProvider(settings()).generate("report", {"text": "Texto"})


@pytest.mark.parametrize("failure", ["unavailable", "timeout", "redirect"])
@pytest.mark.asyncio
async def test_transport_errors_are_sanitized(monkeypatch, failure):
    def handler(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("private-host-and-input", request=request)
        if failure == "redirect":
            return httpx.Response(302, headers={"Location": "https://external.invalid"})
        return httpx.Response(503, json={"error": "private-server-output"})
    mock_transport(monkeypatch, handler)
    with pytest.raises(providers.ProviderUnavailable) as error:
        await providers.OllamaProvider(settings()).generate("report", {"text": "Texto"})
    assert "private" not in str(error.value)


@pytest.mark.parametrize("payload", [{"text": " "}, {"text": "x" * 12001}, {"text": "ok", "execute": "unsafe"}, {"text": "ok", "evidence_ids": ["not-uuid"]}])
def test_agent_input_is_bounded_and_references_typed(payload):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        normalize_input(payload)
    assert error.value.status_code == 422
