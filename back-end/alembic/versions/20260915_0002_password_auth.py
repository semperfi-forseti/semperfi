"""Add optional password credentials without changing existing OIDC accounts.

Revision ID: 20260915_0002
Revises: 20260624_0001
"""
from alembic import op
import sqlalchemy as sa

revision = "20260915_0002"
down_revision = "20260624_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The initial revision creates tables from the current metadata, so a fresh
    # installation already has the column when this revision runs.
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("users")}
    if "password_hash" not in columns:
        op.add_column("users", sa.Column("password_hash", sa.String(length=512), nullable=True))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("users")}
    if "password_hash" in columns:
        op.drop_column("users", "password_hash")
