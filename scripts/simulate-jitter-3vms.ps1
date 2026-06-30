param(
    [int]$EventsPerVm = 20,
    [int]$JitterSeconds = 30,
    [string]$GatewayUri = "https://soc-gateway.yourcorporate.com/api/v1/telemetry",
    [string]$WorkDir = "$PSScriptRoot\..\sim-jitter",
    [string]$ShipperExe = "$PSScriptRoot\..\VectorBuild\SOCShipper\publish\HostEyeShipper.exe",
    [string]$CertDir = "$PSScriptRoot\..\VectorBuild\certs"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$work = [IO.Path]::GetFullPath((Join-Path $root "sim-jitter"))
if ($WorkDir) {
    $work = [IO.Path]::GetFullPath($WorkDir)
}

if (-not (Test-Path $ShipperExe)) {
    throw "Cannot find HostEyeShipper.exe: $ShipperExe"
}

$certDir = [IO.Path]::GetFullPath($CertDir)
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

$runId = "jitter-" + (Get-Date -Format "yyyyMMdd-HHmmss")
$vms = @("SIM-VM-01", "SIM-VM-02", "SIM-VM-03")
$startedAt = Get-Date

function New-EventLine {
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
        source_platform = "hosteye_jitter_sim"
        computer = $Computer
        host = $Computer
        channel = "Microsoft-Windows-Sysmon/Operational"
        event_id = 1
        record_id = $Index
        provider_name = "Microsoft-Windows-Sysmon"
        level = "Information"
        level_value = 4
        message = "Jitter simulation event $Index from $Computer run=$RunId"
        process_id = 4200 + $Index
        process_path = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        command_line = "powershell.exe -NoProfile -Command Write-Host $Computer-$Index"
        user_name = "$Computer\simuser"
        timestamp = $timestamp
        idempotency_key = "$RunId-$Computer-$Index"
        raw_log = "{}"
    }
    return ($event | ConvertTo-Json -Compress -Depth 6)
}

$processes = foreach ($vm in $vms) {
    $agentId = "sim-agent-$($vm.ToLowerInvariant())-$runId"
    $vmDir = Join-Path $work $vm
    $spool = Join-Path $vmDir "spool"
    $state = Join-Path $vmDir "state"
    $logs = Join-Path $vmDir "logs"
    New-Item -ItemType Directory -Force -Path $spool, $state, $logs | Out-Null

    $eventFile = Join-Path $spool "events-$runId.ndjson"
    1..$EventsPerVm |
        ForEach-Object { New-EventLine -Computer $vm -AgentId $agentId -Index $_ -RunId $runId } |
        Set-Content -LiteralPath $eventFile -Encoding UTF8

    $config = [ordered]@{
        GatewayUri = $GatewayUri
        SpoolDirectory = $spool
        StateDirectory = $state
        LogDirectory = $logs
        ClientCertificateFile = $clientCert
        ClientKeyFile = $clientKey
        CaCertificateFile = $caCert
        MaxEvents = 500
        MaxBytes = 524288
        NormalJitterWindowSeconds = $JitterSeconds
        RecoveryJitterWindowSeconds = $JitterSeconds
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

    $stdout = Join-Path $vmDir "stdout.txt"
    $stderr = Join-Path $vmDir "stderr.txt"
    $cmd = "set HOSTEYE_AGENT_ID=$agentId&& `"$ShipperExe`" `"$configPath`""
    [pscustomobject]@{
        Vm = $vm
        AgentId = $agentId
        Dir = $vmDir
        Process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    }
}

$processes | ForEach-Object { $_.Process.WaitForExit(90000) | Out-Null }
$endedAt = Get-Date

$summary = foreach ($item in $processes) {
    $shipperLog = Join-Path $item.Dir "logs\shipper.log"
    $lines = if (Test-Path $shipperLog) { Get-Content $shipperLog } else { @() }
    $jitterLine = $lines | Where-Object { $_ -match "Applying deterministic send jitter" } | Select-Object -First 1
    $sendLine = $lines | Where-Object { $_ -match "Sending file=" } | Select-Object -First 1
    $okLine = $lines | Where-Object { $_ -match "Sent OK" } | Select-Object -First 1
    [pscustomobject]@{
        Vm = $item.Vm
        AgentId = $item.AgentId
        ExitCode = $item.Process.ExitCode
        Jitter = $jitterLine
        Sending = $sendLine
        SentOk = $okLine
    }
}

$report = Join-Path $work "summary.txt"
"run_id=$runId" | Tee-Object -FilePath $report
"started=$($startedAt.ToString('o'))" | Tee-Object -FilePath $report -Append
"ended=$($endedAt.ToString('o'))" | Tee-Object -FilePath $report -Append
"jitter_window_seconds=$JitterSeconds" | Tee-Object -FilePath $report -Append
"" | Tee-Object -FilePath $report -Append
$summary | Format-List | Out-String | Tee-Object -FilePath $report -Append

if (Get-Command docker -ErrorAction SilentlyContinue) {
    "" | Tee-Object -FilePath $report -Append
    "ClickHouse rows for run:" | Tee-Object -FilePath $report -Append
    $query = "SELECT computer, count() AS events, min(kafka_timestamp) AS first_seen, max(kafka_timestamp) AS last_seen FROM default.windows_system_logs WHERE agent_id LIKE 'sim-agent-%-$runId' GROUP BY computer ORDER BY computer"
    docker exec local-clickhouse clickhouse-client --query $query | Tee-Object -FilePath $report -Append
}

"report=$report" | Tee-Object -FilePath $report -Append
