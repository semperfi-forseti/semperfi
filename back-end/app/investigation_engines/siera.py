from __future__ import annotations

from typing import Any

SIERA_VERSION = "siera-2026.06"

RISK_FACTORS = {
    "high": 30,
    "medium": 18,
    "low": 8,
}

TARGET_FACTORS = {
    "company": 12,
    "person": 10,
    "domain": 14,
    "process": 9,
    "asset": 11,
    "other": 7,
}


def _bounded_score(value: int) -> int:
    return max(0, min(100, value))


def _classify(score: int) -> str:
    if score >= 75:
        return "alto"
    if score >= 45:
        return "moderado"
    return "baixo"


def _hypotheses(target: str, target_type: str, seed_facts: dict[str, Any]) -> list[dict[str, Any]]:
    hypotheses = [
        {
            "code": "identity_consistency",
            "statement": f"Verificar consistencia dos identificadores declarados para {target}.",
            "status": "needs_collection",
            "confidence": 0.35,
        },
        {
            "code": "public_record_alignment",
            "statement": "Comparar registros publicos autorizados com os fatos-semente fornecidos.",
            "status": "needs_collection",
            "confidence": 0.30,
        },
    ]
    if target_type == "company":
        hypotheses.append(
            {
                "code": "corporate_linkage",
                "statement": "Avaliar vinculos societarios, socios, enderecos e participacoes recorrentes.",
                "status": "needs_collection",
                "confidence": 0.32,
            }
        )
    if target_type == "domain":
        hypotheses.append(
            {
                "code": "digital_footprint",
                "statement": "Verificar propriedade, historico RDAP/DNS e possiveis relacoes com entidades conhecidas.",
                "status": "needs_collection",
                "confidence": 0.34,
            }
        )
    if seed_facts:
        hypotheses.append(
            {
                "code": "seed_fact_corroboration",
                "statement": "Corroborar fatos-semente antes de qualquer conclusao operacional.",
                "status": "needs_human_review",
                "confidence": 0.40,
            }
        )
    return hypotheses


def run_siera(payload: dict[str, Any]) -> dict[str, Any]:
    target = str(payload.get("target", "alvo nao informado"))
    target_type = str(payload.get("target_type", "other"))
    risk_level = str(payload.get("risk_level", "medium"))
    seed_facts = payload.get("seed_facts") or {}
    scope = list(payload.get("declared_scope") or [])
    connectors = list(payload.get("connectors_allowed") or [])
    score = _bounded_score(
        20
        + RISK_FACTORS.get(risk_level, RISK_FACTORS["medium"])
        + TARGET_FACTORS.get(target_type, TARGET_FACTORS["other"])
        + len(scope) * 3
        + len(connectors) * 2
        + min(len(seed_facts) * 2, 12)
    )
    classification = _classify(score)
    review_required = score >= 45 or risk_level == "high"

    return {
        "engine": "SIERA",
        "version": SIERA_VERSION,
        "target": target,
        "target_type": target_type,
        "risk_score": score,
        "risk_classification": classification,
        "human_review_required": review_required,
        "evidence_readiness": {
            "chain_of_custody_required": True,
            "hash_required": True,
            "metadata_required": True,
            "legal_hold_recommended": classification == "alto",
        },
        "finding_taxonomy": [
            "dado_bruto",
            "indicio",
            "achado_preliminar",
            "evidencia_corroborada",
            "conclusao_humana",
        ],
        "hypotheses": _hypotheses(target, target_type, seed_facts),
        "recommended_next_actions": [
            "Executar TACER antes de qualquer coleta externa.",
            "Registrar finalidade e autorizacao no dossie.",
            "Separar sugestao automatizada de conclusao humana.",
            "Preservar apenas evidencias relevantes e proporcionais.",
        ],
        "limitations": [
            "SIERA nao substitui avaliacao juridica ou investigativa humana.",
            "Score representa priorizacao operacional, nao juizo de culpa ou responsabilidade.",
            "Dados externos exigem conectores autorizados e credenciais configuradas no servidor.",
        ],
    }
