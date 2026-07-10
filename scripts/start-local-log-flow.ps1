param(
    [string]$ComposeFile = "Vector-HA-Cluster\docker-compose.yml"
)

$ErrorActionPreference = "Stop"

Write-Host "Starting local HostEye log-flow stack..."
docker compose -f $ComposeFile up -d --remove-orphans clickhouse redpanda-broker vector-gateway-1 vector-gateway-2 control-plane collector-a collector-b collector-c collector-d collector-e collector-f collector-g collector-h dashboard-api dashboard-web

Write-Host "Waiting for ClickHouse..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        $result = Invoke-RestMethod "http://127.0.0.1:8123/?query=SELECT%201"
        if ($result -eq 1) { break }
    } catch {}
    Start-Sleep -Seconds 2
}

Write-Host "Waiting for control plane..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8080/health"
        if ($health.ok) { break }
    } catch {}
    Start-Sleep -Seconds 2
}

Write-Host "Waiting for collector A..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8088/health"
        if ($health.ok) { break }
    } catch {}
    Start-Sleep -Seconds 2
}

Write-Host "Waiting for dashboard API..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:5055/api/health"
        if ($health.status -eq "ok") { break }
    } catch {}
    Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "Local stack is ready:"
Write-Host "  Control plane  : http://127.0.0.1:8080"
Write-Host "  Collector A    : http://127.0.0.1:8088"
Write-Host "  Collector B    : http://127.0.0.1:8089"
Write-Host "  Collector C-H  : http://127.0.0.1:8090 .. http://127.0.0.1:8095"
Write-Host "  ClickHouse     : http://127.0.0.1:8123"
Write-Host "  Dashboard API  : http://127.0.0.1:5055/api/health"
Write-Host "  Dashboard UI   : http://127.0.0.1:5174"
