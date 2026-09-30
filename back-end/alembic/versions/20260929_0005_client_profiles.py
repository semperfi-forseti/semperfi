"""Persist encrypted operator-supplied client profiles.

Revision ID: 20260929_0005
Revises: 20260923_0004
"""
from alembic import op
from app.models.client_profile import ClientProfile

revision = "20260929_0005"
down_revision = "20260923_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    ClientProfile.__table__.create(bind, checkfirst=True)
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE client_profiles ENABLE ROW LEVEL SECURITY")
        condition = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)"
        op.execute(f"CREATE POLICY client_profiles_tenant_isolation ON client_profiles USING {condition} WITH CHECK {condition}")


def downgrade() -> None:
    ClientProfile.__table__.drop(op.get_bind(), checkfirst=True)
