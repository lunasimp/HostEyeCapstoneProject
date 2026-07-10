[CmdletBinding()]
param()

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

Write-DemoLog 'Resuming HostEye demo collection and shipping.'

foreach ($serviceName in @('HostEyeAgent', 'Vector')) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        continue
    }

    Set-Service -Name $serviceName -StartupType Automatic -ErrorAction SilentlyContinue
    Start-Service -Name $serviceName -ErrorAction SilentlyContinue
    Write-DemoLog "Enabled and started service: $serviceName"
}

foreach ($taskName in @('HostEye_Agent_Startup', 'HostEye_Shipper_Startup', 'HostEye_Agent_Updater')) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        continue
    }

    Enable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    if ($taskName -eq 'HostEye_Shipper_Startup') {
        Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    Write-DemoLog "Enabled scheduled task: $taskName"
}

Write-DemoLog 'HostEye demo collection is resumed.'
