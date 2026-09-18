$ErrorActionPreference = "Stop"

$headers = @"
X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001
X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010
X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor
"@

Write-Host "SEMPER-FI agent command templates"
Write-Host ""
Write-Host "Identity headers for development:"
Write-Host $headers
Write-Host ""
Write-Host "TACER:"
Write-Host "curl -X POST http://127.0.0.1:8000/v1/investigation-engines/tacer/run -H `"Content-Type: application/json`" -H `"X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001`" -H `"X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010`" -H `"X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor`" --data @examples/tacer-request.json"
Write-Host ""
Write-Host "SIERA:"
Write-Host "curl -X POST http://127.0.0.1:8000/v1/investigation-engines/siera/run -H `"Content-Type: application/json`" -H `"X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001`" -H `"X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010`" -H `"X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor`" --data @examples/siera-request.json"
Write-Host ""
Write-Host "Connector run with synchronous local wait:"
Write-Host "curl -X POST `"http://127.0.0.1:8000/v1/osint/runs?wait=true`" -H `"Content-Type: application/json`" -H `"X-Semperfi-User-Id: 00000000-0000-0000-0000-000000000001`" -H `"X-Semperfi-Tenant-Id: 00000000-0000-0000-0000-000000000010`" -H `"X-Semperfi-Roles: administrator,manager,lawyer,investigator,auditor`" --data @examples/connector-brasilapi-cnpj.json"
