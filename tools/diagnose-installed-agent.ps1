param(
    [string]$RepoRoot = "D:\f-smooth-criminal-lab-team"
)

$ErrorActionPreference = "Continue"
$LogPath = Join-Path $RepoRoot "tools\diagnose-installed-agent.log"
Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8

function Log([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "$ts $Message" -Encoding UTF8
}

Log "Diagnosing HostEye install."
Log "Program files:"
Get-ChildItem "C:\Program Files\HostEye" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Log "  $($_.Name) $($_.Length)"
}
Log "Shipper files:"
Get-ChildItem "C:\Program Files\HostEye\HostEyeShipper" -Force -ErrorAction SilentlyContinue | ForEach-Object {
    Log "  $($_.Name) $($_.Length)"
}
Log "Services:"
Get-Service -Name HostEyeAgent,Vector,SOCShipper -ErrorAction SilentlyContinue | ForEach-Object {
    Log "  $($_.Name) Status=$($_.Status) StartType=$($_.StartType)"
}
Log "Tasks:"
foreach ($taskName in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Log "  ${taskName} State=$($task.State)" } else { Log "  ${taskName} not found" }
}
if (Test-Path "C:\Program Files\HostEye\vector.exe") {
    Log "Vector version:"
    try {
        $version = & "C:\Program Files\HostEye\vector.exe" --version 2>&1
        $version | ForEach-Object { Log "  $_" }
    } catch {
        Log "  vector --version failed: $($_.Exception.Message)"
    }
    Log "Vector service help:"
    try {
        $help = & "C:\Program Files\HostEye\vector.exe" service --help 2>&1
        $help | Select-Object -First 30 | ForEach-Object { Log "  $_" }
        Log "  exit=$LASTEXITCODE"
    } catch {
        Log "  vector service --help failed: $($_.Exception.Message)"
    }
}
