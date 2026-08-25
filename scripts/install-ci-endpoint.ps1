param(
    [string]$InstallerPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "HostEyeAgent\Output\HostEye_Endpoint_Installer_Ci_Local_Fixed_20260815.exe"),
    [string]$EnrollmentToken = "",
    [string]$SetupLog = "C:\ProgramData\HostEye\logs\inno-ci-install.log"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an Administrator PowerShell window."
}
if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "HostEye installer was not found: $InstallerPath"
}
if ([string]::IsNullOrWhiteSpace($EnrollmentToken)) {
    $EnrollmentToken = Read-Host "Paste the new one-time enrollment token"
}
if ($EnrollmentToken -notmatch '^he_enroll_[A-Za-z0-9_-]{20,}$') {
    throw "The supplied value is not a valid HostEye enrollment token."
}

$arguments = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/LOG=$SetupLog",
    "/ENROLLMENTTOKEN=$EnrollmentToken"
)
$process = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -Wait -PassThru

$completionMarker = "C:\ProgramData\HostEye\install-complete.json"
$identityState = "C:\ProgramData\HostEye\identity\enrollment.json"
if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $completionMarker) -or -not (Test-Path -LiteralPath $identityState)) {
    $installTail = if (Test-Path -LiteralPath "C:\ProgramData\HostEye\logs\install.log") {
        (Get-Content -LiteralPath "C:\ProgramData\HostEye\logs\install.log" -Tail 25) -join [Environment]::NewLine
    } else { "HostEye install.log does not exist." }
    throw "HostEye enrollment installation failed. Inno exit code=$($process.ExitCode).`n$installTail"
}

$completion = Get-Content -LiteralPath $completionMarker -Raw | ConvertFrom-Json
$identity = Get-Content -LiteralPath $identityState -Raw | ConvertFrom-Json
$services = Get-Service HostEyeAgent, HostEyeShipper
if ($services.Where({ $_.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running }).Count -gt 0) {
    throw "Enrollment completed but one or more HostEye services are not running."
}

[pscustomobject]@{
    Result = "PASS"
    CiId = $identity.ciId
    AgentId = $identity.agentId
    HostId = $identity.hostId
    CertificateThumbprint = $identity.certificateThumbprint
    AgentService = ($services | Where-Object Name -eq "HostEyeAgent").Status
    ShipperService = ($services | Where-Object Name -eq "HostEyeShipper").Status
    CompletedAt = $completion.completedAt
    SetupLog = $SetupLog
}
