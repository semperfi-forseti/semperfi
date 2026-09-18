"""Explicit administrator provisioning. Does not create clients or sample cases."""
from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select  # noqa: E402

from app.db import SessionLocal  # noqa: E402
from app.models import Membership, Tenant, User  # noqa: E402


async def provision(args):
    async with SessionLocal() as session:
        tenant = await session.scalar(select(Tenant).where(Tenant.slug == args.tenant_slug))
        if not tenant:
            tenant = Tenant(id=uuid.uuid4(), name=args.tenant_name, slug=args.tenant_slug)
            session.add(tenant)
            await session.flush()
        user = await session.scalar(select(User).where(User.email == args.email))
        if user:
            raise ValueError("E-mail já cadastrado. Revise a conta existente antes de alterar vínculos.")
        user = User(id=uuid.uuid4(), email=args.email, display_name=args.name, oidc_subject=args.subject)
        session.add(user)
        await session.flush()
        session.add(Membership(tenant_id=tenant.id, user_id=user.id, role=args.role, permissions=[]))
        await session.commit()
        print(f"Conta provisionada. tenant_id={tenant.id} user_id={user.id}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-name", required=True)
    parser.add_argument("--tenant-slug", required=True)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--subject", required=True, help="Claim sub do usuário no provedor OIDC")
    parser.add_argument("--role", choices=["administrator", "manager", "lawyer", "investigator", "auditor"], default="lawyer")
    asyncio.run(provision(parser.parse_args()))
