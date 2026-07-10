param(
    [string]$Computer = "",
    [string]$ChunkId = "",
    [string]$SearchTerm = "HostEye smoke flow",
    [int]$Tail = 40
)

$ErrorActionPreference = "Stop"

function Invoke-ClickHouseJsonEachRow([string]$Sql) {
    $encoded = [uri]::EscapeDataString("$Sql FORMAT JSONEachRow")
    Invoke-RestMethod "http://127.0.0.1:8123/?query=$encoded"
}

Write-Host "== Containers =="
docker compose -f "Vector-HA-Cluster\docker-compose.yml" ps

Write-Host ""
Write-Host "== Gateway logs =="
docker logs --tail $Tail hosteye-ingest-ack-gateway

Write-Host ""
Write-Host "== Vector logs =="
docker logs --tail $Tail vector-gateway-1

if ($ChunkId) {
    Write-Host ""
    Write-Host "== Ingest chunk states =="
    Invoke-ClickHouseJsonEachRow "SELECT last_seen, agent_id, computer, chunk_id, status, duplicate, message FROM default.ingest_chunks WHERE chunk_id = '$ChunkId' ORDER BY last_seen"

    Write-Host ""
    Write-Host "== Raw chunk vault =="
    Invoke-ClickHouseJsonEachRow "SELECT kafka_timestamp, agent_id, computer, chunk_id, raw_path, raw_size_bytes, compressed_size_bytes, status FROM default.raw_chunk_vault WHERE chunk_id = '$ChunkId'"
}

if ($Computer) {
    Write-Host ""
    Write-Host "== Normalized ClickHouse logs =="
    Invoke-ClickHouseJsonEachRow "SELECT kafka_timestamp, computer, channel, event_id, left(message, 120) AS message, chunk_id, idempotency_key FROM default.windows_system_logs WHERE computer = '$Computer' ORDER BY kafka_timestamp DESC LIMIT 20"

    Write-Host ""
    Write-Host "== Dashboard API search =="
    $query = [uri]::EscapeDataString($SearchTerm)
    $hostFilter = [uri]::EscapeDataString($Computer)
    Invoke-RestMethod "http://127.0.0.1:5055/api/logs/search?q=$query&host=$hostFilter&from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z&limit=20" | ConvertTo-Json -Depth 5
}

Write-Host ""
Write-Host "Dashboard UI: http://127.0.0.1:5174"
