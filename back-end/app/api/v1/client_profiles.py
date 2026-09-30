from __future__ import annotations

import json
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
)
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.legal import _get, _policy
from app.audit import append_audit
from app.db import get_db
from app.models import Client
from app.models.client_profile import ClientProfile
from app.security import Principal, cipher, get_current_principal

router = APIRouter(tags=["Client profiles"])
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)]
RequiredText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)]


def safe_source_url(value: str) -> str:
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme.lower() in {"http", "https"} and parsed.hostname
                 and not parsed.username and not parsed.password and "\\" not in value
                 and not any(char.isspace() or ord(char) < 32 for char in value))
        # Accessing port also validates malformed/out-of-range ports.
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("Informe uma URL HTTP ou HTTPS válida, sem credenciais.") from exc
    if not valid:
        raise ValueError("Informe uma URL HTTP ou HTTPS válida, sem credenciais.")
    return value


SourceURL = Annotated[str, StringConstraints(strip_whitespace=True, max_length=2048), AfterValidator(safe_source_url)]


class ProfileModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProfessionalHistory(ProfileModel):
    cargo: RequiredText
    organizacao: ShortText = ""
    periodo: ShortText = ""
    descricao: LongText = ""
    fonte: ShortText = ""
    url: SourceURL = ""


class PoliticalHistory(ProfileModel):
    ano: int = Field(ge=1900, le=2100, strict=True)
    cargo: RequiredText
    partido: ShortText = ""
    situacao: ShortText = ""
    fonte: ShortText = ""
    url: SourceURL = ""


class PublicOffice(ProfileModel):
    cargo: RequiredText
    orgao: ShortText = ""
    periodo: ShortText = ""
    fonte: ShortText = ""
    url: SourceURL = ""


class DeclaredAsset(ProfileModel):
    tipo: RequiredText
    descricao: LongText = ""
    valor: Decimal | None = Field(default=None, ge=0, lt=10**14, max_digits=16, decimal_places=2, allow_inf_nan=False)
    ano: int | None = Field(default=None, ge=1900, le=2100, strict=True)
    fonte: ShortText = ""
    url: SourceURL = ""


class CompanyLink(ProfileModel):
    nome: RequiredText
    cnpj: Annotated[str, StringConstraints(max_length=18)] = ""
    qualificacao: ShortText = ""
    status: ShortText = ""
    fonte: ShortText = ""
    url: SourceURL = ""

    @field_validator("cnpj")
    @classmethod
    def document_format(cls, value: str) -> str:
        if not value:
            return value
        if any(char not in "0123456789./- " for char in value):
            raise ValueError("Informe o CNPJ com 14 dígitos.")
        digits = "".join(char for char in value if char in "0123456789")
        if len(digits) != 14:
            raise ValueError("Informe o CNPJ com 14 dígitos.")
        return digits


class NewsMention(ProfileModel):
    titulo: RequiredText
    fonte: ShortText = ""
    data: date | None = None
    snippet: LongText = ""
    url: SourceURL = ""


class ProfileSource(ProfileModel):
    titulo: RequiredText
    url: SourceURL = ""
    observacoes: LongText = ""


class ProfileData(ProfileModel):
    biography: Annotated[str, StringConstraints(max_length=20000)] = ""
    profession: ShortText = ""
    nationality: ShortText = ""
    maritalStatus: ShortText = ""
    birthDate: date | None = None
    professionalHistory: list[ProfessionalHistory] = Field(default_factory=list, max_length=100)
    politicalHistory: list[PoliticalHistory] = Field(default_factory=list, max_length=100)
    publicOffices: list[PublicOffice] = Field(default_factory=list, max_length=100)
    assets: list[DeclaredAsset] = Field(default_factory=list, max_length=100)
    companies: list[CompanyLink] = Field(default_factory=list, max_length=100)
    newsMentions: list[NewsMention] = Field(default_factory=list, max_length=100)
    notes: LongText = ""
    sources: list[ProfileSource] = Field(default_factory=list, max_length=100)

    @field_validator("birthDate")
    @classmethod
    def plausible_birth_date(cls, value: date | None) -> date | None:
        if value and (value.year < 1800 or value > datetime.now(UTC).date()):
            raise ValueError("Informe uma data de nascimento válida, sem data futura.")
        return value


class ProfileWrite(ProfileModel):
    version: int = Field(ge=0, strict=True)
    profile: ProfileData


class ProfileRead(ProfileModel):
    client_id: uuid.UUID
    version: int
    profile: ProfileData
    updated_at: datetime | None


def conflict() -> HTTPException:
    return HTTPException(status_code=409, detail="O perfil foi atualizado por outra pessoa. Recarregue os dados antes de salvar novamente.")


async def record(session, principal, request, action, client_id, version, cid):
    await append_audit(session, principal, request, action=action, resource_type="client_profile",
                       resource_id=client_id, correlation_id=cid, metadata_safe={"version": version})


@router.get("/clients/{client_id}/profile", response_model=ProfileRead)
async def get_profile(client_id: uuid.UUID, request: Request, response: Response,
                      session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "client.read")
    await _get(session, Client, principal.tenant_id, client_id)
    item = await session.scalar(select(ClientProfile).where(ClientProfile.tenant_id == principal.tenant_id, ClientProfile.client_id == client_id))
    result = ProfileRead(client_id=client_id, version=item.version if item else 0,
                         profile=ProfileData.model_validate_json(cipher.decrypt(item.profile_ciphertext)) if item else ProfileData(),
                         updated_at=(item.updated_at.replace(tzinfo=UTC) if item.updated_at.tzinfo is None else item.updated_at) if item else None)
    await record(session, principal, request, "client.profile.read", client_id, result.version, cid)
    await session.commit()
    response.headers["Cache-Control"] = "no-store"
    return result


@router.put("/clients/{client_id}/profile", response_model=ProfileRead)
async def put_profile(client_id: uuid.UUID, body: ProfileWrite, request: Request, response: Response,
                      session: AsyncSession = Depends(get_db), principal: Principal = Depends(get_current_principal)):
    cid = await _policy(session, principal, request, "client.update")
    # Serialize writers with client deletion in PostgreSQL. CAS also protects
    # existing rows in SQLite, where SELECT FOR UPDATE does not acquire a lock.
    await _get(session, Client, principal.tenant_id, client_id, lock=True)
    encoded = json.dumps(body.profile.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 250000:
        raise HTTPException(status_code=422, detail="O perfil excede o limite de tamanho. Reduza os textos ou a quantidade de registros.")
    encrypted = cipher.encrypt(encoded)
    now = datetime.now(UTC)
    version = body.version + 1
    if body.version == 0:
        session.add(ClientProfile(tenant_id=principal.tenant_id, client_id=client_id,
                                  profile_ciphertext=encrypted, version=version, created_by=principal.user_id,
                                  updated_by=principal.user_id, updated_at=now))
        try:
            await session.flush()
        except IntegrityError as exc:
            await session.rollback()
            raise conflict() from exc
    else:
        saved = await session.execute(update(ClientProfile).where(
            ClientProfile.tenant_id == principal.tenant_id, ClientProfile.client_id == client_id,
            ClientProfile.version == body.version,
        ).values(profile_ciphertext=encrypted, version=version, updated_by=principal.user_id, updated_at=now))
        if saved.rowcount != 1:
            raise conflict()
    await record(session, principal, request, "client.profile.update", client_id, version, cid)
    await session.commit()
    response.headers["Cache-Control"] = "no-store"
    return ProfileRead(client_id=client_id, version=version, profile=body.profile, updated_at=now)
