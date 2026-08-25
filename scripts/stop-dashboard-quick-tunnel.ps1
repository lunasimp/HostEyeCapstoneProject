[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "deploy\cloudflare-tunnel\docker-compose.quick-tunnel.yml"

docker compose --project-name hosteye-dashboard-quick-tunnel -f $composeFile down
if ($LASTEXITCODE -ne 0) { throw "Cloudflare Quick Tunnel failed to stop cleanly." }
Write-Host "Quick Tunnel stopped. The local HostEye stack remains running."

