param(
  [string]$ClickHouseContainer = "local-clickhouse"
)

$ErrorActionPreference = "Stop"

Write-Host "Starting Docker service if needed..."
try {
  Start-Service -Name com.docker.service -ErrorAction Stop
} catch {
  Write-Host "Docker service start skipped or failed: $($_.Exception.Message)"
}

Write-Host "Waiting for Docker engine..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
  docker version *> $null
  if ($LASTEXITCODE -eq 0) {
    $ready = $true
    break
  }
  Start-Sleep -Seconds 2
}

if (-not $ready) {
  throw "Docker engine is not reachable after waiting."
}

Write-Host "Clearing ClickHouse demo tables..."
docker exec $ClickHouseContainer clickhouse-client --multiquery "TRUNCATE TABLE IF EXISTS default.windows_system_logs; TRUNCATE TABLE IF EXISTS default.shipper_runtime_metrics;"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to truncate ClickHouse tables."
}

Write-Host "Row counts after truncate:"
docker exec $ClickHouseContainer clickhouse-client --query "SELECT 'windows_system_logs' AS table, count() AS rows FROM default.windows_system_logs UNION ALL SELECT 'shipper_runtime_metrics' AS table, count() AS rows FROM default.shipper_runtime_metrics FORMAT PrettyCompact"

Write-Host ""
Read-Host "Done. Press Enter to close"
