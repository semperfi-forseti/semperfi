"""Persist investigation details and finding provenance without discarding records."""
import sqlalchemy as sa

from alembic import op

revision = "20261003_0009"
down_revision = "20260929_0008"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    additions = {
        "investigations": [sa.Column("operational_owner", sa.String(160)),
            sa.Column("priority", sa.String(16), nullable=False, server_default="medium"),
            sa.Column("deadline", sa.Date()), sa.Column("questions", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("expected_result", sa.Text())],
        "entities": [sa.Column("aliases", sa.JSON(), nullable=False, server_default=sa.text("'[]'"))],
    }
    for table, columns in additions.items():
        existing = {column["name"] for column in sa.inspect(bind).get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
    existing = {column["name"] for column in sa.inspect(bind).get_columns("findings")}
    if "connector_run_id" not in existing:
        with op.batch_alter_table("findings") as batch:
            batch.add_column(sa.Column("connector_run_id", sa.Uuid(), nullable=True))
            batch.create_foreign_key("fk_findings_connector_run_id", "connector_runs", ["connector_run_id"], ["id"])
            batch.create_index("ix_findings_connector_run_id", ["connector_run_id"])


def downgrade():
    with op.batch_alter_table("findings") as batch:
        batch.drop_index("ix_findings_connector_run_id")
        batch.drop_constraint("fk_findings_connector_run_id", type_="foreignkey")
        batch.drop_column("connector_run_id")
    op.drop_column("entities", "aliases")
    for column in ("expected_result", "questions", "deadline", "priority", "operational_owner"):
        op.drop_column("investigations", column)
