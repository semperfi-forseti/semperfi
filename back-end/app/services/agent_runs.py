from __future__ import annotations

import asyncio
import uuid

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.providers import (
    OUTPUT_LIMITATIONS,
    PROMPT_VERSION,
    InvalidAgentOutput,
    ProviderUnavailable,
    get_agent_provider,
)
from app.agents.service import SAFE_AGENT_TYPES
from app.db import SessionLocal
from app.models import AgentRun, Evidence, Investigation

ACTIVE_INVESTIGATION_STATES = {"em_coleta", "pendente_revisao", "active"}


class AgentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=12000)
    evidence_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)


def normalize_input(payload: dict) -> dict:
    try:
        value = AgentInput.model_validate(payload)
        if not value.text.strip():
            raise ValueError("Empty input")
        return {"text": value.text.strip(), "evidence_ids": list(dict.fromkeys(str(item) for item in value.evidence_ids))}
    except (ValidationError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Informe texto de 1 a 12.000 caracteres e, opcionalmente, até 50 IDs de evidências.") from exc


async def validate_references(
    session: AsyncSession, tenant_id: uuid.UUID, investigation_id: uuid.UUID | None,
    evidence_ids: list[uuid.UUID], *, preserved: bool = False,
) -> list[Evidence]:
    references = set(evidence_ids)
    rows = list((await session.scalars(select(Evidence).where(Evidence.tenant_id == tenant_id, Evidence.id.in_(references)))).all()) if references else []
    if len(rows) != len(references) or any(investigation_id and row.investigation_id != investigation_id for row in rows):
        raise HTTPException(status_code=404, detail="Uma evidência referenciada não está disponível nesta organização e investigação.")
    investigations = {row.investigation_id for row in rows if row.investigation_id}
    if investigation_id:
        investigations.add(investigation_id)
    if investigations:
        cases = list((await session.scalars(select(Investigation).where(Investigation.tenant_id == tenant_id, Investigation.id.in_(investigations)))).all())
        if len(cases) != len(investigations) or any(case.status == "deleted" for case in cases):
            raise HTTPException(status_code=404, detail="Investigação referenciada não encontrada.")
        if any(case.status not in ACTIVE_INVESTIGATION_STATES for case in cases):
            raise HTTPException(status_code=409, detail="A investigação precisa estar em coleta ou pendente de revisão para esta operação.")
    if preserved and any(row.validation_status not in {"preserved", "validated"} or not row.storage_key or not row.storage_version_id for row in rows):
        raise HTTPException(status_code=409, detail="Relatório contém evidência não preservada ou não validada.")
    return rows


async def set_tenant_context(session: AsyncSession, tenant_id: uuid.UUID) -> None:
    if session.bind and session.bind.dialect.name == "postgresql":
        await session.execute(text("SELECT set_config('app.tenant_id', :tenant_id, true)"), {"tenant_id": str(tenant_id)})


async def execute_agent_run(run_id: str, tenant_id: str) -> dict:
    identifier, tenant = uuid.UUID(run_id), uuid.UUID(tenant_id)
    async with SessionLocal() as session:
        await set_tenant_context(session, tenant)
        claimed = await session.execute(update(AgentRun).where(AgentRun.id == identifier, AgentRun.tenant_id == tenant, AgentRun.status == "queued").values(status="running"))
        await session.commit()
        if not claimed.rowcount:
            return {"agent_run_id": run_id, "status": "not_queued"}
        await set_tenant_context(session, tenant)
        run = await session.scalar(select(AgentRun).where(AgentRun.id == identifier, AgentRun.tenant_id == tenant))
        try:
            if run.agent_type not in SAFE_AGENT_TYPES:
                raise InvalidAgentOutput("Tipo de agente inválido.")
            payload = normalize_input(run.input_safe)
            await validate_references(session, tenant, run.investigation_id, [uuid.UUID(item) for item in payload["evidence_ids"]])
            provider = get_agent_provider()
            await session.commit()
            draft = await provider.generate(run.agent_type, payload)
            await set_tenant_context(session, tenant)
            # References may have been archived or moved while the model was running.
            await validate_references(session, tenant, run.investigation_id, [uuid.UUID(item) for item in payload["evidence_ids"]])
            if not set(draft.evidence_ids).issubset(set(payload["evidence_ids"])):
                raise InvalidAgentOutput("Referências não fornecidas.")
            limitations = list(dict.fromkeys([*OUTPUT_LIMITATIONS, *draft.limitations]))
            run.output = {**draft.model_dump(), "classification": "draft_assistance", "limitations": limitations, "prompt_version": PROMPT_VERSION}
            run.status, run.model_name, run.model_version = "pending_human_review", provider.model_name, None
            run.requires_human_review, run.limitations = True, limitations
            await session.commit()
            return {"agent_run_id": run_id, "status": run.status}
        except Exception as exc:  # Persist a bounded failure, never model input or exception internals.
            await session.rollback()
            await set_tenant_context(session, tenant)
            if isinstance(exc, ProviderUnavailable):
                code, message = "PROVIDER_UNAVAILABLE", "O modelo local está indisponível. Confira a configuração e tente uma nova execução."
            elif isinstance(exc, InvalidAgentOutput):
                code, message = "INVALID_MODEL_OUTPUT", "O modelo não produziu uma saída válida. Nenhuma conclusão foi registrada."
            elif isinstance(exc, HTTPException):
                code, message = "INVALID_REFERENCES", "A entrada ou suas referências não estão mais disponíveis para esta execução."
            else:
                code, message = "AGENT_EXECUTION_FAILED", "Não foi possível concluir a execução. Nenhuma conclusão foi registrada."
            await session.execute(update(AgentRun).where(AgentRun.id == identifier, AgentRun.tenant_id == tenant, AgentRun.status == "running").values(status="failed", output={"error_code": code, "message": message}, requires_human_review=True))
            await session.commit()
            return {"agent_run_id": run_id, "status": "failed", "error_code": code}


def execute_agent_run_sync(run_id: str, tenant_id: str) -> dict:
    return asyncio.run(execute_agent_run(run_id, tenant_id))
