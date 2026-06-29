param(
    [string]$RepoRoot = "D:\f-smooth-criminal-lab-team"
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $RepoRoot "tools\fix-installed-agent.log"
$InstallDir = "C:\Program Files\HostEye"
$ShipperDir = Join-Path $InstallDir "HostEyeShipper"
$CertDir = Join-Path $InstallDir "certs"
$SysmonDir = Join-Path $InstallDir "Sysmon"

function Write-FixLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "$ts $Message" -Encoding UTF8
}

Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8
Write-FixLog "Starting installed HostEye repair."

try {
    foreach ($taskName in @("HostEye_Shipper_Startup", "HostEye_Agent_Startup", "HostEye_Agent_Updater", "SOC_Shipper_Startup", "SOC_Vector_Startup", "SOC_Agent_Updater")) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Write-FixLog "Stopped task if present: $taskName"
    }

    foreach ($serviceName in @("HostEyeAgent", "Vector", "SOCShipper", "HostEyeShipper")) {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        Write-FixLog "Stopped service if present: $serviceName"
    }

    Start-Sleep -Seconds 3
    Get-Process -Name vector,HostEyeShipper,SOCShipper -ErrorAction SilentlyContinue | ForEach-Object {
        Write-FixLog "Killing process $($_.ProcessName) PID=$($_.Id)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    New-Item -ItemType Directory -Force -Path $InstallDir, $ShipperDir, $CertDir, $SysmonDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\vector.exe") -Destination (Join-Path $InstallDir "vector.exe") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\vector.toml") -Destination (Join-Path $InstallDir "vector.toml") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\vector.toml.sig") -Destination (Join-Path $InstallDir "vector.toml.sig") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\SOC_Updater.ps1") -Destination (Join-Path $InstallDir "HostEye_Updater.ps1") -Force
    Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\install.ps1") -Destination (Join-Path $InstallDir "install.ps1") -Force
    Copy-Item -Path (Join-Path $RepoRoot "VectorBuild\SOCShipper\publish\*") -Destination $ShipperDir -Force
    Copy-Item -Path (Join-Path $RepoRoot "VectorBuild\certs\*") -Destination $CertDir -Force
    Copy-Item -Path (Join-Path $RepoRoot "VectorBuild\Sysmon\*") -Destination $SysmonDir -Force -Recurse
    Write-FixLog "Copied current agent files to $InstallDir"

    Write-FixLog "Running installed install.ps1"
    & (Join-Path $InstallDir "install.ps1")
    Write-FixLog "install.ps1 completed with LASTEXITCODE=$LASTEXITCODE"

    Start-Sleep -Seconds 5
    $svc = Get-Service -Name HostEyeAgent -ErrorAction SilentlyContinue
    if ($svc) {
        Write-FixLog "Service HostEyeAgent: Status=$($svc.Status) StartType=$($svc.StartType)"
    } else {
        Write-FixLog "Service HostEyeAgent not found"
    }

    foreach ($taskName in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater")) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Write-FixLog "Task ${taskName}: State=$($task.State)"
        } else {
            Write-FixLog "Task ${taskName}: not found"
        }
    }

    if (Test-Path "C:\ProgramData\HostEye\logs\shipper.log") {
        Write-FixLog "shipper.log tail:"
        Get-Content "C:\ProgramData\HostEye\logs\shipper.log" -Tail 20 | ForEach-Object {
            Write-FixLog "  $_"
        }
    }
} catch {
    Write-FixLog "ERROR: $($_.Exception.Message)"
    Write-FixLog "ERROR_AT: $($_.InvocationInfo.PositionMessage)"
    throw
}

Write-FixLog "Installed HostEye repair completed."
