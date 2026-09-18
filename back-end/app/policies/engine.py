from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import StrEnum

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import PolicyEvaluation
from app.security import Principal


class PolicyEffect(StrEnum):
    ALLOW = "allow"
    DENY = "deny"
    REQUIRE_APPROVAL = "require_approval"
    REQUIRE_MFA = "require_mfa"
    RATE_LIMITED = "rate_limited"
    RETENTION_BLOCKED = "retention_blocked"


@dataclass(frozen=True)
class PolicyContext:
    action: str
    purpose: str | None = None
    legal_basis: str | None = None
    authorization_reference: str | None = None
    investigation_id: uuid.UUID | None = None
    connector_id: str | None = None
    entity_type: str | None = None
    scope_codes: set[str] = field(default_factory=set)
    risk_level: str = "medium"
    requires_mfa: bool = False
    has_legal_hold: bool = False
    retention_locked: bool = False
    rate_limited: bool = False


@dataclass(frozen=True)
class PolicyDecision:
    effect: PolicyEffect
    code: str
    reason: str


class PolicyEngine:
    critical_actions = {"evidence.download", "evidence.legal_hold", "report.approve", "data.export", "retention.change"}
    investigation_actions = {"osint.run", "engine.run", "evidence.upload", "agent.run", "report.generate"}

    async def evaluate(self, session: AsyncSession, principal: Principal, context: PolicyContext, correlation_id: str) -> PolicyDecision:
        decision = self._decide(principal, context)
        session.add(PolicyEvaluation(
            tenant_id=principal.tenant_id, actor_id=principal.user_id, action=context.action,
            effect=decision.effect.value, policy_code=decision.code, reason=decision.reason,
            context={"connector_id": context.connector_id, "investigation_id": str(context.investigation_id) if context.investigation_id else None,
                     "entity_type": context.entity_type, "risk_level": context.risk_level, "scope_codes": sorted(context.scope_codes)},
            correlation_id=correlation_id,
        ))
        return decision

    def _decide(self, principal: Principal, context: PolicyContext) -> PolicyDecision:
        if context.retention_locked and context.action in {"evidence.delete", "retention.change"}:
            return PolicyDecision(PolicyEffect.RETENTION_BLOCKED, "RETENTION_LOCKED", "Evidência sujeita a retenção ou legal hold.")
        if context.has_legal_hold and context.action == "evidence.delete":
            return PolicyDecision(PolicyEffect.RETENTION_BLOCKED, "LEGAL_HOLD_ACTIVE", "Evidência sob legal hold não pode ser excluída.")
        if context.rate_limited:
            return PolicyDecision(PolicyEffect.RATE_LIMITED, "RATE_LIMIT_EXCEEDED", "Limite operacional atingido.")
        if context.action in self.critical_actions and context.requires_mfa:
            return PolicyDecision(PolicyEffect.REQUIRE_MFA, "MFA_REAUTH_REQUIRED", "Ação crítica exige MFA recente.")
        if context.action in self.investigation_actions:
            if not context.purpose or not context.legal_basis or not context.authorization_reference:
                return PolicyDecision(PolicyEffect.DENY, "LEGAL_BASIS_REQUIRED", "Finalidade, base legal e referência de autorização são obrigatórias.")
            if context.risk_level == "high" and not principal.has_any_role("manager", "administrator"):
                return PolicyDecision(PolicyEffect.REQUIRE_APPROVAL, "HIGH_RISK_REVIEW", "Escopo de risco alto exige aprovação de gestor.")
            if context.connector_id == "rdap_dns" and "digital_defensive" not in context.scope_codes:
                return PolicyDecision(PolicyEffect.DENY, "RDAP_SCOPE_DENIED", "RDAP/DNS exige escopo defensivo e autorização documentada.")
            if not principal.has_any_role("administrator", "manager", "lawyer", "investigator", "analyst"):
                return PolicyDecision(PolicyEffect.DENY, "RBAC_ROLE_DENIED", "Perfil não autorizado para investigação.")
        if context.action == "evidence.legal_hold" and not principal.has_any_role("manager", "administrator", "auditor"):
            return PolicyDecision(PolicyEffect.DENY, "LEGAL_HOLD_ROLE_DENIED", "Apenas gestor, administrador ou auditor pode solicitar legal hold.")
        return PolicyDecision(PolicyEffect.ALLOW, "POLICY_ALLOWED", "Ação autorizada pelas regras vigentes.")


policy_engine = PolicyEngine()
