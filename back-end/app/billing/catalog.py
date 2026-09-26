"""Authoritative prices in cents; request payloads cannot supply or override them.

A contract test checks parity with the displayed frontend catalog.
"""

PLANS = {
    "lite": {"key": "lite", "name": "Lite", "amount_cents": 8990},
    "profissional": {"key": "profissional", "name": "Profissional", "amount_cents": 15990},
    "escritorio": {"key": "escritorio", "name": "Escritório", "amount_cents": 32990},
    "equipe": {"key": "equipe", "name": "Equipe", "amount_cents": 69990},
}
