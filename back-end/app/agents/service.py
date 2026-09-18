from __future__ import annotations

SAFE_AGENT_TYPES = {"collection", "metadata", "timeline", "correlation", "inconsistency", "report", "legal_review"}


def safe_agent_output(agent_type: str) -> dict:
    if agent_type not in SAFE_AGENT_TYPES:
        raise ValueError("Tipo de agente não permitido.")
    return {
        "status": "pending_human_review",
        "classification": "draft_assistance",
        "facts": [],
        "inferences": [],
        "recommendations": [],
        "evidence_ids": [],
        "limitations": ["Saída automatizada sem conclusão jurídica autônoma.", "Revisão humana obrigatória antes de uso externo."],
        "confidence": 0.0,
        "model_version": "not-configured",
        "prompt_version": "v1",
    }
