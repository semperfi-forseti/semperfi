import hashlib
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers

from app.core.config import Settings
from app.evidence import service as evidence_module


@pytest.fixture
def service(tmp_path, monkeypatch):
    settings = SimpleNamespace(
        evidence_staging_dir=tmp_path,
        max_upload_bytes=4096,
        allowed_mime_types=["text/plain", "application/json", "application/pdf"],
        s3_bucket_evidence="isolated-test",
        s3_retention_days=1,
        s3_kms_key_id=None,
        s3_object_lock_enabled=True,
        s3_object_lock_mode="GOVERNANCE",
        s3_presign_expires_seconds=300,
    )
    monkeypatch.setattr(evidence_module, "get_settings", lambda: settings)
    instance = evidence_module.EvidenceService()
    # Exercise the fallback used when the optional `file` tool is unavailable,
    # without ever invoking external processes, antivirus or storage.
    monkeypatch.setattr(evidence_module.subprocess, "run", Mock(side_effect=FileNotFoundError))
    monkeypatch.setattr(instance, "_scan", Mock())
    monkeypatch.setattr(instance, "_extract_metadata", lambda path, mime: {"mime_type": mime})
    monkeypatch.setattr(instance, "_client", Mock(return_value=Mock()))
    return instance


def upload(content, filename="evidence.txt", mime="text/plain"):
    headers = Headers({"content-type": mime}) if mime else Headers()
    return UploadFile(file=BytesIO(content), filename=filename, headers=headers)


@pytest.mark.parametrize("filename,mime,content,expected", [
    ("captura.txt", "text/plain; charset=UTF-8", "Ação e diligência 💳\r\n".encode(), "text/plain"),
    ("captura.txt", "application/octet-stream", b"\xef\xbb\xbfTexto\n", "text/plain"),
    ("consulta.json", "application/json", '{"nome":"João","emoji":"💳"}\r\n'.encode(), "application/json"),
    ("consulta.JSON", "text/plain", b'{"result": []}', "application/json"),
    ("consulta.json", None, b"\xef\xbb\xbf[1,2,3]\n", "application/json"),
    ("consulta", "application/json", b"false", "application/json"),
    ("consulta", "application/json; charset=utf-8", b"{}", "application/json"),
    ("captura.txt", "text/plain", b"<script>alert('capture')</script>", "text/plain"),
])
async def test_text_evidence_preserves_original_bytes_hash_and_scan(service, filename, mime, content, expected):
    staged = await service.stage_upload(upload(content, filename, mime))
    assert staged.path.read_bytes() == content
    assert staged.sha256 == hashlib.sha256(content).hexdigest()
    assert staged.size_bytes == len(content)
    assert staged.detected_mime == expected
    service._scan.assert_called_once_with(staged.path)


@pytest.mark.parametrize("filename,mime,content", [
    ("invalid.txt", "text/plain", b"A\xffB"),
    ("binary.txt", "text/plain", b"A\x00B"),
    ("binary.json", "application/json", b"\x89PNG\r\n\x1a\n"),
    ("utf16.txt", "text/plain", "Texto".encode("utf-16")),
    ("hidden-pdf.txt", "text/plain", b"%PDF-1.7\n1 0 obj"),
    ("hidden-pdf.txt", "text/plain", b"\xef\xbb\xbf%PDF-1.7\n1 0 obj"),
    ("invalid.json", "application/json", b'{"result": }'),
    ("invalid.json", "text/plain", b"not JSON"),
    ("invalid.txt", "application/json", b"not JSON"),
    ("invalid.json", "application/json", b'{"value": NaN}'),
    ("invalid.json", "application/json", b'{"value": Infinity}'),
    ("empty.json", "application/json", b""),
    ("mismatch.json", "application/pdf", b"{}"),
    ("mismatch.png", "text/plain", b"ordinary text"),
    ("mismatch.html", "application/json", b"{}"),
])
async def test_invalid_text_never_stages_or_reaches_storage(service, filename, mime, content):
    with pytest.raises(ValueError):
        await service.stage_upload(upload(content, filename, mime))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []
    service._scan.assert_not_called()
    service._client.assert_not_called()


async def test_detected_binary_mismatch_rejects_text_even_when_utf8_decodes(service, monkeypatch):
    monkeypatch.setattr(evidence_module.subprocess, "run", Mock(return_value=SimpleNamespace(stdout="application/pdf\n")))
    with pytest.raises(ValueError, match="não é textual"):
        await service.stage_upload(upload(b"ascii payload", "mislabeled.txt"))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []


async def test_json_with_text_detection_is_still_parsed_and_keeps_json_type(service, monkeypatch):
    monkeypatch.setattr(evidence_module.subprocess, "run", Mock(return_value=SimpleNamespace(stdout="text/plain\n")))
    staged = await service.stage_upload(upload(b'{"items": []}', "result.json", "application/json"))
    assert staged.detected_mime == "application/json"


async def test_text_upload_respects_configured_size_and_allowlist(service):
    service.settings.max_upload_bytes = 5
    with pytest.raises(ValueError, match="limite"):
        await service.stage_upload(upload(b"123456"))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []
    service.settings.allowed_mime_types = ["application/pdf"]
    with pytest.raises(ValueError, match="MIME"):
        await service.stage_upload(upload(b"ok"))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []
    service._scan.assert_not_called()


async def test_antivirus_rejection_removes_text_from_staging(service):
    service._scan.side_effect = ValueError("Arquivo bloqueado pelo antivírus.")
    with pytest.raises(ValueError, match="antivírus"):
        await service.stage_upload(upload(b"antivirus test content"))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []
    service._client.assert_not_called()


@pytest.mark.parametrize("filename", ["..", ".", "alternate.txt:stream", "bad\n.txt", "NUL.txt", "COM1.txt", "evidence.txt "])
async def test_unsafe_filenames_are_rejected_before_staging(service, filename):
    with pytest.raises(ValueError, match="Nome"):
        await service.stage_upload(upload(b"test", filename))
    assert list(service.settings.evidence_staging_dir.iterdir()) == []


async def test_original_storage_and_download_force_attachment_without_changing_bytes(service):
    content = '{"captura":"ação 💳"}\n'.encode()
    staged = await service.stage_upload(upload(content, "C:\\fakepath\\consulta.json", "application/json"))
    assert staged.original_filename == "consulta.json"
    client = service._client.return_value
    client.put_object.return_value = {"VersionId": "test-version", "ETag": '"test-etag"'}
    stored = service.store_original(staged, "test-tenant", None)
    params = client.put_object.call_args.kwargs
    assert params["Body"] == content
    assert params["ContentType"] == "application/json"
    assert params["ContentDisposition"] == "attachment"
    assert params["Metadata"]["sha256"] == hashlib.sha256(content).hexdigest()
    assert params["ObjectLockMode"] == "GOVERNANCE"
    assert params["ObjectLockRetainUntilDate"] == stored["retain_until"]
    service.presigned_download(stored["bucket"], stored["key"], stored["version_id"])
    client.generate_presigned_url.assert_called_once_with(
        "get_object", Params={"Bucket": stored["bucket"], "Key": stored["key"],
                              "VersionId": "test-version", "ResponseContentDisposition": "attachment"},
        ExpiresIn=300,
    )


def test_default_allowlist_includes_text_and_json():
    defaults = Settings.model_fields["allowed_mime_types"].default_factory()
    assert {"text/plain", "application/json"}.issubset(defaults)
