"""Persist investigation planning runs and human review.

Revision ID: 20260929_0007
Revises: 20260929_0006
"""

from alembic import op

from app.models.investigation_engine_run import InvestigationEngineRun

revision = "20260929_0007"
down_revision = "20260929_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    InvestigationEngineRun.__table__.create(bind, checkfirst=True)
    if bind.dialect.name == "postgresql":
        name = InvestigationEngineRun.__tablename__
        op.execute(f"ALTER TABLE {name} ENABLE ROW LEVEL SECURITY")
        condition = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)"
        op.execute(f"CREATE POLICY {name}_tenant_isolation ON {name} USING {condition} WITH CHECK {condition}")


def downgrade() -> None:
    InvestigationEngineRun.__table__.drop(op.get_bind(), checkfirst=True)
