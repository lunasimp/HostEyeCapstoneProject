[CmdletBinding()]
param(
    [switch]$KeepStartupEnabled
)

$ErrorActionPreference = 'Continue'

$ProgramDataRoot = Join-Path $env:ProgramData 'HostEye'
$LogDir = Join-Path $ProgramDataRoot 'logs'
$LogPath = Join-Path $LogDir 'demo-control.log'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-DemoLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') $Message"
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    Write-DemoLog 'ERROR Run this script from an elevated PowerShell session.'
    exit 1
}

Write-DemoLog 'Pausing HostEye demo collection and shipping.'

$taskNames = @(
    'HostEye_Shipper_Startup',
    'HostEye_Agent_Startup',
    'HostEye_Agent_Updater',
    'SOC_Shipper_Startup',
    'SOC_Vector_Startup',
    'SOC_Agent_Updater'
)

foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        continue
    }

    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $KeepStartupEnabled) {
        Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        Write-DemoLog "Disabled scheduled task: $taskName"
    } else {
        Write-DemoLog "Stopped scheduled task: $taskName"
    }
}

$serviceNames = @('HostEyeAgent', 'Vector', 'HostEyeShipper', 'SOCShipper')
foreach ($serviceName in $serviceNames) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        continue
    }

    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    if (-not $KeepStartupEnabled -and $serviceName -in @('HostEyeAgent', 'Vector')) {
        Set-Service -Name $serviceName -StartupType Manual -ErrorAction SilentlyContinue
        Write-DemoLog "Stopped service and set Manual startup: $serviceName"
    } else {
        Write-DemoLog "Stopped service: $serviceName"
    }
}

$processNames = @('HostEyeShipper', 'SOCShipper', 'vector')
foreach ($processName in $processNames) {
    $processes = Get-Process -Name $processName -ErrorAction SilentlyContinue
    if ($null -eq $processes) {
        continue
    }

    $processes | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-DemoLog "Stopped process: $processName"
}

$spoolDir = Join-Path $ProgramDataRoot 'spool'
if (Test-Path $spoolDir) {
    $spoolBytes = (Get-ChildItem -Path $spoolDir -File -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $spoolBytes) {
        $spoolBytes = 0
    }
    Write-DemoLog ("Current spool size: {0:N0} bytes" -f $spoolBytes)
}

Write-DemoLog 'HostEye demo collection is paused. Use Resume-HostEyeDemoCollection.ps1 to start again.'
