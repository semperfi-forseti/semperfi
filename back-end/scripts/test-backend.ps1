param(
    [switch]$SkipLint
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

New-Item -ItemType Directory -Force -Path "$root\var\test", "$root\var\semperfi-evidence" | Out-Null
$env:ENVIRONMENT = "test"
$env:DATABASE_URL = "sqlite+aiosqlite:///./var/test/semperfi-script-test.db"
$env:EVIDENCE_STAGING_DIR = "var/semperfi-evidence"
$env:PYTEST_ADDOPTS = "-p no:cacheprovider"

Write-Host "Compiling Python sources..."
uv run python -m compileall -q app tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipLint) {
    Write-Host "Running Ruff..."
    uv run ruff check app tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Running Pytest..."
uv run pytest -q
exit $LASTEXITCODE
