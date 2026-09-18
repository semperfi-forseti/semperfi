# SEMPER-FI SQL Scripts

Alembic continua sendo a fonte oficial de migrations. Estes scripts sao auxiliares para hardening, deploy manual e observabilidade.

## Ordem sugerida

1. Rode `alembic upgrade head`.
2. Execute `001_extensions_and_rls.sql` no banco PostgreSQL alvo.
3. Execute `002_investigation_observability.sql` para criar views de auditoria e investigacao.

## Observacao

As views nao expoem segredos nem payloads sensiveis completos. Para ambientes reais, aplique permissoes por papel antes de liberar acesso a BI ou operadores.
