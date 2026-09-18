import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.workers.tasks import _verify_stored_evidence


@pytest.mark.asyncio
async def test_worker_never_reports_validity_without_checking_stored_bytes(monkeypatch):
    from app import db
    from app.evidence import evidence_service

    item = SimpleNamespace(storage_bucket="test-bucket", storage_key="test-object",
                           storage_version_id="test-version", sha256="a" * 64)
    session = AsyncMock()
    session.get.return_value = item
    factory = MagicMock()
    factory.return_value.__aenter__.return_value = session
    monkeypatch.setattr(db, "SessionLocal", factory)
    verify = MagicMock(return_value=False)
    monkeypatch.setattr(evidence_service, "verify_remote_hash", verify)
    evidence_id = str(uuid.uuid4())
    result = await _verify_stored_evidence(evidence_id, item.sha256)
    assert result["verified"] is False
    verify.assert_called_once_with("test-bucket", "test-object", "test-version", item.sha256)
    with pytest.raises(ValueError, match="Hash solicitado"):
        await _verify_stored_evidence(evidence_id, "b" * 64)
    assert verify.call_count == 1
