"""Persist Sandbox checkout intents and idempotent webhook receipts.

Revision ID: 20260923_0004
Revises: 20260916_0003
"""
from alembic import op
from app.models.billing import BillingCheckout, BillingWebhookReceipt

revision = "20260923_0004"
down_revision = "20260916_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    for model in (BillingCheckout, BillingWebhookReceipt):
        model.__table__.create(bind, checkfirst=True)
        if bind.dialect.name == "postgresql":
            name = model.__tablename__
            op.execute(f"ALTER TABLE {name} ENABLE ROW LEVEL SECURITY")
            condition = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.billing_webhook_verified', true) = 'true')"
            op.execute(f"CREATE POLICY {name}_tenant_isolation ON {name} USING {condition} WITH CHECK {condition}")


def downgrade() -> None:
    bind = op.get_bind()
    for model in (BillingWebhookReceipt, BillingCheckout):
        model.__table__.drop(bind, checkfirst=True)
