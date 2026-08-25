[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$deployDir = Join-Path $repoRoot "deploy\cloudflare-tunnel"
$composeFile = Join-Path $deployDir "docker-compose.dashboard-tunnel.yml"
$envFile = Join-Path $deployDir ".env"

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Create $envFile from .env.example and set the Cloudflare tunnel token first."
}

$tokenLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^HOSTEYE_CLOUDFLARE_TUNNEL_TOKEN=' } | Select-Object -First 1
if (-not $tokenLine -or $tokenLine -match 'replace-with') {
    throw "HOSTEYE_CLOUDFLARE_TUNNEL_TOKEN is missing or still uses the placeholder value."
}

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:5174/api/health" -TimeoutSec 10
    if ($health.StatusCode -ne 200) { throw "Unexpected Dashboard health status $($health.StatusCode)." }
} catch {
    throw "The local Dashboard is not healthy at http://127.0.0.1:5174/api/health. The tunnel was not started. $($_.Exception.Message)"
}

docker compose --project-name hosteye-dashboard-tunnel --env-file $envFile -f $composeFile up -d
if ($LASTEXITCODE -ne 0) { throw "Cloudflare Tunnel container failed to start." }

docker ps --filter "name=hosteye-dashboard-cloudflared" --format "table {{.Names}}\t{{.Status}}"
Write-Host "Cloudflare Tunnel started. The local HostEye pipeline was not restarted or modified."

