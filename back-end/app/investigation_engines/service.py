from __future__ import annotations

from typing import Any

from app.investigation_engines.siera import run_siera as _run_siera
from app.investigation_engines.tacer import run_tacer as _run_tacer


def run_tacer(payload: dict[str, Any]) -> dict[str, Any]:
    return _run_tacer(payload)


def run_siera(payload: dict[str, Any]) -> dict[str, Any]:
    return _run_siera(payload)


def engine_catalog() -> dict[str, Any]:
    return {
        "engines": [
            {
                "id": "tacer",
                "name": "TACER",
                "description": "Triagem, Aquisicao, Correlacao, Evidenciacao e Relatorio.",
                "mode": "orchestration",
                "external_collection": "via_authorized_connectors_only",
            },
            {
                "id": "siera",
                "name": "SIERA",
                "description": "Sistema Inteligente de Evidencias, Risco e Analise.",
                "mode": "risk_and_hypothesis_analysis",
                "external_collection": "none",
            },
        ],
        "connector_policy": {
            "server_side_only": True,
            "frontend_secrets_allowed": False,
            "requires_purpose_and_authorization": True,
            "requires_human_review_for_conclusions": True,
        },
    }
