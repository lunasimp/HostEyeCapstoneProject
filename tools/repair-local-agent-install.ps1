param(
    [string]$RepoRoot = "D:\f-smooth-criminal-lab-team"
)

$ErrorActionPreference = "Continue"
$LogPath = Join-Path $RepoRoot "tools\repair-local-agent-install.log"
$InstallerPath = Join-Path $RepoRoot "VectorBuild\Output\HostEye_Endpoint_Installer.exe"
$InstallerLogPath = Join-Path $RepoRoot "tools\hosteye-installer-repair.log"

function Write-RepairLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "$ts $Message" -Encoding UTF8
}

Set-Content -LiteralPath $LogPath -Value "" -Encoding UTF8
Write-RepairLog "Starting HostEye repair install."

foreach ($taskName in @("HostEye_Shipper_Startup", "HostEye_Agent_Startup", "HostEye_Agent_Updater", "SOC_Shipper_Startup", "SOC_Vector_Startup", "SOC_Agent_Updater")) {
    try {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Write-RepairLog "Stopped task if present: $taskName"
    } catch {
        Write-RepairLog "Task stop skipped for ${taskName}: $($_.Exception.Message)"
    }
}

foreach ($serviceName in @("HostEyeAgent", "HostEyeShipper", "Vector", "SOCShipper")) {
    try {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        Write-RepairLog "Stopped service if present: $serviceName"
    } catch {
        Write-RepairLog "Service stop skipped for ${serviceName}: $($_.Exception.Message)"
    }
}

Start-Sleep -Seconds 3

Get-Process -Name vector,HostEyeShipper,SOCShipper -ErrorAction SilentlyContinue | ForEach-Object {
    Write-RepairLog "Killing process $($_.ProcessName) PID=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

Get-CimInstance Win32_Process -Filter "name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'HostEye|SOC_Updater|install\.ps1'
} | ForEach-Object {
    if ($_.ProcessId -ne $PID) {
        Write-RepairLog "Killing HostEye-related powershell PID=$($_.ProcessId) CommandLine=$($_.CommandLine)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 2

$args = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/CLOSEAPPLICATIONS",
    "/FORCECLOSEAPPLICATIONS",
    "/LOG=`"$InstallerLogPath`""
)
Write-RepairLog "Running installer repair: $InstallerPath"
$proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
Write-RepairLog "Installer repair exit code: $($proc.ExitCode)"

Start-Sleep -Seconds 5
Get-Service -Name HostEyeAgent -ErrorAction SilentlyContinue | ForEach-Object {
    Write-RepairLog "Service $($_.Name): Status=$($_.Status) StartType=$($_.StartType)"
}
foreach ($taskName in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-RepairLog "Task ${taskName}: State=$($task.State)"
    } else {
        Write-RepairLog "Task ${taskName}: not found"
    }
}
Write-RepairLog "Repair install completed."
