[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot "deploy\cloudflare-tunnel\docker-compose.quick-tunnel.yml"
$projectName = "hosteye-dashboard-quick-tunnel"

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:5174/api/health" -TimeoutSec 10
    if ($health.StatusCode -ne 200) { throw "Unexpected Dashboard health status $($health.StatusCode)." }
} catch {
    throw "The local Dashboard is not healthy. The quick tunnel was not started. $($_.Exception.Message)"
}

$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
$running = docker inspect --format '{{.State.Running}}' hosteye-dashboard-quick-tunnel 2>&1 | Select-Object -Last 1
$ErrorActionPreference = $previousErrorAction

if (([string]$running).Trim().ToLowerInvariant() -ne "true") {
    docker compose --project-name $projectName -f $composeFile up -d
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare Quick Tunnel container failed to start." }
}

$publicUrl = $null
for ($attempt = 0; $attempt -lt 30 -and -not $publicUrl; $attempt += 1) {
    Start-Sleep -Seconds 1
    $logs = (& cmd.exe /d /c "docker logs hosteye-dashboard-quick-tunnel 2>&1") | Out-String
    $match = [regex]::Match($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { $publicUrl = $match.Value }
}

if (-not $publicUrl) {
    & cmd.exe /d /c "docker logs --tail 80 hosteye-dashboard-quick-tunnel 2>&1"
    throw "Cloudflare did not issue a Quick Tunnel URL within 30 seconds."
}

$publicHealth = Invoke-WebRequest -UseBasicParsing -Uri "$publicUrl/api/health" -TimeoutSec 30
if ($publicHealth.StatusCode -ne 200) { throw "Public Dashboard health returned $($publicHealth.StatusCode)." }

try {
    Invoke-WebRequest -UseBasicParsing -Uri "$publicUrl/api/dashboard/overview/summary" -TimeoutSec 30 | Out-Null
    throw "A protected Dashboard API route was reachable without HostEye authentication."
} catch {
    if ([int]$_.Exception.Response.StatusCode -ne 401) { throw }
}

Write-Host "Cloudflare Quick Tunnel is ready: $publicUrl"
Write-Host "Public health PASS and protected API returned 401 without a HostEye token."
Write-Host "This URL is temporary and may change whenever the tunnel container is recreated."
