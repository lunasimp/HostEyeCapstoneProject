# SOC Vector Agent installer
# Requires Administrator. Installs Vector as LocalSystem service, config updater, certs, and Sysmon.

$ErrorActionPreference = "Stop"
$StagingDir = $PSScriptRoot
$ServiceName = "Vector"
$ShipperServiceName = "SOCShipper"
$TargetDir = "C:\Program Files\Vector"
$CertDir = Join-Path $TargetDir "certs"
$SysmonDir = Join-Path $TargetDir "Sysmon"
$ShipperDir = Join-Path $TargetDir "SOCShipper"
$ProgramDataDir = "C:\ProgramData\Vector"
$LogDir = Join-Path $ProgramDataDir "logs"
$InstallLog = Join-Path $LogDir "install.log"

function Write-InstallLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Add-Content -Path $InstallLog -Value "$ts $Message"
    Write-Host $Message
}

function Copy-IfDifferent([string]$Source, [string]$Destination) {
    if (-not (Test-Path $Source)) { return }
    $srcFull = [System.IO.Path]::GetFullPath($Source)
    $dstFull = [System.IO.Path]::GetFullPath($Destination)
    if ($srcFull -ieq $dstFull) { return }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Ensure-MachineEnv([string]$Name, [string]$Value) {
    $current = [Environment]::GetEnvironmentVariable($Name, "Machine")
    if ([string]::IsNullOrWhiteSpace($current)) {
        [Environment]::SetEnvironmentVariable($Name, $Value, "Machine")
        Write-InstallLog "Created machine environment variable $Name=$Value"
    } else {
        Write-InstallLog "Machine environment variable $Name already exists: $current"
    }
}

function Get-StableJitterSeconds([string]$Seed, [int]$WindowSeconds) {
    if ($WindowSeconds -le 0) { return 0 }
    if ([string]::IsNullOrWhiteSpace($Seed)) { $Seed = [guid]::NewGuid().ToString() }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Seed)
        $hash = $sha.ComputeHash($bytes)
        $value = [BitConverter]::ToUInt32($hash, 0)
        return [int]($value % [uint32]$WindowSeconds)
    } finally {
        $sha.Dispose()
    }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This installer must be run as Administrator."
    exit 1
}

Write-InstallLog "Starting SOC Vector Agent installation from $StagingDir"

New-Item -ItemType Directory -Force -Path $TargetDir, $CertDir, $SysmonDir, $ShipperDir, $ProgramDataDir, $LogDir, (Join-Path $ProgramDataDir "spool"), (Join-Path $ProgramDataDir "shipper_state") | Out-Null

# Stable endpoint identity for Vector metadata.
$machineGuid = $null
try { $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid } catch {}
if ([string]::IsNullOrWhiteSpace($machineGuid)) { $machineGuid = [guid]::NewGuid().ToString() }
Ensure-MachineEnv "VECTOR_AGENT_ID" "agent-$machineGuid"
Ensure-MachineEnv "VECTOR_HOST_ID" "host-$machineGuid"

# Copy core files. If running from the final install dir, these calls no-op safely.
Copy-IfDifferent (Join-Path $StagingDir "vector.exe") (Join-Path $TargetDir "vector.exe")
Copy-IfDifferent (Join-Path $StagingDir "vector.toml") (Join-Path $TargetDir "vector.toml")
Copy-IfDifferent (Join-Path $StagingDir "SOC_Updater.ps1") (Join-Path $TargetDir "SOC_Updater.ps1")
Set-Content -LiteralPath (Join-Path $TargetDir "agent.version") -Value "1.0.0" -Encoding ASCII
if (Test-Path (Join-Path $StagingDir "SOCShipper")) {
    Copy-Item -LiteralPath (Join-Path $StagingDir "SOCShipper\*") -Destination $ShipperDir -Force -Recurse
} else {
    Write-InstallLog "WARNING: SOCShipper directory was not found in staging dir."
}

if (Test-Path (Join-Path $StagingDir "certs")) {
    Copy-Item -LiteralPath (Join-Path $StagingDir "certs\*") -Destination $CertDir -Force
} else {
    Write-InstallLog "WARNING: certs directory was not found in staging dir."
}

if (Test-Path (Join-Path $StagingDir "Sysmon")) {
    Copy-Item -LiteralPath (Join-Path $StagingDir "Sysmon\*") -Destination $SysmonDir -Force -Recurse
} else {
    Write-InstallLog "WARNING: Sysmon directory was not found in staging dir."
}

# Trust internal CA for Vector TLS and PowerShell updater HTTPS downloads.
$caPath = Join-Path $CertDir "company_ca.crt"
if (Test-Path $caPath) {
    Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Write-InstallLog "Imported company CA into LocalMachine Root."
}

# Harden install directory. Only SYSTEM and Administrators can read private key/config.
$Acl = Get-Acl -Path $TargetDir
$Acl.SetAccessRuleProtection($true, $false)
$AdminRule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
$SystemRule = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
$Acl.ResetAccessRule($AdminRule)
$Acl.ResetAccessRule($SystemRule)
Set-Acl -Path $TargetDir $Acl
Write-InstallLog "Applied ACL hardening to $TargetDir"

# Install or update Sysmon if bundled.
$sysmonExe = Join-Path $SysmonDir "Sysmon64.exe"
$sysmonConfig = Join-Path $SysmonDir "soc-sysmon-config.xml"
$sysmonLog = Join-Path $LogDir "sysmon-install.log"
if ((Test-Path $sysmonExe) -and (Test-Path $sysmonConfig)) {
    $sysmonSvc = Get-Service -Name "Sysmon64" -ErrorAction SilentlyContinue
    if ($sysmonSvc) {
        Write-InstallLog "Sysmon64 already installed; updating configuration."
        $sysmonArgs = "-c `"$sysmonConfig`""
    } else {
        Write-InstallLog "Installing Sysmon64."
        $sysmonArgs = "-accepteula -i `"$sysmonConfig`""
    }

    $sysmonProc = Start-Process -FilePath $sysmonExe -ArgumentList $sysmonArgs -Wait -PassThru -NoNewWindow -RedirectStandardOutput $sysmonLog -RedirectStandardError (Join-Path $LogDir "sysmon-install.err.log")
    Write-InstallLog "Sysmon command exit code: $($sysmonProc.ExitCode)"
    if ($sysmonProc.ExitCode -ne 0) {
        Write-InstallLog "WARNING: Sysmon command returned non-zero exit code. Continuing Vector service installation. See $sysmonLog"
    }
} else {
    Write-InstallLog "WARNING: Sysmon64.exe or soc-sysmon-config.xml missing; Sysmon not installed."
}

# Recreate Vector service using Vector's native Windows service manager.
$vectorExe = Join-Path $TargetDir "vector.exe"
$configPath = Join-Path $TargetDir "vector.toml"
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-InstallLog "Stopping and uninstalling existing Vector service."
    try { & $vectorExe service stop --name $ServiceName | Out-Null } catch {}
    try { & $vectorExe service uninstall --name $ServiceName | Out-Null } catch {}
    Start-Sleep -Seconds 3
}

Write-InstallLog "Installing Vector service with config: $configPath"
& $vectorExe service install --name $ServiceName --display-name "SOC Vector Agent" --config-toml $configPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Vector service install failed with exit code $LASTEXITCODE" }

sc.exe description $ServiceName "SOC endpoint telemetry collector" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
sc.exe failureflag $ServiceName 1 | Out-Null
sc.exe config $ServiceName start= demand | Out-Null

# Register deterministic jittered startup task for fleet-scale boot storms.
$startupTaskName = "SOC_Vector_Startup"
$startupScript = Join-Path $TargetDir "SOC_StartVector.ps1"
$startupScriptLines = @(
    'param([int]$JitterWindowSeconds = 300)',
    '$ServiceName = "Vector"',
    '$LogDir = "C:\ProgramData\Vector\logs"',
    '$LogPath = Join-Path $LogDir "startup.log"',
    'function Write-StartupLog([string]$Message) {',
    '    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null',
    '    Add-Content -Path $LogPath -Value "$(Get-Date -Format ''yyyy-MM-dd HH:mm:ss'') $Message"',
    '}',
    'function Get-StableJitterSeconds([string]$Seed, [int]$WindowSeconds) {',
    '    if ($WindowSeconds -le 0) { return 0 }',
    '    if ([string]::IsNullOrWhiteSpace($Seed)) { $Seed = [guid]::NewGuid().ToString() }',
    '    $sha = [System.Security.Cryptography.SHA256]::Create()',
    '    try {',
    '        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Seed)',
    '        $hash = $sha.ComputeHash($bytes)',
    '        $value = [BitConverter]::ToUInt32($hash, 0)',
    '        return [int]($value % [uint32]$WindowSeconds)',
    '    } finally {',
    '        $sha.Dispose()',
    '    }',
    '}',
    'try {',
    '    $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid',
    '    $jitter = Get-StableJitterSeconds -Seed $machineGuid -WindowSeconds $JitterWindowSeconds',
    '    Write-StartupLog "Startup task applying stable jitter: $jitter seconds within $JitterWindowSeconds-second window."',
    '    if ($jitter -gt 0) { Start-Sleep -Seconds $jitter }',
    '    $svc = Get-Service -Name $ServiceName -ErrorAction Stop',
    '    if ($svc.Status -ne "Running") {',
    '        Start-Service -Name $ServiceName',
    '        Write-StartupLog "Vector service start requested."',
    '    } else {',
    '        Write-StartupLog "Vector service already running; no action needed."',
    '    }',
    '} catch {',
    '    Write-StartupLog "ERROR: $($_.Exception.Message)"',
    '    throw',
    '}'
)
Set-Content -LiteralPath $startupScript -Value $startupScriptLines -Encoding UTF8
Write-InstallLog "Registering $startupTaskName scheduled task for jittered Vector startup."
Unregister-ScheduledTask -TaskName $startupTaskName -Confirm:$false -ErrorAction SilentlyContinue
$startupAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startupScript`" -JitterWindowSeconds 300"
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$startupSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
Register-ScheduledTask -TaskName $startupTaskName -Action $startupAction -Trigger $startupTrigger -Principal $startupPrincipal -Settings $startupSettings -Force | Out-Null
Write-InstallLog "SOC_Vector_Startup scheduled task registered."

Write-InstallLog "Starting Vector service."
$startupJitterSeconds = Get-StableJitterSeconds -Seed $machineGuid -WindowSeconds 30
Write-InstallLog "Applying stable startup jitter before Vector service start: $startupJitterSeconds seconds."
if ($startupJitterSeconds -gt 0) { Start-Sleep -Seconds $startupJitterSeconds }
& $vectorExe service start --name $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Vector service start failed with exit code $LASTEXITCODE" }
Write-InstallLog "Vector service started."


# Configure and install SOC Shipper startup task. Vector writes local spool; Shipper sends batches with mTLS/backoff.
$shipperExe = Join-Path $ShipperDir "SOCShipper.exe"
$shipperConfig = Join-Path $ShipperDir "shipper-config.json"
$shipperConfigObject = [ordered]@{
    GatewayUri = "https://soc-gateway.yourcorporate.com/api/v1/telemetry"
    SpoolDirectory = (Join-Path $ProgramDataDir "spool")
    StateDirectory = (Join-Path $ProgramDataDir "shipper_state")
    LogDirectory = $LogDir
    ClientCertificateFile = (Join-Path $CertDir "client.crt")
    ClientKeyFile = (Join-Path $CertDir "client.key")
    CaCertificateFile = (Join-Path $CertDir "company_ca.crt")
    MaxEvents = 1000
    MaxBytes = 1048576
    NormalJitterWindowSeconds = 120
    RecoveryJitterWindowSeconds = 900
    BaseBackoffSeconds = 2
    MaxBackoffSeconds = 300
    MaxSpoolSizeMB = 8192
    LowWatermarkPercent = 85
    SpoolCheckIntervalSeconds = 30
    PreferDeletingSentFirst = $true
    SentRetentionDays = 2
    RunOnce = $false
}
$shipperConfigObject | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $shipperConfig -Encoding UTF8

if (Test-Path $shipperExe) {
    $existingShipper = Get-Service -Name $ShipperServiceName -ErrorAction SilentlyContinue
    if ($existingShipper) {
        Write-InstallLog "Deleting legacy SOC Shipper service."
        try { Stop-Service -Name $ShipperServiceName -Force -ErrorAction SilentlyContinue } catch {}
        sc.exe delete $ShipperServiceName | Out-Null
        Start-Sleep -Seconds 3
    }

    $shipperTaskName = "SOC_Shipper_Startup"
    $shipperTaskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$shipperExe' '$shipperConfig'`""
    Write-InstallLog "Registering $shipperTaskName scheduled task."
    Unregister-ScheduledTask -TaskName $shipperTaskName -Confirm:$false -ErrorAction SilentlyContinue
    $shipperAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument $shipperTaskArgs
    $shipperTrigger = New-ScheduledTaskTrigger -AtStartup
    $shipperPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    $shipperSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $shipperTaskName -Action $shipperAction -Trigger $shipperTrigger -Principal $shipperPrincipal -Settings $shipperSettings -Force | Out-Null
    Start-ScheduledTask -TaskName $shipperTaskName
    Write-InstallLog "SOC Shipper startup task registered and started."
} else {
    Write-InstallLog "WARNING: SOCShipper.exe missing; Shipper startup task not registered."
}
# Scheduled configuration updater.
$taskName = "SOC_Agent_Updater"
$taskScript = Join-Path $TargetDir "SOC_Updater.ps1"
$taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskScript`""
Write-InstallLog "Registering $taskName scheduled task."
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$taskAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument $taskArgs
$taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Write-InstallLog "SOC_Agent_Updater scheduled task registered."
Write-InstallLog "SOC Vector Agent installation completed."






