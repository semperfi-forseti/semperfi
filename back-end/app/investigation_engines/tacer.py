from __future__ import annotations

from dataclasses import dataclass
from typing import Any

TACER_VERSION = "tacer-2026.06"

CONNECTOR_BY_TARGET = {
    "company": ["brasilapi", "transparency", "datajud"],
    "person": ["transparency", "datajud"],
    "domain": ["rdap_dns"],
    "process": ["datajud"],
    "asset": ["rdap_dns", "brasilapi"],
    "other": ["brasilapi", "transparency", "datajud", "rdap_dns"],
}


@dataclass(frozen=True)
class TacerStage:
    code: str
    name: str
    objective: str
    safeguards: list[str]
    outputs: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "name": self.name,
            "objective": self.objective,
            "safeguards": self.safeguards,
            "outputs": self.outputs,
        }


STAGES = [
    TacerStage(
        "T",
        "Triagem",
        "Validar finalidade, base legal, escopo autorizado e proporcionalidade antes da coleta.",
        ["purpose_required", "legal_basis_required", "authorization_reference_required"],
        ["escopo_aprovado", "riscos_iniciais", "fontes_permitidas"],
    ),
    TacerStage(
        "A",
        "Aquisicao",
        "Executar somente conectores autorizados e registrar origem, hash e limitacoes.",
        ["server_side_only", "ssrf_guard", "rate_limit", "no_secret_frontend"],
        ["connector_runs", "raw_snapshot_hash", "normalized_result"],
    ),
    TacerStage(
        "C",
        "Correlacao",
        "Relacionar entidades, identificadores e eventos sem transformar indcio em conclusao.",
        ["confidence_score", "human_review_required"],
        ["entities", "relations", "timeline_candidates"],
    ),
    TacerStage(
        "E",
        "Evidenciacao",
        "Preservar itens relevantes com cadeia de custodia, SHA-256 e metadados tecnicos.",
        ["chain_of_custody", "retention_policy", "legal_hold_ready"],
        ["evidence_candidates", "custody_events"],
    ),
    TacerStage(
        "R",
        "Relatorio",
        "Gerar produto tecnico versionado com limitacoes, fontes e revisao humana.",
        ["human_signoff", "limitations_visible", "versioned_report"],
        ["technical_report", "audit_reference"],
    ),
]


def _risk_weight(risk_level: str) -> int:
    return {"low": 1, "medium": 2, "high": 3}.get(risk_level, 2)


def _recommended_connectors(target_type: str, allowed: list[str]) -> list[dict[str, Any]]:
    candidates = CONNECTOR_BY_TARGET.get(target_type, CONNECTOR_BY_TARGET["other"])
    selected = [connector for connector in candidates if not allowed or connector in allowed]
    return [
        {
            "connector_id": connector,
            "execution_mode": "server_side",
            "requires_credentials": connector in {"transparency", "datajud"},
            "status": "enabled_when_configured",
        }
        for connector in selected
    ]


def run_tacer(payload: dict[str, Any]) -> dict[str, Any]:
    target_type = str(payload.get("target_type", "other"))
    risk_level = str(payload.get("risk_level", "medium"))
    allowed = list(payload.get("connectors_allowed") or [])
    scope = list(payload.get("declared_scope") or [])
    seed_facts = payload.get("seed_facts") or {}
    connector_plan = _recommended_connectors(target_type, allowed)
    risk_weight = _risk_weight(risk_level)
    scope_weight = max(1, len(scope))
    connector_weight = max(1, len(connector_plan))
    estimated_credits = min(40, 3 + risk_weight * scope_weight + connector_weight * 2)
    blocking_gates = []
    if not payload.get("purpose"):
        blocking_gates.append("purpose_required")
    if not payload.get("legal_basis"):
        blocking_gates.append("legal_basis_required")
    if not payload.get("authorization_reference"):
        blocking_gates.append("authorization_reference_required")

    return {
        "engine": "TACER",
        "version": TACER_VERSION,
        "status": "blocked" if blocking_gates else "ready",
        "target": payload.get("target"),
        "target_type": target_type,
        "risk_level": risk_level,
        "declared_scope": scope,
        "stages": [stage.as_dict() for stage in STAGES],
        "connector_plan": connector_plan,
        "collection_tasks": [
            {
                "task": "normalize_target",
                "description": "Normalizar identificadores e separar dado declarado de dado coletado.",
                "input_keys": sorted(seed_facts.keys()),
            },
            {
                "task": "execute_authorized_connectors",
                "description": "Executar conectores permitidos com logs de auditoria e hash da resposta.",
                "connectors": [item["connector_id"] for item in connector_plan],
            },
            {
                "task": "build_relation_graph",
                "description": "Criar mapa inicial de entidades, relacoes e lacunas para revisao humana.",
            },
        ],
        "estimated_credits": estimated_credits,
        "required_confirmations": [
            "Finalidade declarada e compativel com a base legal.",
            "Escopo minimo necessario para o objetivo informado.",
            "Resultados automatizados serao revisados por humano responsavel.",
        ],
        "blocking_gates": blocking_gates,
        "limitations": [
            "Motor local nao realiza coleta externa por si so; ele orquestra conectores server-side.",
            "Ausencia de credenciais reais limita execucoes DataJud e Portal da Transparencia.",
            "Achados sao indicios ate validacao humana e eventual evidenciacao.",
        ],
    }
