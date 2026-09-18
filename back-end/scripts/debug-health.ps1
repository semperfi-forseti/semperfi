param(
    [string]$BaseUrl = "http://127.0.0.1:8000"
)

$ErrorActionPreference = "Stop"

Write-Host "Checking liveness..."
Invoke-RestMethod "$BaseUrl/health/live"

Write-Host "Checking readiness..."
Invoke-RestMethod "$BaseUrl/health/ready"

Write-Host "Checking OpenAPI..."
$openapi = Invoke-RestMethod "$BaseUrl/v1/openapi.json"
$openapi.info

Write-Host "Checking frontend root..."
$response = Invoke-WebRequest "$BaseUrl/" -UseBasicParsing
[pscustomobject]@{
    StatusCode = $response.StatusCode
    ContentLength = $response.Content.Length
}
