from app.investigation_engines import run_siera, run_tacer


def _payload():
    return {
        "target": "Empresa Aurora",
        "target_type": "company",
        "purpose": "Investigacao autorizada para due diligence juridica",
        "legal_basis": "contrato",
        "authorization_reference": "AUTH-001",
        "declared_scope": ["corporate", "public_records"],
        "connectors_allowed": ["brasilapi", "datajud"],
        "risk_level": "medium",
        "seed_facts": {"cnpj": "00000000000100"},
    }


def test_tacer_builds_authorized_collection_plan():
    result = run_tacer(_payload())

    assert result["engine"] == "TACER"
    assert result["status"] == "ready"
    assert result["estimated_credits"] > 0
    assert [item["connector_id"] for item in result["connector_plan"]] == ["brasilapi", "datajud"]


def test_siera_requires_human_review_for_moderate_risk():
    result = run_siera(_payload())

    assert result["engine"] == "SIERA"
    assert result["risk_classification"] in {"moderado", "alto"}
    assert result["human_review_required"] is True
    assert "conclusao_humana" in result["finding_taxonomy"]
