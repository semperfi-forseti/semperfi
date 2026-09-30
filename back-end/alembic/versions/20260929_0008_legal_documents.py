"""Associate stored files with active clients or processes."""
from alembic import op

from app.models.legal_document import LegalDocumentLink

revision = "20260929_0008"
down_revision = "20260929_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    LegalDocumentLink.__table__.create(bind, checkfirst=True)
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE legal_document_links ENABLE ROW LEVEL SECURITY")
        condition = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)"
        op.execute(f"CREATE POLICY legal_document_links_tenant_isolation ON legal_document_links USING {condition} WITH CHECK {condition}")


def downgrade() -> None:
    LegalDocumentLink.__table__.drop(op.get_bind(), checkfirst=True)
