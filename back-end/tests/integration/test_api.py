from fastapi.testclient import TestClient

from app.main import app

HEADERS_A = {
    'X-Semperfi-User-Id': '00000000-0000-0000-0000-000000000001',
    'X-Semperfi-Tenant-Id': '00000000-0000-0000-0000-000000000010',
    'X-Semperfi-Roles': 'administrator,manager,lawyer,investigator,auditor',
}
HEADERS_B = {**HEADERS_A, 'X-Semperfi-Tenant-Id': '00000000-0000-0000-0000-000000000020'}


def test_health_and_tenant_isolation():
    with TestClient(app) as client:
        assert client.get('/health/live').status_code == 200
        created = client.post('/v1/clients', headers=HEADERS_A, json={'kind': 'PJ', 'name': 'Empresa Isolada', 'document': '12.345.678/0001-90'})
        assert created.status_code == 201
        assert len(client.get('/v1/clients', headers=HEADERS_A).json()) >= 1
        assert client.get('/v1/clients', headers=HEADERS_B).json() == []


def test_audit_ledger_verification():
    with TestClient(app) as client:
        client.post('/v1/clients', headers=HEADERS_A, json={'kind': 'PF', 'name': 'Pessoa de Teste', 'document': '123.456.789-00'})
        response = client.post('/v1/audit-events/verify-chain', headers=HEADERS_A)
        assert response.status_code == 200
        assert response.json()['valid'] is True
