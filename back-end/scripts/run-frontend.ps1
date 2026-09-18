param(
    [int]$Port = 4173
)

$ErrorActionPreference = "Stop"
$frontend = Join-Path (Split-Path -Parent $PSScriptRoot) "..\front-end"
$frontend = Resolve-Path $frontend
Set-Location $frontend

Write-Host "Starting SEMPER-FI frontend on http://127.0.0.1:$Port"
$env:PORT = "$Port"
node server.mjs
