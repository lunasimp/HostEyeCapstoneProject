param(
    [string]$InstallerPath = (Join-Path $PSScriptRoot "..\HostEyeAgent\Output\HostEye_Endpoint_Installer_LocalTest.exe"),
    [string]$EvidenceDirectory = (Join-Path $PSScriptRoot "..\test-results\clean-installer"),
    [string]$DashboardApiUrl = "http://127.0.0.1:5055",
    [string]$DashboardWebUrl = "http://127.0.0.1:5174",
    [int]$TelemetryTimeoutSeconds = 420
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$InstallerPath = (Resolve-Path $InstallerPath).Path
$EvidenceDirectory = [System.IO.Path]::GetFullPath($EvidenceDirectory)

$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
    $argumentList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
        "-InstallerPath", "`"$InstallerPath`"",
        "-EvidenceDirectory", "`"$EvidenceDirectory`"",
        "-DashboardApiUrl", "`"$DashboardApiUrl`"",
        "-DashboardWebUrl", "`"$DashboardWebUrl`"",
        "-TelemetryTimeoutSeconds", [string]$TelemetryTimeoutSeconds
    )
    try {
        $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -Verb RunAs -Wait -PassThru
        exit $process.ExitCode
    } catch {
        throw "Administrator elevation could not be opened from this session. Open PowerShell as Administrator and run: powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDirectory = Join-Path $EvidenceDirectory $stamp
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
$transcriptPath = Join-Path $runDirectory "clean-installer-system-test.log"
Start-Transcript -Path $transcriptPath -Force | Out-Null
$script:stageResults = [ordered]@{}

function Set-TestStage([string]$Name, [string]$Status, [hashtable]$Details = @{}) {
    $script:stageResults[$Name] = [ordered]@{
        status = $Status
        observed_at = (Get-Date).ToUniversalTime().ToString("o")
        details = $Details
    }
    $script:stageResults | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $runDirectory "stage-results.json") -Encoding UTF8
    Write-Host ("[{0}] {1}: {2}" -f $Status, $Name, (($Details.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "; "))
}

function Get-SpoolStats {
    $spool = "C:\ProgramData\HostEye\spool"
    $files = @(Get-ChildItem -LiteralPath $spool -Filter "chunk_*.gz" -File -ErrorAction SilentlyContinue)
    [ordered]@{
        pending_files = $files.Count
        pending_bytes = [uint64](($files | Measure-Object -Property Length -Sum).Sum)
        oldest_created = if ($files) { ($files | Sort-Object CreationTime | Select-Object -First 1).CreationTime.ToString("o") } else { $null }
        newest_created = if ($files) { ($files | Sort-Object CreationTime -Descending | Select-Object -First 1).CreationTime.ToString("o") } else { $null }
    }
}

function Find-EventChunk([uint64]$RecordId, [datetime]$CreatedAfter) {
    $needleProvider = '"provider_name":"HostEyeCleanInstallTest"'
    $needleRecord = '"record_id":' + $RecordId
    foreach ($file in Get-ChildItem "C:\ProgramData\HostEye\spool" -Filter "chunk_*.gz" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.CreationTime -ge $CreatedAfter.AddSeconds(-5) } | Sort-Object CreationTime) {
        try {
            $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            try {
                $gzip = [IO.Compression.GzipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress)
                $reader = [IO.StreamReader]::new($gzip)
                try { $text = $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose() }
            } finally { $stream.Dispose() }
            if ($text.Contains($needleProvider) -and $text.Contains($needleRecord)) { return $file }
        } catch {}
    }
    return $null
}

function Collect-FailureEvidence {
    Get-ServiceEvidence (Join-Path $runDirectory "services-at-failure.json")
    Get-SpoolStats | ConvertTo-Json | Set-Content (Join-Path $runDirectory "spool-at-failure.json") -Encoding UTF8
    foreach ($source in @(
        "C:\ProgramData\HostEye\logs",
        "C:\ProgramData\HostEye\shipper_state"
    )) {
        if (Test-Path $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $runDirectory (Split-Path $source -Leaf)) -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path "C:\Program Files\HostEye\vector.toml") {
        Copy-Item "C:\Program Files\HostEye\vector.toml" (Join-Path $runDirectory "installed-vector.toml") -Force -ErrorAction SilentlyContinue
    }
    foreach ($container in @("hosteye-control-plane", "hosteye-collector-a", "redpanda-broker", "hosteye-raw-chunk-worker", "hosteye-clickhouse", "hosteye-dashboard-api")) {
        try { docker logs --since 15m $container 2>&1 | Set-Content (Join-Path $runDirectory "docker-$container.log") -Encoding UTF8 } catch {}
    }
}

function Get-ServiceEvidence([string]$Path) {
    $items = foreach ($name in @("HostEyeAgent", "HostEyeShipper", "HostEyeLocalMirror", "Sysmon64")) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'" -ErrorAction SilentlyContinue
        if ($service) {
            [pscustomobject]@{
                Name = $name
                State = $service.State
                StartMode = $service.StartMode
                StartName = $service.StartName
                PathName = $service.PathName
            }
        } else {
            [pscustomobject]@{ Name = $name; State = "Absent"; StartMode = ""; StartName = ""; PathName = "" }
        }
    }
    $items | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

try {
    Write-Host "Recording pre-uninstall state..."
    Get-ServiceEvidence (Join-Path $runDirectory "services-before.json")
    if (Test-Path -LiteralPath "C:\ProgramData\HostEye\logs") {
        Copy-Item -LiteralPath "C:\ProgramData\HostEye\logs" -Destination (Join-Path $runDirectory "logs-before") -Recurse -Force
    }

    Write-Host "Removing HostEye endpoint services, tasks, data, and Sysmon..."
    & (Join-Path $repoRoot "HostEyeAgent\scripts\uninstall.ps1") -RemoveData -RemoveSysmon

    $uninstaller = "C:\Program Files\HostEye\unins000.exe"
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
        if ($uninstallProcess.ExitCode -ne 0) { throw "Existing HostEye uninstaller failed with exit code $($uninstallProcess.ExitCode)." }
    }
    if (Test-Path -LiteralPath "C:\Program Files\HostEye") {
        Remove-Item -LiteralPath "C:\Program Files\HostEye" -Recurse -Force
    }

    foreach ($name in @("HostEyeAgent", "HostEyeShipper", "HostEyeLocalMirror")) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw "Clean uninstall left service $name installed." }
    }
    if (Test-Path -LiteralPath "C:\ProgramData\HostEye") { throw "Clean uninstall left C:\ProgramData\HostEye behind." }
    Get-ServiceEvidence (Join-Path $runDirectory "services-after-uninstall.json")

    Write-Host "Installing clean HostEye endpoint package..."
    $installerLog = Join-Path $runDirectory "inno-installer.log"
    $installProcess = Start-Process -FilePath $InstallerPath -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$installerLog`"" -Wait -PassThru
    if ($installProcess.ExitCode -ne 0) { throw "HostEye installer failed with exit code $($installProcess.ExitCode)." }

    foreach ($name in @("HostEyeAgent", "HostEyeShipper")) {
        $service = Get-Service -Name $name -ErrorAction Stop
        if ($service.Status -ne "Running") { throw "$name is installed but not running (state=$($service.Status))." }
    }
    Set-TestStage "services_installed" "PASS" @{ agent = "Running"; shipper = "Running" }
    $shipperService = Get-CimInstance Win32_Service -Filter "Name='HostEyeShipper'"
    if ($shipperService.StartMode -ne "Auto" -or $shipperService.StartName -ne "LocalSystem") {
        throw "HostEyeShipper service identity/start mode is invalid: StartMode=$($shipperService.StartMode) StartName=$($shipperService.StartName)"
    }

    $configPath = "C:\Program Files\HostEye\HostEyeShipper\shipper-config.json"
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.GatewayUri -notlike "http://127.0.0.1:8088/*") { throw "Installer did not write the local GatewayUri." }
    if ($config.ConfigUri -ne "http://127.0.0.1:8080/api/v1/agent/config") { throw "Installer did not write the local ConfigUri." }
    if ($config.AdmissionUri -ne "http://127.0.0.1:8080/api/v1/admission/request") { throw "Installer did not write the local AdmissionUri." }
    Copy-Item -LiteralPath $configPath -Destination (Join-Path $runDirectory "shipper-config.json") -Force

    $shipperLog = "C:\ProgramData\HostEye\logs\shipper.log"
    $parsedConfigConfirmed = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (Test-Path -LiteralPath $shipperLog) {
            $startupLine = Get-Content -LiteralPath $shipperLog -ErrorAction SilentlyContinue |
                Where-Object { $_ -match "HostEyeShipper starting" } |
                Select-Object -Last 1
            if ($startupLine -and $startupLine.Contains("Gateway=$($config.GatewayUri)") -and $startupLine.Contains("StartupJitter=5s")) {
                $parsedConfigConfirmed = $true
                break
            }
        }
        Start-Sleep -Seconds 1
    }
    if (-not $parsedConfigConfirmed) {
        throw "HostEyeShipper did not confirm the packaged local configuration in its startup log."
    }
    Set-TestStage "shipper_configuration" "PASS" @{ gateway = $config.GatewayUri; startup_jitter_seconds = 5 }

    Write-Host "Generating a unique Windows Application event..."
    $marker = "HostEye clean installer E2E $stamp"
    $eventCreatedAfter = Get-Date
    & eventcreate.exe /T INFORMATION /ID 777 /L APPLICATION /SO HostEyeCleanInstallTest /D $marker | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "eventcreate.exe failed with exit code $LASTEXITCODE." }

    $windowsEvent = $null
    for ($attempt = 0; $attempt -lt 15 -and -not $windowsEvent; $attempt++) {
        $windowsEvent = Get-WinEvent -FilterHashtable @{ LogName = "Application"; ProviderName = "HostEyeCleanInstallTest"; Id = 777; StartTime = $eventCreatedAfter.AddSeconds(-2) } -ErrorAction SilentlyContinue |
            Where-Object { $_.Message -eq $marker } | Sort-Object RecordId -Descending | Select-Object -First 1
        if (-not $windowsEvent) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $windowsEvent) { throw "The generated marker could not be read back from Windows Application log." }
    $windowsEvent.ToXml() | Set-Content (Join-Path $runDirectory "generated-windows-event.xml") -Encoding UTF8
    Set-TestStage "windows_event_created" "PASS" @{ provider = $windowsEvent.ProviderName; event_id = $windowsEvent.Id; record_id = $windowsEvent.RecordId }

    $deadline = (Get-Date).AddSeconds($TelemetryTimeoutSeconds)
    $indexed = 0
    $markerChunk = $null
    $lastProgress = Get-Date
    while ((Get-Date) -lt $deadline) {
        if (-not $markerChunk) {
            $markerChunk = Find-EventChunk -RecordId $windowsEvent.RecordId -CreatedAfter $eventCreatedAfter
            if ($markerChunk) {
                $chunkId = ($markerChunk.BaseName -split '_')[1]
                Set-TestStage "durable_spool" "PASS" @{ chunk_id = $chunkId; file = $markerChunk.Name }
            }
        }
        $query = [Uri]::EscapeDataString("SELECT count() AS events FROM default.windows_system_logs WHERE provider_name = 'HostEyeCleanInstallTest' AND event_id = 777 AND record_id = $($windowsEvent.RecordId) FORMAT JSONEachRow")
        try {
            $result = Invoke-RestMethod -Uri "http://127.0.0.1:8123/?query=$query" -TimeoutSec 5
            $indexed = [int]$result.events
            if ($indexed -gt 0) { break }
        } catch {}
        if (((Get-Date) - $lastProgress).TotalSeconds -ge 30) {
            $stats = Get-SpoolStats
            Write-Host ("Waiting for RecordId {0}: pending_files={1}, pending_bytes={2}" -f $windowsEvent.RecordId, $stats.pending_files, $stats.pending_bytes)
            $lastProgress = Get-Date
        }
        Start-Sleep -Seconds 3
    }
    if ($indexed -lt 1) {
        $stats = Get-SpoolStats
        Set-TestStage "clickhouse_index" "FAIL" @{ record_id = $windowsEvent.RecordId; timeout_seconds = $TelemetryTimeoutSeconds; pending_files = $stats.pending_files; marker_chunk = if ($markerChunk) { $markerChunk.Name } else { "not_observed" } }
        throw "Windows event RecordId $($windowsEvent.RecordId) was not indexed in ClickHouse within $TelemetryTimeoutSeconds seconds. See stage-results.json and collected component logs."
    }
    if (-not $markerChunk) { Set-TestStage "durable_spool" "FAST_PATH" @{ note = "Chunk was uploaded before the polling scan observed it." } }
    $detailQuery = [Uri]::EscapeDataString("SELECT chunk_id, kafka_timestamp FROM default.windows_system_logs WHERE provider_name = 'HostEyeCleanInstallTest' AND event_id = 777 AND record_id = $($windowsEvent.RecordId) ORDER BY kafka_timestamp DESC LIMIT 1 FORMAT JSONEachRow")
    $indexedRow = Invoke-RestMethod -Uri "http://127.0.0.1:8123/?query=$detailQuery" -TimeoutSec 5
    if (-not $chunkId) { $chunkId = [string]$indexedRow.chunk_id }
    Set-TestStage "clickhouse_index" "PASS" @{ record_id = $windowsEvent.RecordId; indexed_events = $indexed; chunk_id = $chunkId; kafka_timestamp = $indexedRow.kafka_timestamp }

    $shipperText = if (Test-Path $shipperLog) { Get-Content $shipperLog -Raw -ErrorAction SilentlyContinue } else { "" }
    $collectorText = try { (docker logs --since 15m hosteye-collector-a 2>&1 | Out-String) } catch { "" }
    $workerText = try { (docker logs --since 15m hosteye-raw-chunk-worker 2>&1 | Out-String) } catch { "" }
    Set-TestStage "upload_lease" $(if ($shipperText -match "Admission OK lease=") { "PASS" } else { "INFERRED" }) @{ evidence = if ($shipperText -match "Admission OK lease=") { "shipper Admission OK" } else { "successful indexed chunk requires an accepted upload" } }
    Set-TestStage "gateway_durable_ack" $(if (($shipperText -like "*Sent OK chunk=$chunkId*") -or ($collectorText -like "*$chunkId*")) { "PASS" } else { "INFERRED" }) @{ chunk_id = $chunkId; evidence = "shipper/collector logs and ClickHouse lineage" }
    Set-TestStage "redpanda_worker" $(if ($workerText -like "*$chunkId*") { "PASS" } else { "INFERRED" }) @{ chunk_id = $chunkId; evidence = if ($workerText -like "*$chunkId*") { "worker processed chunk" } else { "ClickHouse row retains worker-produced chunk_id" } }

    Write-Host "Verifying the indexed marker through the authenticated Dashboard API..."
    $envValues = @{}
    Get-Content -LiteralPath (Join-Path $repoRoot "Vector-HA-Cluster\.env") | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') { $envValues[$matches[1].Trim()] = $matches[2].Trim() }
    }
    $loginBody = @{
        username = $envValues["HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME"]
        password = $envValues["HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD"]
    } | ConvertTo-Json
    $login = Invoke-RestMethod -Method Post -Uri "$DashboardApiUrl/api/dashboard/auth/login" -ContentType "application/json" -Body $loginBody
    if (-not $login.token) { throw "Dashboard login did not return a bearer token." }
    $headers = @{ Authorization = "Bearer $($login.token)" }
    $search = Invoke-RestMethod -Uri "$DashboardApiUrl/api/logs/search?q=$([Uri]::EscapeDataString($marker))&limit=10" -Headers $headers
    if ([int]$search.total -lt 1) { throw "Dashboard API could not find the clean-install event marker." }
    $webResponse = Invoke-WebRequest -UseBasicParsing -Uri $DashboardWebUrl -TimeoutSec 10
    if ($webResponse.StatusCode -ne 200) { throw "Dashboard web returned HTTP $($webResponse.StatusCode)." }
    Set-TestStage "dashboard" "PASS" @{ api_matches = [int]$search.total; web_status = $webResponse.StatusCode }

    Write-Host "Checking whether the endpoint spool is converging..."
    $spoolBefore = Get-SpoolStats
    Start-Sleep -Seconds 20
    $spoolAfter = Get-SpoolStats
    $spoolGrowth = [int]$spoolAfter.pending_files - [int]$spoolBefore.pending_files
    if ($spoolGrowth -gt 20) {
        Set-TestStage "spool_convergence" "FAIL" @{ before = $spoolBefore.pending_files; after = $spoolAfter.pending_files; growth = $spoolGrowth; observation_seconds = 20 }
        throw "The end-to-end event passed, but the endpoint spool is not converging (grew by $spoolGrowth files in 20 seconds)."
    }
    Set-TestStage "spool_convergence" "PASS" @{ before = $spoolBefore.pending_files; after = $spoolAfter.pending_files; growth = $spoolGrowth; observation_seconds = 20 }

    Get-ServiceEvidence (Join-Path $runDirectory "services-after-install.json")
    if (Test-Path -LiteralPath "C:\ProgramData\HostEye\logs") {
        Copy-Item -LiteralPath "C:\ProgramData\HostEye\logs" -Destination (Join-Path $runDirectory "logs-after") -Recurse -Force
    }
    [pscustomobject]@{
        status = "PASS"
        installer = $InstallerPath
        marker = $marker
        indexed_events = $indexed
        dashboard_matches = [int]$search.total
        dashboard_web_status = $webResponse.StatusCode
        spool_pending_files = $spoolAfter.pending_files
        spool_growth_over_20_seconds = $spoolGrowth
        tested_at = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory "result.json") -Encoding UTF8

    Write-Host "Clean installer endpoint-to-ClickHouse system test PASS. Evidence: $runDirectory"
} catch {
    Collect-FailureEvidence
    [pscustomobject]@{
        status = "FAIL"
        error = $_.Exception.Message
        tested_at = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory "result.json") -Encoding UTF8
    throw
} finally {
    Stop-Transcript | Out-Null
}
