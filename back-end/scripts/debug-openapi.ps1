param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [string]$Output = "openapi.local.json"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$openapi = Invoke-WebRequest "$BaseUrl/v1/openapi.json" -UseBasicParsing
$openapi.Content | Set-Content -Path $Output -Encoding UTF8
Write-Host "OpenAPI exported to $Output"
