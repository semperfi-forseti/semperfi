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


@pytest.mark.parametrize("role", ["administrator", "manager", "lawyer", "investigator", "analyst", "auditor", "unknown", ""])
def test_legal_policy_roles_cover_all_read_and_write_actions(role):
    principal = Principal(uuid.uuid4(), uuid.uuid4(), 'a@example.org', 'A', frozenset({role}) if role else frozenset(), None, 'test')
    for action in policy_engine.legal_read_actions | policy_engine.legal_write_actions:
        expected_roles = policy_engine.legal_read_roles if action in policy_engine.legal_read_actions else policy_engine.legal_write_roles
        decision = policy_engine._decide(principal, PolicyContext(action=action))
        assert decision.effect == (PolicyEffect.ALLOW if role in expected_roles else PolicyEffect.DENY), (role, action)


def test_unknown_legal_action_is_denied_even_for_administrator():
    principal = Principal(uuid.uuid4(), uuid.uuid4(), 'a@example.org', 'A', frozenset({'administrator'}), None, 'test')
    assert policy_engine._decide(principal, PolicyContext(action='client.unregistered_operation')).effect == PolicyEffect.DENY
