param(
    [string]$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path,
    [string]$GatewayHostName = "hosteye.iahn.hanoi.vn",
    [string]$GatewayIp = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$LogPath = Join-Path $RepoRoot "tools\install-local-agent.log"
$InstallerPath = Join-Path $RepoRoot "VectorBuild\Output\HostEye_Endpoint_Installer.exe"
$InstallerLogPath = Join-Path $RepoRoot "tools\hosteye-installer.log"
$HostsPath = "C:\Windows\System32\drivers\etc\hosts"

function Write-AgentInstallLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $LogPath -Value "$ts $Message" -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null
Write-AgentInstallLog "Starting local HostEye agent install."

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run as Administrator."
}

if (-not (Test-Path -LiteralPath $InstallerPath)) {
    throw "Installer not found: $InstallerPath"
}

$backupPath = "$HostsPath.hosteye.bak"
Copy-Item -LiteralPath $HostsPath -Destination $backupPath -Force
Write-AgentInstallLog "Backed up hosts file to $backupPath"

$lines = Get-Content -LiteralPath $HostsPath
$escapedGateway = [regex]::Escape($GatewayHostName)
$filtered = $lines | Where-Object { $_ -notmatch "(^|\s)$escapedGateway(\s|$)" }
$filtered + "$GatewayIp $GatewayHostName" | Set-Content -LiteralPath $HostsPath -Encoding ASCII
Write-AgentInstallLog "Mapped $GatewayHostName to $GatewayIp"

$args = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=`"$InstallerLogPath`""
)
Write-AgentInstallLog "Running installer: $InstallerPath"
$proc = Start-Process -FilePath $InstallerPath -ArgumentList $args -Wait -PassThru
Write-AgentInstallLog "Installer exit code: $($proc.ExitCode)"
if ($proc.ExitCode -ne 0) {
    throw "Installer failed with exit code $($proc.ExitCode). See $InstallerLogPath"
}

Start-Sleep -Seconds 5
foreach ($serviceName in @("HostEyeAgent")) {
    $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($svc) {
        Write-AgentInstallLog "Service $serviceName status: $($svc.Status)"
    } else {
        Write-AgentInstallLog "Service $serviceName not found."
    }
}

foreach ($taskName in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-AgentInstallLog "Scheduled task $taskName state: $($task.State)"
    } else {
        Write-AgentInstallLog "Scheduled task $taskName not found."
    }
}

Write-AgentInstallLog "Local HostEye agent install script completed."
