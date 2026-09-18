-- SEMPER-FI backend support SQL
-- Use Alembic for canonical migrations. This file documents deploy-time database hardening.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Tenant context expected by the API before querying tenant-scoped tables:
-- SELECT set_config('app.tenant_id', '<tenant-uuid>', true);

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'clients',
        'processes',
        'process_movements',
        'deadlines',
        'appointments',
        'intimations',
        'financial_entries',
        'investigations',
        'entities',
        'entity_relations',
        'connector_runs',
        'findings',
        'timeline_events',
        'evidences',
        'reports',
        'agent_runs',
        'audit_events',
        'policy_evaluations'
    ]
    LOOP
        EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', table_name);
    END LOOP;
END $$;
