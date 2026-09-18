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
        upload_id = str(uuid.uuid4())
        folder = self.settings.evidence_staging_dir / upload_id
        folder.mkdir(parents=True, exist_ok=False)
        safe_name = Path(file.filename or "upload.bin").name
        path = folder / safe_name
        digest = hashlib.sha256()
        written = 0
        with path.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > self.settings.max_upload_bytes:
                    target.close()
                    path.unlink(missing_ok=True)
                    raise ValueError("Arquivo excede o limite permitido.")
                digest.update(chunk)
                target.write(chunk)
        detected_mime = self._detect_mime(path, file.content_type)
        if detected_mime not in self.settings.allowed_mime_types:
            path.unlink(missing_ok=True)
            raise ValueError("Tipo MIME não permitido.")
        self._scan(path)
        metadata = self._extract_metadata(path, detected_mime)
        return StagedEvidence(upload_id, path, safe_name, detected_mime, written, digest.hexdigest(), metadata)

    def _detect_mime(self, path: Path, declared: str | None) -> str:
        try:
            result = subprocess.run(["file", "--brief", "--mime-type", str(path)], capture_output=True, text=True, timeout=10, check=True)
            detected = result.stdout.strip()
        except (FileNotFoundError, subprocess.SubprocessError):
            detected = mimetypes.guess_type(str(path))[0] or declared or "application/octet-stream"
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
            "ContentType": staged.detected_mime, "Metadata": {"sha256": staged.sha256, "source": "semperfi"},
        }
        if self.settings.s3_kms_key_id:
            kwargs.update({"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": self.settings.s3_kms_key_id})
        if self.settings.s3_object_lock_enabled:
            kwargs.update({"ObjectLockMode": self.settings.s3_object_lock_mode, "ObjectLockRetainUntilDate": retain_until})
        response = self._client().put_object(**kwargs)
        return {"bucket": self.settings.s3_bucket_evidence, "key": key, "version_id": response.get("VersionId"), "etag": response.get("ETag", "").strip('"'), "retain_until": retain_until}

    def presigned_download(self, bucket: str, key: str, version_id: str | None) -> str:
        params = {"Bucket": bucket, "Key": key}
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
