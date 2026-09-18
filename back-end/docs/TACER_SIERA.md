# Motores TACER e SIERA

## TACER

TACER organiza o ciclo investigativo:

- `T` Triagem: valida finalidade, base legal, autorizacao e proporcionalidade.
- `A` Aquisicao: planeja conectores server-side, hash e limitacoes.
- `C` Correlacao: organiza entidades, relacoes e lacunas.
- `E` Evidenciacao: prepara cadeia de custodia, metadados e retencao.
- `R` Relatorio: orienta produto tecnico versionado e revisao humana.

Endpoint:

```text
POST /v1/investigation-engines/tacer/run
```

## SIERA

SIERA calcula priorizacao operacional, hipoteses e prontidao de evidencia:

- score de risco;
- classificacao baixo/moderado/alto;
- taxonomia de achados;
- exigencia de revisao humana;
- proximas acoes recomendadas.

Endpoint:

```text
POST /v1/investigation-engines/siera/run
```

## Governanca

Os motores nao fazem coleta externa diretamente. Eles orquestram e priorizam. Coletas externas continuam passando por conectores server-side, PolicyEngine, auditoria e rate limiting.

Campos obrigatorios:

- `purpose`;
- `legal_basis`;
- `authorization_reference`;
- `target`;
- `target_type`.

## Exemplo

```powershell
.\scripts\agent-commands.ps1
```

Use os payloads em `examples/`.
