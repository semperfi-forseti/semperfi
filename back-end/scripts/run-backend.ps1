param(
    [int]$Port = 8000,
    [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force -Path "$root\var\semperfi-evidence" | Out-Null

# Some Windows installations restrict the shared uv cache under AppData.
# Keep this development-only cache inside the project instead.
if (-not $env:UV_CACHE_DIR) {
    $env:UV_CACHE_DIR = "$root\var\uv-cache"
}

if (-not $env:EVIDENCE_STAGING_DIR) {
    $env:EVIDENCE_STAGING_DIR = "var/semperfi-evidence"
}

Write-Host "Starting SEMPER-FI API on http://$HostName`:$Port"
Write-Host "Docs: http://$HostName`:$Port/v1/docs"
uv run uvicorn app.main:app --host $HostName --port $Port --reload
