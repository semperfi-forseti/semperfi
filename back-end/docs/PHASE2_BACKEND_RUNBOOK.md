# Operação local

O [README do backend](../README.md) contém os pré-requisitos e a configuração atual. Use `uv` com Python 3.12/3.13; não instale dependências no Python global.

## Comandos, na pasta back-end

```powershell
uv sync --all-groups --python 3.12
.\scripts\run-backend.ps1
```

O `.env.example` usa endereços da rede Docker. Para execução no host, configure banco e Redis como descrito no README. O script de execução preserva as variáveis do ambiente.

Em outro terminal:

```powershell
.\scripts\run-frontend.ps1
```

O script encontra `../front-end` e inicia a porta 4173; `-Port` permite alterá-la. Para usar somente a API como servidor da interface, execute `npm run sync:backend` em `front-end` e abra a porta 8000.

## Diagnóstico

```powershell
.\scripts\debug-health.ps1
.\scripts\debug-openapi.ps1
.\scripts\test-backend.ps1
node .\scripts\smoke-http.mjs
```

O smoke usa um banco temporário próprio e não cadastra clientes/processos. Health/readiness verificam processo/banco, não todos os serviços externos.

## Encerramento

Encerre os processos locais com Ctrl+C. No Compose, use `docker compose down`; os volumes devem ser preservados. A base não é restaurada nem preenchida com dados fictícios no reinício.
