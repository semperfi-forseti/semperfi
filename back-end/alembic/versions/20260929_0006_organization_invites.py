"""Organization invitations and revocation of sessions by membership.

Revision ID: 20260929_0006
Revises: 20260929_0005
"""
from alembic import op

from app.models.organization import OrganizationInvitation, OrganizationSessionVersion

revision = "20260929_0006"
down_revision = "20260929_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    OrganizationInvitation.__table__.create(bind, checkfirst=True)
    # Like memberships/users, this lookup is shared by the session verifier
    # before a tenant is established. It contains no invitation or user data.
    OrganizationSessionVersion.__table__.create(bind, checkfirst=True)
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY")
        condition = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR token_hash = current_setting('app.organization_invite_hash', true))"
        op.execute(f"CREATE POLICY organization_invitation_access ON organization_invitations USING {condition} WITH CHECK {condition}")


def downgrade() -> None:
    bind = op.get_bind()
    OrganizationSessionVersion.__table__.drop(bind, checkfirst=True)
    OrganizationInvitation.__table__.drop(bind, checkfirst=True)
