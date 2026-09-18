"""Add PF/PJ classification and temporary verification challenges.

Revision ID: 20260916_0003
Revises: 20260915_0002
"""
import sqlalchemy as sa
from alembic import op

from app.models.platform import AuthenticationChallenge

revision = "20260916_0003"
down_revision = "20260915_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("tenants")}
    if "account_type" not in columns:
        op.add_column("tenants", sa.Column("account_type", sa.String(length=2), nullable=True))
    # Fresh installations already create the current tables in revision 0001.
    AuthenticationChallenge.__table__.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    AuthenticationChallenge.__table__.drop(bind, checkfirst=True)
    columns = {column["name"] for column in sa.inspect(bind).get_columns("tenants")}
    if "account_type" in columns:
        op.drop_column("tenants", "account_type")
