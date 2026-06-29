param(
    [string]$RepoRoot = "D:\f-smooth-criminal-lab-team"
)

$ErrorActionPreference = "Continue"
$LogPath = Join-Path $RepoRoot "tools\check-local-agent.log"

function Write-CheckLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "$ts $Message" -Encoding UTF8
}

Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8
Write-CheckLog "Checking HostEye local agent."

Get-Service -Name HostEyeAgent -ErrorAction SilentlyContinue | ForEach-Object {
    Write-CheckLog "Service $($_.Name): Status=$($_.Status) StartType=$($_.StartType)"
}

foreach ($taskName in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-CheckLog "Task ${taskName}: State=$($task.State)"
    } else {
        Write-CheckLog "Task ${taskName}: not found"
    }
}

Write-CheckLog "HostEyeShipper files:"
Get-ChildItem "C:\Program Files\HostEye\HostEyeShipper" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Write-CheckLog "  $($_.Name) $($_.Length)"
}

Write-CheckLog "Logs:"
Get-ChildItem "C:\ProgramData\HostEye\logs" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Write-CheckLog "  $($_.Name) $($_.Length) $($_.LastWriteTime)"
}

Write-CheckLog "Spool:"
Get-ChildItem "C:\ProgramData\HostEye\spool" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Write-CheckLog "  $($_.Name) $($_.Length) $($_.LastWriteTime)"
}

if (Test-Path "C:\ProgramData\HostEye\logs\shipper.log") {
    Write-CheckLog "shipper.log tail:"
    Get-Content "C:\ProgramData\HostEye\logs\shipper.log" -Tail 30 | ForEach-Object {
        Write-CheckLog "  $_"
    }
}
