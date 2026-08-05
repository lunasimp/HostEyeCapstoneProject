param(
    [string]$Endpoint = "http://127.0.0.1:8687/",
    [string]$SpoolDirectory = "C:\ProgramData\HostEye\spool"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot ".runtime\local-spool-mirror"
$pidFile = Join-Path $runtimeDir "mirror.pid"
$stdout = Join-Path $runtimeDir "mirror.log"
$stderr = Join-Path $runtimeDir "mirror.err.log"
$script = Join-Path $PSScriptRoot "mirror-hosteye-spool-local.js"
$vectorContainer = "hosteye-local-mirror-vector"
$vectorConfig = Join-Path $repoRoot "Vector-HA-Cluster\vector-gateway.toml"
$vectorVault = Join-Path $repoRoot ".runtime\local-vector-vault"

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
New-Item -ItemType Directory -Path $vectorVault -Force | Out-Null

if (Test-Path $pidFile) {
    $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
        Write-Host "HostEye local spool mirror is already running (PID $existingPid)."
        exit 0
    }
}

$containerExists = docker ps -a --format "{{.Names}}" | Where-Object { $_ -eq $vectorContainer }
if (-not $containerExists) {
    docker run -d --name $vectorContainer --restart unless-stopped --network vector-ha-cluster_soc-network -p "127.0.0.1:8687:8686" -v "${vectorConfig}:/etc/vector/vector.toml:ro" -v "${vectorVault}:/var/log/soc_vault" timberio/vector:0.35.0-alpine --config /etc/vector/vector.toml | Out-Null
} elseif ((docker inspect $vectorContainer --format "{{.State.Running}}") -ne "true") {
    docker start $vectorContainer | Out-Null
}

$gatewayReady = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect("127.0.0.1", 8687, $null, $null)
        if ($connect.AsyncWaitHandle.WaitOne(500)) {
            $client.EndConnect($connect)
            $gatewayReady = $true
            break
        }
    } catch {} finally { $client.Dispose() }
    Start-Sleep -Milliseconds 250
}
if (-not $gatewayReady) { throw "HostEye local Vector gateway did not become ready on port 8687." }

$nodeExe = (Get-Command node -ErrorAction Stop).Source
$command = 'start "" /b "{0}" "{1}" "--endpoint={2}" "--spool={3}" "--state={4}" "--pid-file={5}" 1>"{6}" 2>"{7}"' -f $nodeExe, $script, $Endpoint, $SpoolDirectory, $runtimeDir, $pidFile, $stdout, $stderr
& $env:ComSpec /d /c $command
Start-Sleep -Milliseconds 800
if (-not (Test-Path $pidFile)) { throw "HostEye local spool mirror did not create its PID file." }
$mirrorPid = [int](Get-Content -LiteralPath $pidFile -Raw)
Write-Host "HostEye local spool mirror started (PID $mirrorPid)."
Write-Host "Local endpoint: $Endpoint"
Write-Host "Log: $stdout"
