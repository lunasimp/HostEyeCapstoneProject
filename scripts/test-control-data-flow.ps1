param(
    [string]$ComposeFile = "Vector-HA-Cluster\docker-compose.yml",
    [string]$ControlUrl = "http://127.0.0.1:8080",
    [string]$CollectorAUrl = "http://127.0.0.1:8088/api/v1/telemetry/collector-a",
    [string]$CollectorBUrl = "http://127.0.0.1:8089/api/v1/telemetry/collector-b",
    [int]$DemoSendDelayMs = 0,
    [int]$DemoCollectorReadyDelayMs = 1000,
    [int]$DemoCollectorSlotMs = 1000,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Wait-HttpOk {
    param(
        [string]$Url,
        [string]$Name,
        [int]$Attempts = 60
    )

    Write-Host "Waiting for $Name..."
    for ($i = 0; $i -lt $Attempts; $i++) {
        try {
            $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
            if ($response.ok -or $response.status -eq "ok" -or "$response".Trim() -eq "1") {
                Write-Host "  OK $Name"
                return
            }
        } catch {
        }
        Start-Sleep -Seconds 2
    }
    throw "Timed out waiting for $Name at $Url"
}

function ConvertTo-CompactJson {
    param(
        [Parameter(ValueFromPipeline = $true)]
        [object]$Value
    )
    process {
        return ($Value | ConvertTo-Json -Depth 30 -Compress)
    }
}

function ConvertTo-CanonicalValue {
    param([object]$Value)

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            $result[$key] = ConvertTo-CanonicalValue $Value[$key]
        }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-CanonicalValue $_ })
    }
    return $Value
}

function ConvertTo-CanonicalJson {
    param([object]$Value)
    return (ConvertTo-CanonicalValue $Value | ConvertTo-Json -Depth 30 -Compress)
}

function Get-Sha256Hex {
    param([string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

if (-not $NoStart) {
    Write-Host "Starting control/data test stack..."
    $env:CONTROL_SEND_AFTER_MS = [string][Math]::Max(0, $DemoSendDelayMs)
    $env:CONTROL_COLLECTOR_SLOT_MS = [string][Math]::Max(1, $DemoCollectorSlotMs)
    $env:COLLECTOR_UPLOAD_SLOT_MS = [string][Math]::Max(1, $DemoCollectorSlotMs)
    docker compose -f $ComposeFile up -d --remove-orphans clickhouse redpanda-broker vector-gateway-1 vector-gateway-2 control-plane collector-a collector-b collector-c collector-d collector-e collector-f collector-g collector-h raw-chunk-worker | Out-Host
}

Wait-HttpOk -Url "http://127.0.0.1:8123/?query=SELECT%201" -Name "ClickHouse"
Wait-HttpOk -Url "$ControlUrl/health" -Name "Control Plane"
Wait-HttpOk -Url "http://127.0.0.1:8088/health" -Name "Collector A"

$suffix = (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmmss")
$agentId = "local-flow-agent-$suffix"
$hostId = "local-flow-host-$suffix"
$computer = "LOCAL-FLOW-$suffix"
$now = (Get-Date).ToUniversalTime().ToString("o")

Write-Host "Registering 8 collector schedules with local URLs..."
$collectorIds = @("collector-a", "collector-b", "collector-c", "collector-d", "collector-e", "collector-f", "collector-g", "collector-h")
$collectorUrls = @{
    "collector-a" = $CollectorAUrl
    "collector-b" = $CollectorBUrl
    "collector-c" = "http://127.0.0.1:8090/api/v1/telemetry/collector-c"
    "collector-d" = "http://127.0.0.1:8091/api/v1/telemetry/collector-d"
    "collector-e" = "http://127.0.0.1:8092/api/v1/telemetry/collector-e"
    "collector-f" = "http://127.0.0.1:8093/api/v1/telemetry/collector-f"
    "collector-g" = "http://127.0.0.1:8094/api/v1/telemetry/collector-g"
    "collector-h" = "http://127.0.0.1:8095/api/v1/telemetry/collector-h"
}
$baseReadyAt = [DateTimeOffset]::UtcNow.AddMilliseconds([Math]::Max(0, $DemoCollectorReadyDelayMs))
for ($i = 0; $i -lt $collectorIds.Count; $i++) {
    $collectorId = $collectorIds[$i]
    $readyAt = $baseReadyAt.AddMilliseconds([Math]::Max(1, $DemoCollectorSlotMs) * $i)
    $heartbeatBody = @{
        collector_id = $collectorId
        url = $collectorUrls[$collectorId]
        health = "healthy"
        ready = ($i -eq 0 -and $DemoCollectorReadyDelayMs -le 0)
        active_uploads = 0
        max_uploads = 64
        next_available_at = $readyAt.ToString("o")
        upload_slot_ms = [Math]::Max(1, $DemoCollectorSlotMs)
        write_latency_ms = 1
        storage_lag = 0
    } | ConvertTo-CompactJson
    Invoke-RestMethod -Method Post -Uri "$ControlUrl/api/v1/control/collector/heartbeat" -ContentType "application/json" -Body $heartbeatBody | Out-Null
    Write-Host "  $collectorId next_available_at=$($readyAt.ToString("o"))"
}

$events = @(
    [ordered]@{
        agent_id = $agentId
        host_id = $hostId
        computer = $computer
        timestamp = $now
        channel = "Microsoft-Windows-Sysmon/Operational"
        event_id = 1
        record_id = 1001
        provider_name = "Microsoft-Windows-Sysmon"
        level = "Information"
        message = "Control/data split smoke test process event"
        event_data = [ordered]@{
            Image = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
            CommandLine = "powershell.exe -NoProfile -Command Write-Host HostEyeFlow"
            ParentImage = "C:\Windows\explorer.exe"
            User = "LOCAL-FLOW\analyst"
        }
    },
    [ordered]@{
        agent_id = $agentId
        host_id = $hostId
        computer = $computer
        timestamp = $now
        channel = "Microsoft-Windows-PowerShell/Operational"
        event_id = 4104
        record_id = 1002
        provider_name = "Microsoft-Windows-PowerShell"
        level = "Warning"
        message = "Control/data split smoke test script block event"
        script_block_text = "Write-Output `"HostEye control/data flow`""
        event_data = [ordered]@{
            ScriptBlockText = "Write-Output `"HostEye control/data flow`""
            User = "LOCAL-FLOW\analyst"
        }
    }
)

$eventsJson = ConvertTo-CanonicalJson $events
$checksum = Get-Sha256Hex $eventsJson
$chunkId = Get-Sha256Hex "$agentId|$hostId|$computer|$now|$checksum"
$batchBytes = [System.Text.Encoding]::UTF8.GetByteCount($eventsJson)

Write-Host "Calling Control Plane bootstrap..."
$bootstrapBody = @{
    agent_id = $agentId
    host_id = $hostId
    computer = $computer
    queue_used_mb = 0
    next_chunk_size_mb = [Math]::Round($batchBytes / 1024 / 1024, 6)
    retry_count = 0
    rank = 0
} | ConvertTo-CompactJson
$bootstrap = Invoke-RestMethod -Method Post -Uri "$ControlUrl/api/v1/control/bootstrap" -ContentType "application/json" -Body $bootstrapBody
if (-not $bootstrap.lease_id) {
    throw "Control Plane did not return lease_id: $(ConvertTo-CompactJson $bootstrap)"
}

$telemetryUrl = if ($bootstrap.collector_url) { [string]$bootstrap.collector_url } else { $CollectorAUrl }
Write-Host "Control selected collector=$($bootstrap.collector_id) url=$telemetryUrl lease=$($bootstrap.lease_id)"
Write-Host "Control schedule server_time=$($bootstrap.server_time) send_after=$($bootstrap.send_after) delay_ms=$($bootstrap.send_delay_ms) reason=$($bootstrap.schedule_reason)"
Write-Host "Collector schedule ready_at=$($bootstrap.collector_ready_at) reserved_until=$($bootstrap.collector_reserved_until) slot_ms=$($bootstrap.collector_upload_slot_ms)"

if ($bootstrap.send_after) {
    $sendAfter = [DateTimeOffset]::Parse([string]$bootstrap.send_after)
    $delay = $sendAfter - [DateTimeOffset]::UtcNow
    if ($delay.TotalMilliseconds -gt 0) {
        Write-Host "Waiting until send_after $($sendAfter.ToString("o"))..."
        Start-Sleep -Milliseconds ([int][Math]::Ceiling($delay.TotalMilliseconds))
    }
}

$payload = [ordered]@{
    protocol = "hosteye.telemetry.v1"
    schema_version = "1.0.0"
    chunk_id = $chunkId
    agent_id = $agentId
    host_id = $hostId
    computer = $computer
    source_platform = "hosteye_local_control_data_test"
    shipper_version = "powershell-smoke-1.0.0"
    sequence_number = 1
    event_count = $events.Count
    batch_bytes = $batchBytes
    lease_id = $bootstrap.lease_id
    lease_expires_at = $bootstrap.lease_expires_at
    max_batch_mb = $bootstrap.max_batch_mb
    max_upload_rate_kbps = $bootstrap.max_upload_rate_kbps
    checksum = $checksum
    checksum_algorithm = "sha256"
    created_at = $now
    events = $events
}

Write-Host "Sending telemetry chunk to Data Plane..."
$payloadJson = ConvertTo-CompactJson $payload
$ack = Invoke-RestMethod -Method Post -Uri $telemetryUrl -ContentType "application/json" -Body $payloadJson
if (-not $ack.ack -or -not $ack.commit) {
    throw "Data Plane did not ACK commit: $(ConvertTo-CompactJson $ack)"
}
Write-Host "ACK status=$($ack.status) broker_status=$($ack.broker_status) index_status=$($ack.index_status) chunk=$($ack.chunk_id) event_count=$($ack.event_count)"

$chunkQuery = [Uri]::EscapeDataString("SELECT last_seen, status, duplicate, message FROM default.ingest_chunks WHERE agent_id='$agentId' AND chunk_id='$chunkId' ORDER BY last_seen FORMAT JSONEachRow")
$rawQuery = [Uri]::EscapeDataString("SELECT raw_path, status FROM default.raw_chunk_vault WHERE agent_id='$agentId' AND chunk_id='$chunkId' LIMIT 1 FORMAT JSONEachRow")
$eventQuery = [Uri]::EscapeDataString("SELECT count() AS events FROM default.windows_system_logs WHERE agent_id='$agentId' AND chunk_id='$chunkId' FORMAT JSONEachRow")
$workerQuery = [Uri]::EscapeDataString("SELECT count() AS statuses FROM default.ingest_chunks WHERE agent_id='$agentId' AND chunk_id='$chunkId' AND status='worker_index_queued' FORMAT JSONEachRow")

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $eventRows = Invoke-RestMethod -Uri "http://127.0.0.1:8123/?query=$eventQuery"
    $workerRows = Invoke-RestMethod -Uri "http://127.0.0.1:8123/?query=$workerQuery"
    if ([int]$eventRows.events -eq $events.Count -and [int]$workerRows.statuses -gt 0) { break }
    Start-Sleep -Seconds 1
}

function Get-HttpText {
    param([string]$Url)
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url
    if ($response.Content -is [byte[]]) {
        return [System.Text.Encoding]::UTF8.GetString($response.Content).Trim()
    }
    return ([string]$response.Content).Trim()
}

$chunkRows = Get-HttpText "http://127.0.0.1:8123/?query=$chunkQuery"
$rawRows = Get-HttpText "http://127.0.0.1:8123/?query=$rawQuery"
if ([int]$eventRows.events -ne $events.Count) {
    throw "Worker did not index the expected event count: expected=$($events.Count) actual=$($eventRows.events)"
}
if ([int]$workerRows.statuses -lt 1) {
    throw "Worker status was not persisted for chunk $chunkId"
}
if (-not $rawRows) {
    throw "Raw chunk vault row is missing for chunk $chunkId"
}

Write-Host "Sending the same chunk again to verify idempotency..."
$duplicateAck = Invoke-RestMethod -Method Post -Uri $telemetryUrl -ContentType "application/json" -Body $payloadJson
if (-not $duplicateAck.ack -or -not $duplicateAck.commit -or $duplicateAck.status -ne "duplicate") {
    throw "Duplicate upload was not acknowledged idempotently: $(ConvertTo-CompactJson $duplicateAck)"
}
Start-Sleep -Seconds 1
$eventRowsAfterDuplicate = Invoke-RestMethod -Uri "http://127.0.0.1:8123/?query=$eventQuery"
if ([int]$eventRowsAfterDuplicate.events -ne $events.Count) {
    throw "Duplicate upload changed indexed event count: before=$($eventRows.events) after=$($eventRowsAfterDuplicate.events)"
}

Write-Host ""
Write-Host "Flow test OK"
Write-Host "  Agent      : $agentId"
Write-Host "  Chunk      : $chunkId"
Write-Host "  Lease      : $($bootstrap.lease_id)"
Write-Host "  Collector  : $($bootstrap.collector_id)"
Write-Host "  ACK        : $($ack.status)"
Write-Host "  Broker     : $($ack.broker_status)"
Write-Host "  Index      : $($ack.index_status)"
Write-Host "  Chunk rows :"
Write-Host $chunkRows
Write-Host "  Raw row    :"
Write-Host $rawRows
Write-Host "  Indexed events:"
Write-Host $eventRows
Write-Host "  Duplicate  : $($duplicateAck.status), indexed events still $($eventRowsAfterDuplicate.events)"
