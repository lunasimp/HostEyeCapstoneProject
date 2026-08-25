$ErrorActionPreference = 'Stop'

$runtime = Join-Path $PSScriptRoot 'runtime\local-mirror'
$shipperExe = Join-Path $PSScriptRoot 'target\release\hosteye-shipper.exe'
$shipperConfig = Join-Path $PSScriptRoot 'shipper-config.local.json'
$watcherScript = Join-Path $PSScriptRoot 'run-local-mirror-watcher.ps1'
$supervisorLog = Join-Path $runtime 'service-supervisor.log'

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'spool') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'state') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'logs') | Out-Null

function Write-SupervisorLog([string]$message) {
    Add-Content -LiteralPath $supervisorLog -Value "$(Get-Date -Format o) $message"
}

function Start-Watcher {
    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watcherScript) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'watcher.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'watcher.stderr.log') `
        -PassThru
    Set-Content -LiteralPath (Join-Path $runtime 'watcher.pid') -Value $process.Id
    Write-SupervisorLog "watcher_started pid=$($process.Id)"
    return $process
}

function Start-MirrorShipper {
    $process = Start-Process -FilePath $shipperExe `
        -ArgumentList @($shipperConfig) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'stderr.log') `
        -PassThru
    Set-Content -LiteralPath (Join-Path $runtime 'mirror.pid') -Value $process.Id
    Write-SupervisorLog "mirror_started pid=$($process.Id)"
    return $process
}

$watcher = $null
$mirror = $null

try {
    Write-SupervisorLog "service_supervisor_started user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    $watcher = Start-Watcher
    $mirror = Start-MirrorShipper

    while ($true) {
        Start-Sleep -Seconds 5

        if ($watcher.HasExited) {
            Write-SupervisorLog "watcher_exited code=$($watcher.ExitCode); restarting"
            $watcher = Start-Watcher
        }

        if ($mirror.HasExited) {
            Write-SupervisorLog "mirror_exited code=$($mirror.ExitCode); restarting"
            $mirror = Start-MirrorShipper
        }
    }
} finally {
    foreach ($process in @($mirror, $watcher)) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-SupervisorLog 'service_supervisor_stopped'
}
