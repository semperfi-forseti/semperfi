-- Read-only observability helpers for TACER/SIERA, connectors and audit chain.

CREATE OR REPLACE VIEW v_investigation_connector_runs AS
SELECT
    cr.tenant_id,
    cr.investigation_id,
    cr.id AS connector_run_id,
    cr.connector_id,
    cr.status,
    cr.purpose,
    cr.correlation_id,
    cr.created_at,
    cr.updated_at,
    cr.error_code,
    cr.limitations
FROM connector_runs cr;

CREATE OR REPLACE VIEW v_engine_audit_events AS
SELECT
    ae.tenant_id,
    ae.actor_id,
    ae.action,
    ae.resource_type,
    ae.resource_id,
    ae.result,
    ae.correlation_id,
    ae.occurred_at,
    ae.metadata_safe,
    ae.previous_hash,
    ae.event_hash
FROM audit_events ae
WHERE ae.action IN ('engine.catalog', 'engine.tacer.run', 'engine.siera.run', 'osint.run.queue');

CREATE OR REPLACE VIEW v_investigation_risk_summary AS
SELECT
    i.tenant_id,
    i.id AS investigation_id,
    i.title,
    i.category,
    i.risk_level,
    i.status,
    COUNT(DISTINCT e.id) AS entities_count,
    COUNT(DISTINCT er.id) AS relations_count,
    COUNT(DISTINCT f.id) AS findings_count,
    COUNT(DISTINCT cr.id) AS connector_runs_count
FROM investigations i
LEFT JOIN entities e ON e.investigation_id = i.id
LEFT JOIN entity_relations er ON er.investigation_id = i.id
LEFT JOIN findings f ON f.investigation_id = i.id
LEFT JOIN connector_runs cr ON cr.investigation_id = i.id
GROUP BY i.tenant_id, i.id, i.title, i.category, i.risk_level, i.status;
