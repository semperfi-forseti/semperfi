"""Tenant-scoped links; detaching never deletes the original or its custody events."""
from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.legal import _get, _policy, _record
from app.db import get_db
from app.models import Client, Evidence, LegalProcess
from app.models.legal_document import LegalDocumentLink
from app.security import Principal, get_current_principal

router = APIRouter(tags=["Legal documents"])


class DocumentLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    evidence_id: uuid.UUID
    label: str | None = Field(default=None, max_length=180)


async def _documents(kind, target_id, request, session, principal, body=None, link_id=None):
    model = Client if kind == "client" else LegalProcess
    field = getattr(LegalDocumentLink, f"{kind}_id")
    write = body is not None or link_id is not None
    cid = await _policy(session, principal, request, f"{kind}.{'update' if write else 'read'}")
    # All attach/detach/delete operations lock the same parent first.
    await _get(session, model, principal.tenant_id, target_id, lock=write)
    query = select(LegalDocumentLink).where(
        LegalDocumentLink.tenant_id == principal.tenant_id, field == target_id,
    )
    if body is not None:
        evidence = await session.scalar(select(Evidence).where(
            Evidence.id == body.evidence_id, Evidence.tenant_id == principal.tenant_id,
        ))
        if evidence is None:
            raise HTTPException(404, "Arquivo não encontrado.")
        item = await session.scalar(query.where(LegalDocumentLink.evidence_id == evidence.id))
        if item is None:
            item = LegalDocumentLink(tenant_id=principal.tenant_id, **{f"{kind}_id": target_id},
                                     evidence_id=evidence.id, label=body.label or None, created_by=principal.user_id)
            session.add(item)
            await session.flush()
            await _record(session, principal, request, "document.link", kind, target_id, cid)
        result = {"id": item.id, "evidence_id": item.evidence_id, "label": item.label}
    elif link_id is not None:
        item = await session.scalar(query.where(LegalDocumentLink.id == link_id))
        if item is None:
            raise HTTPException(404, "Vínculo não encontrado.")
        await session.delete(item)
        await _record(session, principal, request, "document.unlink", kind, target_id, cid)
        result = Response(status_code=204)
    else:
        rows = (await session.execute(select(LegalDocumentLink, Evidence).join(
            Evidence, Evidence.id == LegalDocumentLink.evidence_id,
        ).where(LegalDocumentLink.tenant_id == principal.tenant_id,
                Evidence.tenant_id == principal.tenant_id, field == target_id)
          .order_by(LegalDocumentLink.created_at.desc(), LegalDocumentLink.id))).all()
        result = [{"id": link.id, "evidence_id": evidence.id, "label": link.label,
                   "filename": evidence.original_filename, "mime_type": evidence.mime_type,
                   "size_bytes": evidence.size_bytes, "validation_status": evidence.validation_status,
                   "created_at": link.created_at} for link, evidence in rows]
        await _record(session, principal, request, "document.list", kind, target_id, cid)
    await session.commit()
    return result


# Literal path targets exclude arbitrary resource/model access.
@router.get("/{resource}/{target_id}/documents")
async def list_documents(resource: Literal["clients", "processes"], target_id: uuid.UUID, request: Request,
                         session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    return await _documents("client" if resource == "clients" else "process", target_id, request, session, principal)


@router.post("/{resource}/{target_id}/documents")
async def link_document(resource: Literal["clients", "processes"], target_id: uuid.UUID, body: DocumentLinkCreate, request: Request,
                        session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    return await _documents("client" if resource == "clients" else "process", target_id, request, session, principal, body=body)


@router.delete("/{resource}/{target_id}/documents/{link_id}", status_code=204)
async def unlink_document(resource: Literal["clients", "processes"], target_id: uuid.UUID, link_id: uuid.UUID, request: Request,
                          session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    return await _documents("client" if resource == "clients" else "process", target_id, request, session, principal, link_id=link_id)
