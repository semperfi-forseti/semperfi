"""Initial multi-tenant SEMPER-FI schema.

Revision ID: 20260624_0001
Revises:
Create Date: 2026-06-24
"""
from alembic import op
import sqlalchemy as sa

import app.models  # noqa: F401
from app.models.base import Base

revision = "20260624_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)
    if bind.dialect.name == "postgresql":
        for table in ["clients", "processes", "process_movements", "deadlines", "appointments", "intimations", "financial_entries", "investigations", "entities", "entity_relations", "connector_runs", "findings", "timeline_events", "evidences", "reports", "agent_runs", "audit_events", "policy_evaluations"]:
            op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
            op.execute(f"CREATE POLICY {table}_tenant_isolation ON {table} USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        for table in ["policy_evaluations", "audit_events", "agent_runs", "reports", "evidences", "timeline_events", "findings", "connector_runs", "entity_relations", "entities", "investigations", "financial_entries", "intimations", "appointments", "deadlines", "process_movements", "processes", "clients"]:
            op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
    Base.metadata.drop_all(bind=bind)
