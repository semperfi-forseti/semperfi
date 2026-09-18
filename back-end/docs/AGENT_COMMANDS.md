# Comandos de Agentes

Use estes comandos em ambiente local com `AUTH_MODE=development`.

## Headers de identidade

```text
X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001
X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010
X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor
```

## TACER

```powershell
curl -X POST http://127.0.0.1:8000/v1/investigation-engines/tacer/run `
  -H "Content-Type: application/json" `
  -H "X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001" `
  -H "X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010" `
  -H "X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor" `
  --data @examples/tacer-request.json
```

## SIERA

```powershell
curl -X POST http://127.0.0.1:8000/v1/investigation-engines/siera/run `
  -H "Content-Type: application/json" `
  -H "X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001" `
  -H "X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010" `
  -H "X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor" `
  --data @examples/siera-request.json
```

## BrasilAPI via OSINT connector

```powershell
curl -X POST "http://127.0.0.1:8000/v1/osint/runs?wait=true" `
  -H "Content-Type: application/json" `
  -H "X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001" `
  -H "X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010" `
  -H "X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor" `
  --data @examples/connector-brasilapi-cnpj.json
```

## Script auxiliar

```powershell
.\scripts\agent-commands.ps1
```
