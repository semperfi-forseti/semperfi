from app.connectors.brasilapi import BrasilApiConnector
from app.connectors.datajud import DataJudConnector
from app.connectors.rdap import RdapConnector
from app.connectors.transparency import TransparencyConnector

CONNECTORS = {c.connector_id: c for c in [BrasilApiConnector(), TransparencyConnector(), DataJudConnector(), RdapConnector()]}


def get_connector(connector_id: str):
    if connector_id not in CONNECTORS:
        raise ValueError("Conector não habilitado ou desconhecido.")
    return CONNECTORS[connector_id]
