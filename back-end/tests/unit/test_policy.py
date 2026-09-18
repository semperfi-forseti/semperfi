import uuid

import pytest

from app.policies import PolicyContext, PolicyEffect, policy_engine
from app.security.auth import Principal


@pytest.mark.asyncio
async def test_policy_denies_investigation_without_basis():
    principal = Principal(uuid.uuid4(), uuid.uuid4(), 'a@example.org', 'A', frozenset({'investigator'}), None, 'test')
    decision = policy_engine._decide(principal, PolicyContext(action='osint.run', purpose='x'))
    assert decision.effect == PolicyEffect.DENY
    assert decision.code == 'LEGAL_BASIS_REQUIRED'


@pytest.mark.asyncio
async def test_policy_requires_approval_for_high_risk_investigation():
    principal = Principal(uuid.uuid4(), uuid.uuid4(), 'a@example.org', 'A', frozenset({'investigator'}), None, 'test')
    decision = policy_engine._decide(principal, PolicyContext(action='osint.run', purpose='Avaliação legítima', legal_basis='legitimate_interest', authorization_reference='Contrato 1', risk_level='high'))
    assert decision.effect == PolicyEffect.REQUIRE_APPROVAL
