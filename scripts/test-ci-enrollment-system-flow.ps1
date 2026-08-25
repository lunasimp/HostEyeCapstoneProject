param(
    [string]$RegistrationUrl = "http://127.0.0.1:5054",
    [string]$RegistrationAdminToken = $env:HOSTEYE_REGISTRATION_ADMIN_TOKEN,
    [string]$AdmissionUrl = "http://127.0.0.1:8080/api/v1/admission/request",
    [string]$ClickHouseUrl = "http://127.0.0.1:8123",
    [string]$RegistrationImage = "vector-ha-cluster-hosteye-registration",
    [string]$DataPlaneImage = "vector-ha-cluster-collector-a",
    [string]$WorkerImage = "vector-ha-cluster-raw-chunk-worker",
    [string]$DockerNetwork = "vector-ha-cluster_soc-network",
    [int]$IsolatedCollectorPort = 18089,
    [int]$IndexTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RegistrationAdminToken)) {
    throw "Set HOSTEYE_REGISTRATION_ADMIN_TOKEN or pass -RegistrationAdminToken."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$evidenceDirectory = Join-Path $PSScriptRoot "..\test-results\ci-enrollment\$timestamp"
New-Item -ItemType Directory -Force -Path $evidenceDirectory | Out-Null
$steps = [System.Collections.Generic.List[object]]::new()
$workerContainer = $null
$collectorContainer = $null
$testTopic = $null

function Add-Step([string]$Name, [string]$Status, [object]$Detail) {
    $steps.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail; at = (Get-Date).ToUniversalTime().ToString("o") })
    Write-Host "[$Status] $Name`: $Detail"
}

function Invoke-HostEyeJson([string]$Uri, [string]$Method = "GET", [object]$Body = $null, [hashtable]$Headers = @{}) {
    $parameters = @{ Uri = $Uri; Method = $Method; Headers = $Headers; TimeoutSec = 30 }
    if ($null -ne $Body) {
        $parameters.ContentType = "application/json"
        $parameters.Body = $Body | ConvertTo-Json -Depth 10 -Compress
    }
    Invoke-RestMethod @parameters
}

function Get-Sha256([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-ContainerLogs([string]$ContainerName) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { return (& docker logs $ContainerName 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $previousPreference }
}

function New-TestEvent([string]$AgentId, [string]$HostId, [uint64]$RecordId, [string]$Marker) {
    [ordered]@{
        agent_id = $AgentId
        channel = "Application"
        computer = "HOSTEYE-CI-INTEGRATION"
        event_id = 777
        host_id = $HostId
        message = $Marker
        provider_name = "HostEyeCiEnrollmentTest"
        record_id = $RecordId
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
    }
}

function Request-Lease([string]$CiId, [string]$AgentId, [string]$HostId) {
    Invoke-HostEyeJson -Uri $AdmissionUrl -Method POST -Body ([ordered]@{
        ci_id = $CiId; agent_id = $AgentId; host_id = $HostId; computer = "HOSTEYE-CI-INTEGRATION"
        queue_used_mb = 0; next_chunk_size_mb = 0.01; retry_count = 0; rank = 0
        collected_event_count = 1; sent_event_count = 0; pending_event_count = 1; dropped_event_count = 0
        collected_events_by_source = @{}; dropped_events_by_source = @{}; unattributed_dropped_event_count = 0
        max_spool_bytes = 268435456
    })
}

function New-Chunk([string]$CiId, [string]$AgentId, [string]$HostId, [object]$Lease, [object]$Event) {
    $events = @($Event)
    $eventsJson = ConvertTo-Json -InputObject $events -Depth 10 -Compress
    [ordered]@{
        protocol = "hosteye.telemetry.v1"
        schema_version = "1.0.0"
        chunk_id = "ci-test-$([guid]::NewGuid().ToString('N'))"
        agent_id = $AgentId
        ci_id = $CiId
        host_id = $HostId
        computer = "HOSTEYE-CI-INTEGRATION"
        source_platform = "hosteye_ci_system_test"
        shipper_version = "ci-system-test"
        sequence_number = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        event_count = 1
        checksum = Get-Sha256 $eventsJson
        lease_id = [string]$Lease.lease_id
        lease_expires_at = [string]$Lease.lease_expires_at
        events = $events
    }
}

try {
    $health = Invoke-HostEyeJson -Uri "$RegistrationUrl/health"
    if (-not $health.ok) { throw "Registration service is not healthy." }
    Add-Step "registration_health" "PASS" $health.service

    $tokenResponse = Invoke-HostEyeJson -Uri "$RegistrationUrl/api/v1/admin/tokens" -Method POST -Headers @{ "x-hosteye-admin-token" = $RegistrationAdminToken; "x-hosteye-actor" = "ci-system-test" } -Body ([ordered]@{
        expectedHostname = "HOSTEYE-CI-INTEGRATION"; owner = "automated-system-test"; groupId = "integration-test"
        policyId = "policy-default-windows-baseline"; ttlMinutes = 15
    })
    Add-Step "one_time_token_created" "PASS" "ci_id=$($tokenResponse.ciId); expires=$($tokenResponse.expiresAt)"

    $csrLines = & docker run --rm --entrypoint sh $RegistrationImage -c 'openssl req -quiet -new -newkey rsa:2048 -nodes -sha256 -subj "/CN=agent-ci-integration/OU=HostEye Endpoint/O=HostEye" -keyout /tmp/client.key -out /dev/stdout 2>/dev/null'
    if ($LASTEXITCODE -ne 0) { throw "OpenSSL CSR generation in the registration image failed." }
    $csr = ($csrLines -join "`n") + "`n"
    $agentId = "agent-ci-$([guid]::NewGuid().ToString('N'))"
    $hostId = "host-ci-$([guid]::NewGuid().ToString('N'))"
    $enrolled = Invoke-HostEyeJson -Uri "$RegistrationUrl/api/v1/enroll" -Method POST -Body ([ordered]@{
        token = $tokenResponse.token; agentId = $agentId; hostId = $hostId
        actualHostname = "HOSTEYE-CI-INTEGRATION"; agentVersion = "ci-system-test"; csr = $csr
    })
    if ($enrolled.ciId -ne $tokenResponse.ciId) { throw "Enrollment returned an unexpected C_i." }
    Add-Step "csr_enrollment" "PASS" "ci_id=$($enrolled.ciId); serial=$($enrolled.device.certificateSerial)"

    # A dedicated topic isolates this marker from the demo backlog while using
    # the same data-plane and worker binaries as the running local stack.
    $testTopic = "raw-chunk-ci-$($timestamp.ToLowerInvariant())"
    & docker exec redpanda-broker rpk topic create $testTopic --brokers localhost:9092 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Dedicated Redpanda test topic could not be created." }
    $rawChunkDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..\Vector-HA-Cluster\raw_chunks")).Path
    $collectorContainer = "hosteye-ci-test-collector-$([guid]::NewGuid().ToString('N').Substring(0, 10))"
    & docker run -d --rm --name $collectorContainer --network $DockerNetwork `
        -p "127.0.0.1:${IsolatedCollectorPort}:8088" `
        -v "${rawChunkDirectory}:/var/lib/hosteye/raw_chunks" `
        -e PORT=8088 -e COLLECTOR_ID=collector-a -e CLICKHOUSE_URL=http://clickhouse:8123 `
        -e CONTROL_PLANE_URL=http://control-plane:8080 -e REGISTRATION_URL=http://hosteye-registration:5054 `
        -e REGISTRATION_ADMIN_TOKEN=$RegistrationAdminToken -e REQUIRE_ENROLLED_IDENTITY=false `
        -e REDPANDA_PROXY_URL=http://redpanda-broker:8082 -e RAW_CHUNK_TOPIC=$testTopic `
        -e DIRECT_VECTOR_FORWARD=false -e VECTOR_URL=http://vector-gateway-1:8686/ `
        -e REQUIRED_SCHEMA_VERSION=1.0.0 -e RAW_CHUNK_DIR=/var/lib/hosteye/raw_chunks $DataPlaneImage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Isolated data-plane collector could not start." }
    $collectorDeadline = (Get-Date).AddSeconds(30)
    do {
        try { $collectorHealth = Invoke-HostEyeJson -Uri "http://127.0.0.1:$IsolatedCollectorPort/health" } catch { $collectorHealth = $null }
        if ($collectorHealth.ready) { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $collectorDeadline)
    if (-not $collectorHealth.ready) { throw "Isolated data-plane collector did not become ready." }
    Add-Step "isolated_collector_ready" "PASS" "topic=$testTopic; container=$collectorContainer"

    $workerContainer = "hosteye-ci-test-worker-$([guid]::NewGuid().ToString('N').Substring(0, 10))"
    & docker run -d --rm --name $workerContainer --network $DockerNetwork `
        -v "${rawChunkDirectory}:/var/lib/hosteye/raw_chunks" `
        -e REDPANDA_PROXY_URL=http://redpanda-broker:8082 `
        -e RAW_CHUNK_TOPIC=$testTopic `
        -e RAW_WORKER_GROUP="ci-enrollment-$timestamp" `
        -e RAW_WORKER_AUTO_OFFSET_RESET=earliest `
        -e CLICKHOUSE_URL=http://clickhouse:8123 `
        -e VECTOR_URL=http://vector-gateway-1:8686/ $WorkerImage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Isolated raw-chunk worker could not start." }
    $workerReadyDeadline = (Get-Date).AddSeconds(30)
    do {
        $workerLogs = Get-ContainerLogs $workerContainer
        if ($workerLogs -match "raw-chunk-worker ready, polling") { break }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $workerReadyDeadline)
    if ($workerLogs -notmatch "raw-chunk-worker ready, polling") { throw "Isolated raw-chunk worker did not become ready." }
    Add-Step "isolated_worker_ready" "PASS" "container=$workerContainer"

    $recordId = [uint64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $marker = "HostEye C_i active identity test $timestamp"
    $lease = Request-Lease $enrolled.ciId $agentId $hostId
    if ($lease.admission -ne "ok" -or [string]::IsNullOrWhiteSpace([string]$lease.lease_id)) { throw "Control plane did not grant an upload lease." }
    Add-Step "upload_lease" "PASS" "lease_id=$($lease.lease_id)"

    $chunk = New-Chunk $enrolled.ciId $agentId $hostId $lease (New-TestEvent $agentId $hostId $recordId $marker)
    $isolatedTelemetryUrl = "http://127.0.0.1:$IsolatedCollectorPort/api/v1/telemetry/collector-a"
    $ack = Invoke-HostEyeJson -Uri $isolatedTelemetryUrl -Method POST -Headers @{ "X-HostEye-CI-ID" = $enrolled.ciId } -Body $chunk
    if (-not $ack.ack -or -not $ack.commit) { throw "Gateway did not return durable ACK." }
    Add-Step "gateway_durable_ack" "PASS" "chunk_id=$($chunk.chunk_id); status=$($ack.status)"

    $deadline = (Get-Date).AddSeconds($IndexTimeoutSeconds)
    $indexed = $null
    do {
        $sql = "SELECT count() AS events FROM default.windows_system_logs WHERE agent_id='$agentId' AND record_id=$recordId FORMAT JSONEachRow"
        $queryUri = "$ClickHouseUrl/?query=$([uri]::EscapeDataString($sql))"
        $indexed = Invoke-RestMethod -Uri $queryUri -TimeoutSec 10
        if ([int]$indexed.events -gt 0) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if ([int]$indexed.events -lt 1) { throw "Enrolled telemetry was not indexed within $IndexTimeoutSeconds seconds." }

    $lineageSql = "SELECT ci_id, enrollment_status, last_chunk_id FROM default.registered_agents FINAL WHERE agent_id='$agentId' ORDER BY last_seen DESC LIMIT 1 FORMAT JSONEachRow"
    $lineage = Invoke-RestMethod -Uri "$ClickHouseUrl/?query=$([uri]::EscapeDataString($lineageSql))" -TimeoutSec 10
    if ($lineage.ci_id -ne $enrolled.ciId -or $lineage.enrollment_status -ne "enrolled") { throw "ClickHouse C_i lineage was not persisted." }
    Add-Step "clickhouse_ci_lineage" "PASS" "events=$($indexed.events); ci_id=$($lineage.ci_id); chunk_id=$($lineage.last_chunk_id)"

    $revoked = Invoke-HostEyeJson -Uri "$RegistrationUrl/api/v1/admin/devices/$($enrolled.device.deviceRecordId)/revoke" -Method POST -Headers @{ "x-hosteye-admin-token" = $RegistrationAdminToken; "x-hosteye-actor" = "ci-system-test" } -Body @{ reason = "automated revocation verification" }
    if ($revoked.status -ne "Revoked") { throw "Registration service did not revoke the test identity." }
    Add-Step "identity_revoked" "PASS" "device=$($revoked.deviceRecordId)"

    $rejectedLease = Request-Lease $enrolled.ciId $agentId $hostId
    $rejectedChunk = New-Chunk $enrolled.ciId $agentId $hostId $rejectedLease (New-TestEvent $agentId $hostId ($recordId + 1) "revoked identity must be rejected")
    try {
        Invoke-HostEyeJson -Uri $isolatedTelemetryUrl -Method POST -Headers @{ "X-HostEye-CI-ID" = $enrolled.ciId } -Body $rejectedChunk | Out-Null
        throw "Revoked C_i upload was unexpectedly accepted."
    } catch {
        $response = $_.Exception.Response
        if (-not $response -or [int]$response.StatusCode -ne 403) { throw }
    }
    Add-Step "revoked_upload_rejected" "PASS" "http_status=403"

    $result = [ordered]@{ status = "PASS"; startedAt = $timestamp; ciId = $enrolled.ciId; agentId = $agentId; hostId = $hostId; steps = $steps }
    [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory "result.json"), ($result | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    Write-Host "C_i enrollment system flow PASS. Evidence: $evidenceDirectory"
} catch {
    $result = [ordered]@{ status = "FAIL"; startedAt = $timestamp; error = $_.Exception.Message; steps = $steps }
    [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory "result.json"), ($result | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    throw
} finally {
    if ($workerContainer) {
        $workerLogs = Get-ContainerLogs $workerContainer
        [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory "worker.log"), $workerLogs, [Text.UTF8Encoding]::new($false))
        & docker stop $workerContainer 2>$null | Out-Null
    }
    if ($collectorContainer) {
        $collectorLogs = Get-ContainerLogs $collectorContainer
        [System.IO.File]::WriteAllText((Join-Path $evidenceDirectory "collector.log"), $collectorLogs, [Text.UTF8Encoding]::new($false))
        & docker stop $collectorContainer 2>$null | Out-Null
    }
    if ($testTopic) {
        & docker exec redpanda-broker rpk topic delete $testTopic --brokers localhost:9092 2>$null | Out-Null
    }
}
