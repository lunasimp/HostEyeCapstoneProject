# HostEye Endpoint Agent installer
# Requires Administrator. Installs HostEye collector as LocalSystem service, config updater, certs, and Sysmon.

param(
    [string]$GatewayUri = "https://hosteye.iahn.hanoi.vn/api/v1/telemetry",
    [string]$CaCertificateFileName = "company_ca.crt",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$StagingDir = $PSScriptRoot
$ServiceName = "HostEyeAgent"
$ShipperServiceName = "HostEyeShipper"
$TargetDir = "C:\Program Files\HostEye"
$CertDir = Join-Path $TargetDir "certs"
$SysmonDir = Join-Path $TargetDir "Sysmon"
$ShipperDir = Join-Path $TargetDir "HostEyeShipper"
$ProgramDataDir = "C:\ProgramData\HostEye"
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

function Copy-DirectoryContentsIfDifferent([string]$SourceDir, [string]$DestinationDir, [switch]$Recurse) {
    if (-not (Test-Path $SourceDir)) { return $false }
    $srcFull = [System.IO.Path]::GetFullPath($SourceDir).TrimEnd('\')
    $dstFull = [System.IO.Path]::GetFullPath($DestinationDir).TrimEnd('\')
    if ($srcFull -ieq $dstFull) {
        Write-InstallLog "Source and destination are the same; skipping copy: $SourceDir"
        return $true
    }

    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    if ($Recurse) {
        Copy-Item -Path (Join-Path $SourceDir "*") -Destination $DestinationDir -Force -Recurse
    } else {
        Copy-Item -Path (Join-Path $SourceDir "*") -Destination $DestinationDir -Force
    }
    return $true
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

function Stop-ExistingComponent([string]$Name) {
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($svc) {
        Write-InstallLog "Stopping existing component before file copy: $Name"
        try { Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Seconds 2
        try {
            $svcInfo = Get-CimInstance Win32_Service -Filter "Name='$Name'" -ErrorAction SilentlyContinue
            if ($svcInfo -and $svcInfo.ProcessId -and $svcInfo.ProcessId -ne 0) {
                Write-InstallLog "Killing stuck service process for $Name PID=$($svcInfo.ProcessId)"
                Stop-Process -Id $svcInfo.ProcessId -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        } catch {
            Write-InstallLog "WARNING: could not inspect process for ${Name}: $($_.Exception.Message)"
        }
    }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This installer must be run as Administrator."
    exit 1
}

Write-InstallLog "Bat dau cai dat HostEye Endpoint Agent from $StagingDir"

New-Item -ItemType Directory -Force -Path $TargetDir, $CertDir, $SysmonDir, $ShipperDir, $ProgramDataDir, $LogDir, (Join-Path $ProgramDataDir "data"), (Join-Path $ProgramDataDir "spool"), (Join-Path $ProgramDataDir "shipper_state") | Out-Null

foreach ($existingComponent in @($ServiceName, $ShipperServiceName, "Vector", "SOCShipper")) {
    Stop-ExistingComponent $existingComponent
}
foreach ($existingTask in @("HostEye_Shipper_Startup", "HostEye_Agent_Startup", "SOC_Shipper_Startup", "SOC_Vector_Startup")) {
    try { Stop-ScheduledTask -TaskName $existingTask -ErrorAction SilentlyContinue } catch {}
}
foreach ($existingProcess in @("HostEyeShipper", "SOCShipper")) {
    Get-Process -Name $existingProcess -ErrorAction SilentlyContinue | ForEach-Object {
        Write-InstallLog "Killing existing process before file copy: $($_.ProcessName) PID=$($_.Id)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}

# Stable endpoint identity for HostEye metadata.
$machineGuid = $null
try { $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid } catch {}
if ([string]::IsNullOrWhiteSpace($machineGuid)) { $machineGuid = [guid]::NewGuid().ToString() }
Ensure-MachineEnv "HOSTEYE_AGENT_ID" "hosteye-agent-$machineGuid"
Ensure-MachineEnv "HOSTEYE_HOST_ID" "hosteye-host-$machineGuid"
Ensure-MachineEnv "VECTOR_AGENT_ID" "agent-$machineGuid"
Ensure-MachineEnv "VECTOR_HOST_ID" "host-$machineGuid"

# Copy core files. If running from the final install dir, these calls no-op safely.
Copy-IfDifferent (Join-Path $StagingDir "vector.exe") (Join-Path $TargetDir "vector.exe")
Copy-IfDifferent (Join-Path $StagingDir "vector.toml") (Join-Path $TargetDir "vector.toml")
Copy-IfDifferent (Join-Path $StagingDir "HostEye_Updater.ps1") (Join-Path $TargetDir "HostEye_Updater.ps1")
Copy-IfDifferent (Join-Path $StagingDir "SOC_Updater.ps1") (Join-Path $TargetDir "HostEye_Updater.ps1")
Set-Content -LiteralPath (Join-Path $TargetDir "agent.version") -Value "1.0.0" -Encoding ASCII
if (Copy-DirectoryContentsIfDifferent (Join-Path $StagingDir "HostEyeShipper") $ShipperDir -Recurse) {
} elseif (Copy-DirectoryContentsIfDifferent (Join-Path $StagingDir "SOCShipper") $ShipperDir -Recurse) {
} else {
    Write-InstallLog "WARNING: HostEyeShipper directory was not found in staging dir."
}

if (Copy-DirectoryContentsIfDifferent (Join-Path $StagingDir "certs") $CertDir) {
} else {
    Write-InstallLog "WARNING: certs directory was not found in staging dir."
}

if (Copy-DirectoryContentsIfDifferent (Join-Path $StagingDir "Sysmon") $SysmonDir -Recurse) {
} else {
    Write-InstallLog "WARNING: Sysmon directory was not found in staging dir."
}

# Trust internal CA for HostEye TLS and PowerShell updater HTTPS downloads.
$caPath = Join-Path $CertDir $CaCertificateFileName
if (Test-Path $caPath) {
    Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
    Write-InstallLog "Imported CA certificate into LocalMachine Root: $caPath"
} else {
    Write-InstallLog "WARNING: CA certificate was not found at $caPath"
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
$sysmonConfig = Join-Path $SysmonDir "hosteye-sysmon-config.xml"
if (-not (Test-Path $sysmonConfig)) { $sysmonConfig = Join-Path $SysmonDir "soc-sysmon-config.xml" }
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
    Write-InstallLog "WARNING: Sysmon64.exe or HostEye Sysmon config missing; Sysmon not installed."
}

# Recreate HostEye service using Vector's native Windows service manager.
$vectorExe = Join-Path $TargetDir "vector.exe"
$configPath = Join-Path $TargetDir "vector.toml"
foreach ($legacyTask in @("SOC_Vector_Startup", "SOC_Shipper_Startup", "SOC_Agent_Updater")) {
    Unregister-ScheduledTask -TaskName $legacyTask -Confirm:$false -ErrorAction SilentlyContinue
}
foreach ($legacySvc in @("Vector", "SOCShipper")) {
    $svc = Get-Service -Name $legacySvc -ErrorAction SilentlyContinue
    if ($svc) {
        Write-InstallLog "Stopping legacy component: $legacySvc"
        try { Stop-Service -Name $legacySvc -Force -ErrorAction SilentlyContinue } catch {}
        try { sc.exe delete $legacySvc | Out-Null } catch {}
    }
}

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Write-InstallLog "Stopping and uninstalling existing HostEye service."
    try { & $vectorExe service stop --name $ServiceName | Out-Null } catch {}
    try { & $vectorExe service uninstall --name $ServiceName | Out-Null } catch {}
    Start-Sleep -Seconds 3
}

Write-InstallLog "Dang cai dat HostEye service voi cau hinh: $configPath"
& $vectorExe service install --name $ServiceName --display-name "HostEye Endpoint Agent" --config-toml $configPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "HostEye service install failed with exit code $LASTEXITCODE" }

sc.exe description $ServiceName "HostEye - dich vu thu thap va gui telemetry bao mat endpoint" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/300000 | Out-Null
sc.exe failureflag $ServiceName 1 | Out-Null
sc.exe config $ServiceName start= demand | Out-Null

# Register deterministic jittered startup task for fleet-scale boot storms.
$startupTaskName = "HostEye_Agent_Startup"
$startupScript = Join-Path $TargetDir "HostEye_StartAgent.ps1"
$startupScriptLines = @(
    'param([int]$JitterWindowSeconds = 300)',
    '$ServiceName = "HostEyeAgent"',
    '$LogDir = "C:\ProgramData\HostEye\logs"',
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
    '        Write-StartupLog "HostEye service start requested."',
    '    } else {',
    '        Write-StartupLog "HostEye service already running; no action needed."',
    '    }',
    '} catch {',
    '    Write-StartupLog "ERROR: $($_.Exception.Message)"',
    '    throw',
    '}'
)
Set-Content -LiteralPath $startupScript -Value $startupScriptLines -Encoding UTF8
Write-InstallLog "Registering $startupTaskName scheduled task for jittered HostEye startup."
Unregister-ScheduledTask -TaskName $startupTaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "SOC_Vector_Startup" -Confirm:$false -ErrorAction SilentlyContinue
$startupAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startupScript`" -JitterWindowSeconds 300"
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$startupSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable
Register-ScheduledTask -TaskName $startupTaskName -Action $startupAction -Trigger $startupTrigger -Principal $startupPrincipal -Settings $startupSettings -Force | Out-Null
Write-InstallLog "HostEye_Agent_Startup scheduled task registered."

if (-not $NoStart) {
    Write-InstallLog "Dang khoi dong HostEye Endpoint Agent."
    $startupJitterSeconds = Get-StableJitterSeconds -Seed $machineGuid -WindowSeconds 30
    Write-InstallLog "Applying stable startup jitter before HostEye service start: $startupJitterSeconds seconds."
    if ($startupJitterSeconds -gt 0) { Start-Sleep -Seconds $startupJitterSeconds }
    & $vectorExe service start --name $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "HostEye service start failed with exit code $LASTEXITCODE" }
    Write-InstallLog "HostEye service started."
} else {
    Write-InstallLog "NoStart was set; HostEye service installed but not started."
}


# Configure and install HostEye Shipper startup task. HostEye collector writes local spool; shipper sends batches with mTLS/backoff.
$shipperExe = Join-Path $ShipperDir "HostEyeShipper.exe"
$shipperConfig = Join-Path $ShipperDir "shipper-config.json"
$shipperConfigObject = [ordered]@{
    GatewayUri = $GatewayUri
    SpoolDirectory = (Join-Path $ProgramDataDir "spool")
    StateDirectory = (Join-Path $ProgramDataDir "shipper_state")
    LogDirectory = $LogDir
    ClientCertificateFile = (Join-Path $CertDir "client.crt")
    ClientKeyFile = (Join-Path $CertDir "client.key")
    CaCertificateFile = (Join-Path $CertDir "company_ca.crt")
    MaxEvents = 500
    MaxBytes = 524288
    NormalJitterWindowSeconds = 5
    RecoveryJitterWindowSeconds = 30
    BaseBackoffSeconds = 2
    MaxBackoffSeconds = 120
    MaxSpoolSizeMB = 2048
    LowWatermarkPercent = 80
    SpoolCheckIntervalSeconds = 10
    PreferDeletingSentFirst = $true
    SentRetentionDays = 1
    RunOnce = $false
}
$shipperConfigObject | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $shipperConfig -Encoding UTF8

if (Test-Path $shipperExe) {
    $existingShipper = Get-Service -Name $ShipperServiceName -ErrorAction SilentlyContinue
    if ($existingShipper) {
        Write-InstallLog "Deleting legacy HostEye/SOC Shipper service."
        try { Stop-Service -Name $ShipperServiceName -Force -ErrorAction SilentlyContinue } catch {}
        sc.exe delete $ShipperServiceName | Out-Null
        Start-Sleep -Seconds 3
    }

    $shipperTaskName = "HostEye_Shipper_Startup"
    $shipperTaskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$shipperExe' '$shipperConfig'`""
    Write-InstallLog "Registering $shipperTaskName scheduled task."
    Unregister-ScheduledTask -TaskName $shipperTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "SOC_Shipper_Startup" -Confirm:$false -ErrorAction SilentlyContinue
    $shipperAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument $shipperTaskArgs
    $shipperTrigger = New-ScheduledTaskTrigger -AtStartup
    $shipperPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
    $shipperSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $shipperTaskName -Action $shipperAction -Trigger $shipperTrigger -Principal $shipperPrincipal -Settings $shipperSettings -Force | Out-Null
    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $shipperTaskName
        Write-InstallLog "HostEye Shipper startup task registered and started."
    } else {
        Write-InstallLog "HostEye Shipper startup task registered but not started because NoStart was set."
    }
} else {
    Write-InstallLog "WARNING: HostEyeShipper.exe missing; Shipper startup task not registered."
}
# Scheduled configuration updater.
$taskName = "HostEye_Agent_Updater"
$taskScript = Join-Path $TargetDir "HostEye_Updater.ps1"
$taskArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskScript`""
Write-InstallLog "Registering $taskName scheduled task."
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "SOC_Agent_Updater" -Confirm:$false -ErrorAction SilentlyContinue
$taskAction = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument $taskArgs
$taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
Write-InstallLog "HostEye_Agent_Updater scheduled task registered."
Write-InstallLog "Cai dat HostEye Endpoint Agent hoan tat."






