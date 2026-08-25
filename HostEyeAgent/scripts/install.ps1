# HostEye Endpoint Agent installer
# Requires Administrator. Installs HostEye collector as LocalSystem service, config updater, certs, and Sysmon.

param(
    [string]$GatewayUri = "https://hosteye.iahn.hanoi.vn/api/v1/telemetry",
    [string]$ConfigUri = "https://hosteye.iahn.hanoi.vn/api/v1/agent/config",
    [string]$AdmissionUri = "https://hosteye.iahn.hanoi.vn/api/v1/admission/request",
    [string]$RegistrationUri = "https://hosteye.iahn.hanoi.vn/api/v1/enroll",
    [string]$EnrollmentToken = "",
    [string]$BootstrapSigningKey = "hosteye-bootstrap-demo-signing-key-change-me",
    [int]$StartupJitterWindowSeconds = 300,
    [string]$CaCertificateFileName = "company_ca.crt",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$explicitParameters = @{} + $PSBoundParameters
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

$installerSettingsPath = Join-Path $StagingDir "installer-settings.json"
if (Test-Path -LiteralPath $installerSettingsPath) {
    $installerSettings = Get-Content -LiteralPath $installerSettingsPath -Raw | ConvertFrom-Json
    if (-not $explicitParameters.ContainsKey("GatewayUri") -and $installerSettings.GatewayUri) { $GatewayUri = [string]$installerSettings.GatewayUri }
    if (-not $explicitParameters.ContainsKey("ConfigUri") -and $installerSettings.ConfigUri) { $ConfigUri = [string]$installerSettings.ConfigUri }
    if (-not $explicitParameters.ContainsKey("AdmissionUri") -and $installerSettings.AdmissionUri) { $AdmissionUri = [string]$installerSettings.AdmissionUri }
    if (-not $explicitParameters.ContainsKey("RegistrationUri") -and $installerSettings.RegistrationUri) { $RegistrationUri = [string]$installerSettings.RegistrationUri }
    if (-not $explicitParameters.ContainsKey("EnrollmentToken") -and $installerSettings.EnrollmentToken) { $EnrollmentToken = [string]$installerSettings.EnrollmentToken }
    if (-not $explicitParameters.ContainsKey("BootstrapSigningKey") -and $installerSettings.BootstrapSigningKey) { $BootstrapSigningKey = [string]$installerSettings.BootstrapSigningKey }
    if (-not $explicitParameters.ContainsKey("StartupJitterWindowSeconds") -and $null -ne $installerSettings.StartupJitterWindowSeconds) {
        $StartupJitterWindowSeconds = [int]$installerSettings.StartupJitterWindowSeconds
    }
}

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

function Enable-HostEyeAuditTelemetry {
    Write-InstallLog "Enabling HostEye audit telemetry policy."

    $processAuditKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit"
    New-Item -Path $processAuditKey -Force | Out-Null
    New-ItemProperty -Path $processAuditKey -Name "ProcessCreationIncludeCmdLine_Enabled" -Value 1 -PropertyType DWord -Force | Out-Null
    Write-InstallLog "Enabled command line capture for Security EID 4688."

    $powerShellPolicyRoot = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell"
    $moduleLoggingKey = Join-Path $powerShellPolicyRoot "ModuleLogging"
    $moduleNamesKey = Join-Path $moduleLoggingKey "ModuleNames"
    $scriptBlockLoggingKey = Join-Path $powerShellPolicyRoot "ScriptBlockLogging"
    New-Item -Path $moduleNamesKey -Force | Out-Null
    New-Item -Path $scriptBlockLoggingKey -Force | Out-Null
    New-ItemProperty -Path $moduleLoggingKey -Name "EnableModuleLogging" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $moduleNamesKey -Name "*" -Value "*" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $scriptBlockLoggingKey -Name "EnableScriptBlockLogging" -Value 1 -PropertyType DWord -Force | Out-Null
    Write-InstallLog "Enabled PowerShell module logging EID 4103 and script block logging EID 4104."

    $channelsToEnable = @(
        "Microsoft-Windows-PowerShell/Operational",
        "Microsoft-Windows-DNS-Client/Operational",
        "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall",
        "Microsoft-Windows-TaskScheduler/Operational",
        "Microsoft-Windows-Windows Defender/Operational"
    )
    foreach ($channelName in $channelsToEnable) {
        try {
            & wevtutil.exe sl $channelName /e:true 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-InstallLog "Enabled Windows Event Log channel: $channelName"
            } else {
                Write-InstallLog "WARNING: could not enable channel $channelName; wevtutil exit code $LASTEXITCODE"
            }
        } catch {
            Write-InstallLog "WARNING: could not enable channel ${channelName}: $($_.Exception.Message)"
        }
    }

    $auditSubcategories = @(
        @{ Name = "Process Creation"; Id = "{0CCE922B-69AE-11D9-BED3-505054503030}"; Success = "enable"; Failure = "enable" },
        # Successful connections are already represented by Sysmon EID 3. Keeping
        # only WFP failures avoids duplicate 5156 traffic flooding the local spool.
        @{ Name = "Filtering Platform Connection"; Id = "{0CCE9226-69AE-11D9-BED3-505054503030}"; Success = "disable"; Failure = "enable" },
        @{ Name = "Filtering Platform Packet Drop"; Id = "{0CCE9225-69AE-11D9-BED3-505054503030}"; Success = "disable"; Failure = "enable" }
    )
    foreach ($subcategory in $auditSubcategories) {
        try {
            & auditpol.exe /set /subcategory:$($subcategory.Id) /success:$($subcategory.Success) /failure:$($subcategory.Failure) 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-InstallLog "Configured audit policy subcategory: $($subcategory.Name) success=$($subcategory.Success) failure=$($subcategory.Failure)"
            } else {
                Write-InstallLog "WARNING: could not configure audit policy subcategory $($subcategory.Name); auditpol exit code $LASTEXITCODE"
            }
        } catch {
            Write-InstallLog "WARNING: could not configure audit policy subcategory $($subcategory.Name): $($_.Exception.Message)"
        }
    }
}

# PowerShell can otherwise return a successful process code for some nested
# script failures. Make every terminating installer error visible to Inno Setup.
trap {
    try { Write-InstallLog "FATAL: $($_.Exception.Message)" } catch {}
    foreach ($recoverService in @($ServiceName, $ShipperServiceName)) {
        try {
            $service = Get-Service -Name $recoverService -ErrorAction SilentlyContinue
            if ($service -and $service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
                Start-Service -Name $recoverService -ErrorAction Stop
                Write-InstallLog "RECOVERY: Restarted pre-existing service $recoverService after installation failure."
            }
        } catch {
            try { Write-InstallLog "RECOVERY WARNING: Could not restart ${recoverService}: $($_.Exception.Message)" } catch {}
        }
    }
    Write-Error $_
    exit 1
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

Write-InstallLog "Starting HostEye Endpoint Agent installation from $StagingDir"
Write-InstallLog "Installer settings: GatewayUri=$GatewayUri ConfigUri=$ConfigUri AdmissionUri=$AdmissionUri StartupJitterWindowSeconds=$StartupJitterWindowSeconds"
$completionMarker = Join-Path $ProgramDataDir "install-complete.json"
Remove-Item -LiteralPath $completionMarker -Force -ErrorAction SilentlyContinue

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

$enrollmentResult = $null
if (-not [string]::IsNullOrWhiteSpace($EnrollmentToken)) {
    $enrollmentScript = Join-Path $TargetDir "Enroll-HostEyeEndpoint.ps1"
    if (-not (Test-Path -LiteralPath $enrollmentScript)) { throw "Enrollment client is missing: $enrollmentScript" }
    Write-InstallLog "Enrolling endpoint identity through $RegistrationUri"
    try {
        & $enrollmentScript -RegistrationUri $RegistrationUri -EnrollmentToken $EnrollmentToken -BootstrapSigningKey $BootstrapSigningKey -CertDirectory $CertDir -StateDirectory (Join-Path $ProgramDataDir "identity") | Out-Host
    } catch {
        Write-InstallLog "ERROR: Endpoint enrollment failed: $($_.Exception.Message)"
        throw
    }
    $enrollmentStateFile = Join-Path $ProgramDataDir "identity\enrollment.json"
    if (-not (Test-Path -LiteralPath $enrollmentStateFile)) { throw "Endpoint enrollment did not produce identity state." }
    $enrollmentResult = Get-Content -LiteralPath $enrollmentStateFile -Raw | ConvertFrom-Json
    if ($enrollmentResult.bootstrap.telemetryUrl) { $GatewayUri = [string]$enrollmentResult.bootstrap.telemetryUrl }
    if ($enrollmentResult.bootstrap.configUrl) { $ConfigUri = [string]$enrollmentResult.bootstrap.configUrl }
    if ($enrollmentResult.bootstrap.admissionUrl) { $AdmissionUri = [string]$enrollmentResult.bootstrap.admissionUrl }
    Write-InstallLog "Enrollment completed. C_i=$($enrollmentResult.ciId) certificate=$($enrollmentResult.certificateThumbprint)"
} else {
    Write-InstallLog "Enrollment token was not supplied; preserving legacy/local pre-provisioned identity behavior."
}

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
    try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
    sc.exe delete $ServiceName | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        throw "Existing $ServiceName service is still pending deletion."
    }
}

Write-InstallLog "Dang cai dat HostEye service voi cau hinh: $configPath"
$vectorBinaryPath = "`"$vectorExe`" --config-toml `"$configPath`""
try {
    New-Service -Name $ServiceName -BinaryPathName $vectorBinaryPath -DisplayName "HostEye Endpoint Agent" -Description "HostEye endpoint security telemetry collector" -StartupType Manual | Out-Null
} catch {
    Write-InstallLog "ERROR: Windows Service creation failed: $($_.Exception.Message)"
    throw
}
if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    throw "Windows Service Control Manager did not persist $ServiceName."
}
Write-InstallLog "HostEyeAgent Windows Service created successfully."

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
    # Enable audit immediately before collection starts. Enabling PowerShell module
    # logging earlier makes the installer collect its own setup commands as a burst.
    Enable-HostEyeAuditTelemetry
    Write-InstallLog "Dang khoi dong HostEye Endpoint Agent."
    $startupJitterSeconds = Get-StableJitterSeconds -Seed $machineGuid -WindowSeconds 30
    Write-InstallLog "Applying stable startup jitter before HostEye service start: $startupJitterSeconds seconds."
    if ($startupJitterSeconds -gt 0) { Start-Sleep -Seconds $startupJitterSeconds }
    try {
        Start-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
    } catch {
        Write-InstallLog "ERROR: HostEyeAgent failed to start: $($_.Exception.Message)"
        throw
    }
    Write-InstallLog "HostEye service started."
} else {
    Write-InstallLog "NoStart was set; HostEye service installed but not started."
}


# Configure and install HostEye Shipper startup task. HostEye collector writes local spool; shipper sends batches with mTLS/backoff.
$shipperExe = Join-Path $ShipperDir "HostEyeShipper.exe"
if (-not (Test-Path -LiteralPath $shipperExe)) {
    $legacyShipperExe = Join-Path $ShipperDir "hosteye-shipper.exe"
    if (Test-Path -LiteralPath $legacyShipperExe) { $shipperExe = $legacyShipperExe }
}
$shipperConfig = Join-Path $ShipperDir "shipper-config.json"
$shipperConfigObject = [ordered]@{
    GatewayUri = $GatewayUri
    ConfigUri = $ConfigUri
    AdmissionUri = $AdmissionUri
    GroupId = "default"
    AgentConfigSigningKey = "hosteye-dynamic-config-demo-key"
    SpoolDirectory = (Join-Path $ProgramDataDir "spool")
    StateDirectory = (Join-Path $ProgramDataDir "shipper_state")
    LogDirectory = $LogDir
    ClientCertificateFile = (Join-Path $CertDir "client.crt")
    ClientKeyFile = (Join-Path $CertDir "client.key")
    ClientIdentityPfxFile = if ($enrollmentResult) { [string]$enrollmentResult.clientIdentityPfxFile } else { (Join-Path $CertDir "client.pfx") }
    ClientIdentityPfxPassword = if ($enrollmentResult) { [string]$enrollmentResult.clientIdentityPfxPassword } else { "" }
    CaCertificateFile = (Join-Path $CertDir "company_ca.crt")
    AllowSystemServerCertificateTrust = $true
    MaxEvents = 500
    MaxBytes = 524288
    NormalJitterWindowSeconds = 5
    RecoveryJitterWindowSeconds = 30
    StartupJitterWindowSeconds = [Math]::Max(0, $StartupJitterWindowSeconds)
    BaseBackoffSeconds = 2
    MaxBackoffSeconds = 120
    MaxSpoolSizeMB = 256
    LowWatermarkPercent = 70
    SpoolCheckIntervalSeconds = 10
    PreferDeletingSentFirst = $true
    SentRetentionDays = 1
    RunOnce = $false
}
$shipperConfigJson = $shipperConfigObject | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($shipperConfig, $shipperConfigJson, [System.Text.UTF8Encoding]::new($false))

if (Test-Path $shipperExe) {
    $existingShipper = Get-Service -Name $ShipperServiceName -ErrorAction SilentlyContinue
    if ($existingShipper) {
        Write-InstallLog "Deleting existing HostEye Shipper service."
        try { Stop-Service -Name $ShipperServiceName -Force -ErrorAction SilentlyContinue } catch {}
        $existingNssm = Join-Path $ShipperDir "tools\nssm.exe"
        if (Test-Path -LiteralPath $existingNssm) {
            try { & $existingNssm remove $ShipperServiceName confirm | Out-Null } catch {}
        } else {
            sc.exe delete $ShipperServiceName | Out-Null
        }
        Start-Sleep -Seconds 3
    }

    $shipperTaskName = "HostEye_Shipper_Startup"
    Unregister-ScheduledTask -TaskName $shipperTaskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "SOC_Shipper_Startup" -Confirm:$false -ErrorAction SilentlyContinue

    $nssm = Join-Path $ShipperDir "tools\nssm.exe"
    if (-not (Test-Path -LiteralPath $nssm)) {
        throw "NSSM service wrapper is missing: $nssm"
    }
    Write-InstallLog "Installing HostEyeShipper as an AUTO_START LocalSystem Windows Service."
    & $nssm install $ShipperServiceName $shipperExe | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "NSSM could not install $ShipperServiceName" }
    # With no explicit argument, Shipper resolves shipper-config.json beside its executable.
    & $nssm reset $ShipperServiceName AppParameters | Out-Null
    & $nssm set $ShipperServiceName AppDirectory $ShipperDir | Out-Null
    & $nssm set $ShipperServiceName DisplayName "HostEye Shipper" | Out-Null
    & $nssm set $ShipperServiceName Description "Durable HostEye telemetry spool, admission, retry, and upload service" | Out-Null
    & $nssm set $ShipperServiceName Start SERVICE_AUTO_START | Out-Null
    & $nssm set $ShipperServiceName ObjectName LocalSystem | Out-Null
    & $nssm set $ShipperServiceName AppExit Default Restart | Out-Null
    & $nssm set $ShipperServiceName AppRestartDelay 5000 | Out-Null
    & $nssm set $ShipperServiceName AppThrottle 1500 | Out-Null
    & $nssm set $ShipperServiceName AppKillProcessTree 1 | Out-Null
    & $nssm set $ShipperServiceName AppStdout (Join-Path $LogDir "shipper-service.stdout.log") | Out-Null
    & $nssm set $ShipperServiceName AppStderr (Join-Path $LogDir "shipper-service.stderr.log") | Out-Null
    $shipperEnvironment = @(
        "HOSTEYE_AGENT_ID=$([Environment]::GetEnvironmentVariable('HOSTEYE_AGENT_ID', 'Machine'))",
        "HOSTEYE_HOST_ID=$([Environment]::GetEnvironmentVariable('HOSTEYE_HOST_ID', 'Machine'))",
        "VECTOR_AGENT_ID=$([Environment]::GetEnvironmentVariable('VECTOR_AGENT_ID', 'Machine'))",
        "VECTOR_HOST_ID=$([Environment]::GetEnvironmentVariable('VECTOR_HOST_ID', 'Machine'))"
    )
    if ($enrollmentResult -and -not [string]::IsNullOrWhiteSpace([string]$enrollmentResult.ciId)) {
        $shipperEnvironment += "HOSTEYE_CI_ID=$([string]$enrollmentResult.ciId)"
    }
    & $nssm set $ShipperServiceName AppEnvironmentExtra @shipperEnvironment | Out-Null
    sc.exe failure $ShipperServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    sc.exe failureflag $ShipperServiceName 1 | Out-Null
    if (-not $NoStart) {
        & $nssm start $ShipperServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "HostEyeShipper service failed to start" }
        Write-InstallLog "HostEyeShipper Windows Service installed and started."
    } else {
        Write-InstallLog "HostEyeShipper service installed but not started because NoStart was set."
    }
} else {
    Write-InstallLog "ERROR: HostEyeShipper.exe is missing from $ShipperDir."
    throw "HostEyeShipper.exe is required but was not packaged."
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
$completionState = [ordered]@{
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    enrollmentRequired = -not [string]::IsNullOrWhiteSpace($EnrollmentToken)
    ciId = if ($enrollmentResult) { [string]$enrollmentResult.ciId } else { "" }
    agentService = (Get-Service -Name $ServiceName -ErrorAction Stop).Status.ToString()
    shipperService = (Get-Service -Name $ShipperServiceName -ErrorAction Stop).Status.ToString()
}
[System.IO.File]::WriteAllText($completionMarker, ($completionState | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Write-InstallLog "HostEye Endpoint Agent installation completed successfully."
exit 0






