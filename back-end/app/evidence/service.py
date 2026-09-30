from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
from botocore.config import Config
from fastapi import UploadFile

from app.core.config import get_settings


@dataclass(frozen=True)
class StagedEvidence:
    upload_id: str
    path: Path
    original_filename: str
    detected_mime: str
    size_bytes: int
    sha256: str
    metadata: dict


class EvidenceService:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def stage_upload(self, file: UploadFile) -> StagedEvidence:
        safe_name = (file.filename or "upload.bin").replace("\\", "/").rsplit("/", 1)[-1]
        reserved_names = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
            f"{prefix}{number}" for prefix in ("COM", "LPT") for number in "123456789¹²³"
        }
        if (
            safe_name in {"", ".", ".."} or safe_name.endswith((".", " "))
            or safe_name.split(".", 1)[0].upper() in reserved_names
            or any(char in '<>:"|?*' or ord(char) < 32 or ord(char) == 127 for char in safe_name)
        ):
            raise ValueError("Nome de arquivo inválido.")
        upload_id = str(uuid.uuid4())
        folder = self.settings.evidence_staging_dir / upload_id
        folder.mkdir(parents=True, exist_ok=False)
        path = folder / safe_name
        digest = hashlib.sha256()
        written = 0
        try:
            with path.open("wb") as target:
                while chunk := await file.read(1024 * 1024):
                    written += len(chunk)
                    if written > self.settings.max_upload_bytes:
                        raise ValueError("Arquivo excede o limite permitido.")
                    digest.update(chunk)
                    target.write(chunk)
            detected_mime = self._detect_mime(path, file.content_type)
            detected_mime = self._validate_text_upload(path, file.content_type, detected_mime)
            if detected_mime not in self.settings.allowed_mime_types:
                raise ValueError("Tipo MIME não permitido.")
            self._scan(path)
            metadata = self._extract_metadata(path, detected_mime)
        except Exception:
            # This directory was just created beneath staging with a server UUID.
            # Rejected files must not survive a validation or antivirus failure.
            shutil.rmtree(folder, ignore_errors=True)
            raise
        return StagedEvidence(upload_id, path, safe_name, detected_mime, written, digest.hexdigest(), metadata)

    def _validate_text_upload(self, path: Path, declared: str | None, detected: str) -> str:
        text_types = {"text/plain", "application/json"}
        generic_types = {"", "application/octet-stream"}
        declared = (declared or "").split(";", 1)[0].strip().lower()
        extension = path.suffix.lower()
        if extension not in {".txt", ".json"} and declared not in text_types and detected not in text_types:
            return detected
        if extension not in {"", ".txt", ".json"} or declared not in text_types | generic_types:
            raise ValueError("Extensão e tipo MIME incompatíveis com evidência textual.")
        if detected not in text_types | generic_types and not detected.startswith("text/"):
            raise ValueError("O conteúdo detectado não é textual.")
        try:
            raw = path.read_bytes()
            # Accept a UTF-8 BOM without changing the original bytes or its hash.
            content = raw.decode("utf-8-sig", errors="strict")
        except UnicodeDecodeError as exc:
            raise ValueError("Evidência textual deve conter UTF-8 válido.") from exc
        if content.startswith(("%PDF-", "GIF87a", "GIF89a")) or any(
            (ord(char) < 32 and char not in "\t\r\n") or 127 <= ord(char) <= 159
            for char in content
        ):
            raise ValueError("Conteúdo binário incompatível com evidência textual.")
        if extension == ".json" or declared == "application/json" or detected == "application/json":
            def reject_constant(value: str):
                raise ValueError("Constante não permitida em JSON.")
            try:
                json.loads(content, parse_constant=reject_constant)
            except (ValueError, RecursionError) as exc:
                raise ValueError("Evidência JSON inválida.") from exc
            return "application/json"
        return "text/plain"

    def _detect_mime(self, path: Path, declared: str | None) -> str:
        try:
            result = subprocess.run(["file", "--brief", "--mime-type", str(path)], capture_output=True, text=True, timeout=10, check=True)
            detected = result.stdout.strip()
        except (FileNotFoundError, subprocess.SubprocessError):
            detected = mimetypes.guess_type(str(path))[0] or declared or "application/octet-stream"
        detected = detected.split(";", 1)[0].strip().lower()
        aliases = {"image/jpg": "image/jpeg", "application/x-empty": "application/octet-stream"}
        return aliases.get(detected, detected)

    def _scan(self, path: Path) -> None:
        try:
            result = subprocess.run(["clamdscan", "--no-summary", str(path)], capture_output=True, text=True, timeout=90)
        except FileNotFoundError:
            if self.settings.environment == "production":
                raise RuntimeError("ClamAV indisponível em ambiente de produção.")
            return
        if result.returncode == 1:
            raise ValueError("Arquivo bloqueado pelo antivírus.")
        if result.returncode not in {0}:
            raise RuntimeError("Não foi possível concluir a análise antivírus.")

    def _extract_metadata(self, path: Path, mime_type: str) -> dict:
        metadata: dict = {"mime_type": mime_type}
        try:
            result = subprocess.run(["exiftool", "-j", "-G1", "-s", str(path)], capture_output=True, text=True, timeout=30, check=True)
            records = json.loads(result.stdout)
            if records:
                allow = {"File:FileType", "File:MIMEType", "EXIF:DateTimeOriginal", "EXIF:GPSLatitude", "EXIF:GPSLongitude", "PDF:Author", "PDF:Creator", "QuickTime:Duration", "QuickTime:ImageWidth", "QuickTime:ImageHeight"}
                metadata["exiftool"] = {key: value for key, value in records[0].items() if key in allow}
        except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError):
            metadata["exiftool"] = {"status": "unavailable"}
        return metadata

    def immutable_key(self, tenant_id: str, investigation_id: str | None, sha256: str, original_filename: str) -> str:
        return f"evidence/tenant/{tenant_id}/investigation/{investigation_id or 'unlinked'}/{sha256}/original/{uuid.uuid4()}-{Path(original_filename).name}"

    def _client(self):
        return boto3.client(
            "s3", endpoint_url=self.settings.s3_endpoint_url, region_name=self.settings.s3_region,
            aws_access_key_id=self.settings.s3_access_key_id, aws_secret_access_key=self.settings.s3_secret_access_key,
            config=Config(signature_version="s3v4"),
        )

    def store_original(self, staged: StagedEvidence, tenant_id: str, investigation_id: str | None) -> dict:
        key = self.immutable_key(tenant_id, investigation_id, staged.sha256, staged.original_filename)
        retain_until = datetime.now(UTC) + timedelta(days=self.settings.s3_retention_days)
        with staged.path.open("rb") as source:
            content = source.read()
        kwargs = {
            "Bucket": self.settings.s3_bucket_evidence, "Key": key, "Body": content,
            "ContentType": staged.detected_mime, "ContentDisposition": "attachment",
            "Metadata": {"sha256": staged.sha256, "source": "semperfi"},
        }
        if self.settings.s3_kms_key_id:
            kwargs.update({"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": self.settings.s3_kms_key_id})
        if self.settings.s3_object_lock_enabled:
            kwargs.update({"ObjectLockMode": self.settings.s3_object_lock_mode, "ObjectLockRetainUntilDate": retain_until})
        response = self._client().put_object(**kwargs)
        return {"bucket": self.settings.s3_bucket_evidence, "key": key, "version_id": response.get("VersionId"), "etag": response.get("ETag", "").strip('"'), "retain_until": retain_until}

    def presigned_download(self, bucket: str, key: str, version_id: str | None) -> str:
        params = {"Bucket": bucket, "Key": key, "ResponseContentDisposition": "attachment"}
        if version_id:
            params["VersionId"] = version_id
        return self._client().generate_presigned_url("get_object", Params=params, ExpiresIn=self.settings.s3_presign_expires_seconds)

    def apply_legal_hold(self, bucket: str, key: str, version_id: str | None, hold: bool) -> None:
        if not version_id:
            raise ValueError("VersionId é obrigatório para legal hold.")
        self._client().put_object_legal_hold(Bucket=bucket, Key=key, VersionId=version_id, LegalHold={"Status": "ON" if hold else "OFF"})

    def verify_remote_hash(self, bucket: str, key: str, version_id: str | None, expected_sha256: str) -> bool:
        params = {"Bucket": bucket, "Key": key}
        if version_id:
            params["VersionId"] = version_id
        response = self._client().get_object(**params)
        digest = hashlib.sha256()
        stream = response["Body"]
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
        return digest.hexdigest() == expected_sha256

    def cleanup_stage(self, staged: StagedEvidence) -> None:
        shutil.rmtree(staged.path.parent, ignore_errors=True)


    def store_bytes(self, content: bytes, *, tenant_id: str, investigation_id: str | None, sha256: str, filename: str, content_type: str = "application/pdf") -> dict:
        key = f"evidence/tenant/{tenant_id}/investigation/{investigation_id or 'unlinked'}/{sha256}/report/{uuid.uuid4()}-{Path(filename).name}"
        retain_until = datetime.now(UTC) + timedelta(days=self.settings.s3_retention_days)
        kwargs = {"Bucket": self.settings.s3_bucket_evidence, "Key": key, "Body": content, "ContentType": content_type, "Metadata": {"sha256": sha256, "source": "semperfi-report"}}
        if self.settings.s3_kms_key_id:
            kwargs.update({"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": self.settings.s3_kms_key_id})
        if self.settings.s3_object_lock_enabled:
            kwargs.update({"ObjectLockMode": self.settings.s3_object_lock_mode, "ObjectLockRetainUntilDate": retain_until})
        response = self._client().put_object(**kwargs)
        return {"bucket": self.settings.s3_bucket_evidence, "key": key, "version_id": response.get("VersionId"), "etag": response.get("ETag", "").strip('"'), "retain_until": retain_until}


evidence_service = EvidenceService()
