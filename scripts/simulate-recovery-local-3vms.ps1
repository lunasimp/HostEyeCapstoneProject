param(
    [int]$EventsPerVm = 24,
    [int]$BatchEvents = 6,
    [int]$Cycles = 4,
    [int]$NormalJitterSeconds = 2,
    [int]$RecoveryJitterSeconds = 20,
    [string]$GatewayUri = "https://localhost/api/v1/telemetry",
    [string]$WorkDir = "$PSScriptRoot\..\sim-recovery-local",
    [string]$ShipperExe = "$PSScriptRoot\..\VectorBuild\SOCShipper\publish\HostEyeShipper.exe",
    [string]$LocalInstallerExe = "$PSScriptRoot\..\VectorBuild\Output\HostEye_Endpoint_Installer_Local.exe",
    [string]$CertDir = "$PSScriptRoot\..\VectorBuild\certs"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$work = [IO.Path]::GetFullPath($WorkDir)
$shipper = [IO.Path]::GetFullPath($ShipperExe)
$installer = [IO.Path]::GetFullPath($LocalInstallerExe)
$certDir = [IO.Path]::GetFullPath($CertDir)

if (-not (Test-Path $shipper)) {
    throw "Cannot find HostEyeShipper.exe: $shipper"
}
if (-not (Test-Path $installer)) {
    throw "Cannot find local installer exe: $installer"
}

$clientCert = Join-Path $certDir "client.crt"
$clientKey = Join-Path $certDir "client.key"
$caCert = Join-Path $certDir "company_ca.crt"
foreach ($path in @($clientCert, $clientKey, $caCert)) {
    if (-not (Test-Path $path)) {
        throw "Missing certificate file: $path"
    }
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $work | Out-Null

$runId = "recovery-local-" + (Get-Date -Format "yyyyMMdd-HHmmss")
$vms = @("REC-VM-01", "REC-VM-02", "REC-VM-03")
$startedAt = Get-Date

function New-RecoveryEventLine {
    param(
        [string]$Computer,
        [string]$AgentId,
        [int]$Index,
        [string]$RunId
    )

    $timestamp = (Get-Date).ToUniversalTime().AddMilliseconds($Index * 10).ToString("o")
    $event = [ordered]@{
        agent_id = $AgentId
        host_id = "host-$AgentId"
        os = "windows"
        source_platform = "hosteye_recovery_local_sim"
        computer = $Computer
        host = $Computer
        channel = "Microsoft-Windows-Sysmon/Operational"
        event_id = 1
        record_id = $Index
        provider_name = "Microsoft-Windows-Sysmon"
        level = "Information"
        level_value = 4
        message = "Recovery local simulation event $Index from $Computer run=$RunId"
        process_id = 5200 + $Index
        process_path = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        command_line = "powershell.exe -NoProfile -Command Write-Host $Computer-recovery-$Index"
        user_name = "$Computer\simuser"
        timestamp = $timestamp
        idempotency_key = "$RunId-$Computer-$Index"
        raw_log = "{}"
    }
    return ($event | ConvertTo-Json -Compress -Depth 6)
}

$vmState = foreach ($vm in $vms) {
    $agentId = "sim-agent-$($vm.ToLowerInvariant())-$runId"
    $vmDir = Join-Path $work $vm
    $spool = Join-Path $vmDir "spool"
    $state = Join-Path $vmDir "state"
    $logs = Join-Path $vmDir "logs"
    New-Item -ItemType Directory -Force -Path $spool, $state, $logs | Out-Null

    $eventFile = Join-Path $spool "events-$runId.ndjson"
    1..$EventsPerVm |
        ForEach-Object { New-RecoveryEventLine -Computer $vm -AgentId $agentId -Index $_ -RunId $runId } |
        Set-Content -LiteralPath $eventFile -Encoding UTF8

    $config = [ordered]@{
        GatewayUri = $GatewayUri
        SpoolDirectory = $spool
        StateDirectory = $state
        LogDirectory = $logs
        ClientCertificateFile = $clientCert
        ClientKeyFile = $clientKey
        CaCertificateFile = $caCert
        MaxEvents = $BatchEvents
        MaxBytes = 524288
        NormalJitterWindowSeconds = $NormalJitterSeconds
        RecoveryJitterWindowSeconds = $RecoveryJitterSeconds
        BaseBackoffSeconds = 2
        MaxBackoffSeconds = 30
        MaxSpoolSizeMB = 64
        LowWatermarkPercent = 80
        SpoolCheckIntervalSeconds = 10
        PreferDeletingSentFirst = $true
        SentRetentionDays = 1
        RunOnce = $true
    }
    $configPath = Join-Path $vmDir "shipper-config.json"
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8

    [pscustomobject]@{
        Vm = $vm
        AgentId = $agentId
        Dir = $vmDir
        Config = $configPath
    }
}

$cycleRows = New-Object System.Collections.Generic.List[object]
foreach ($cycle in 1..$Cycles) {
    $cycleStart = Get-Date
    $processes = foreach ($item in $vmState) {
        $stdout = Join-Path $item.Dir "stdout-cycle-$cycle.txt"
        $stderr = Join-Path $item.Dir "stderr-cycle-$cycle.txt"
        $cmd = "set HOSTEYE_AGENT_ID=$($item.AgentId)&& set HOSTEYE_HOST_ID=host-$($item.AgentId)&& set HOSTEYE_COMPUTER_NAME=$($item.Vm)&& `"$shipper`" `"$($item.Config)`""
        [pscustomobject]@{
            Vm = $item.Vm
            AgentId = $item.AgentId
            Process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        }
    }

    foreach ($proc in $processes) {
        $null = $proc.Process.WaitForExit(90000)
        $proc.Process.Refresh()
    }

    $cycleEnd = Get-Date
    foreach ($item in $vmState) {
        $shipperLog = Join-Path $item.Dir "logs\shipper.log"
        $lines = if (Test-Path $shipperLog) { Get-Content $shipperLog } else { @() }
        $cycleSending = $lines | Where-Object { $_ -match "Sending file=" } | Select-Object -Last 1
        $cycleOk = $lines | Where-Object { $_ -match "Sent OK" } | Select-Object -Last 1
        $cycleJitter = $lines | Where-Object { $_ -match "Applying deterministic send jitter" } | Select-Object -Last 1
        $cycleRows.Add([pscustomobject]@{
            Cycle = $cycle
            Vm = $item.Vm
            AgentId = $item.AgentId
            Started = $cycleStart.ToString("o")
            Ended = $cycleEnd.ToString("o")
            Jitter = $cycleJitter
            Sending = $cycleSending
            SentOk = $cycleOk
        })
    }

    Start-Sleep -Seconds 1
}

$endedAt = Get-Date
$report = Join-Path $work "summary.txt"
"run_id=$runId" | Tee-Object -FilePath $report
"mode=recovery_local_repeated_boots" | Tee-Object -FilePath $report -Append
"gateway=$GatewayUri" | Tee-Object -FilePath $report -Append
"local_installer=$installer" | Tee-Object -FilePath $report -Append
"shipper_exe=$shipper" | Tee-Object -FilePath $report -Append
"started=$($startedAt.ToString('o'))" | Tee-Object -FilePath $report -Append
"ended=$($endedAt.ToString('o'))" | Tee-Object -FilePath $report -Append
"events_per_vm=$EventsPerVm" | Tee-Object -FilePath $report -Append
"batch_events=$BatchEvents" | Tee-Object -FilePath $report -Append
"cycles=$Cycles" | Tee-Object -FilePath $report -Append
"normal_jitter_seconds=$NormalJitterSeconds" | Tee-Object -FilePath $report -Append
"recovery_jitter_seconds=$RecoveryJitterSeconds" | Tee-Object -FilePath $report -Append
"" | Tee-Object -FilePath $report -Append
$cycleRows | Format-Table Cycle,Vm,Jitter,Sending,SentOk -Wrap | Out-String | Tee-Object -FilePath $report -Append

if (Get-Command docker -ErrorAction SilentlyContinue) {
    "" | Tee-Object -FilePath $report -Append
    "ClickHouse rows for run:" | Tee-Object -FilePath $report -Append
    $query = "SELECT computer, count() AS events, min(kafka_timestamp) AS first_seen, max(kafka_timestamp) AS last_seen FROM default.windows_system_logs WHERE agent_id LIKE 'sim-agent-%-$runId' GROUP BY computer ORDER BY computer"
    docker exec local-clickhouse clickhouse-client --query $query | Tee-Object -FilePath $report -Append
}

"report=$report" | Tee-Object -FilePath $report -Append
