Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-HostEyeDemoRoot {
    return Split-Path -Parent $PSScriptRoot
}

function Resolve-HostEyePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $Path))
}

function Resolve-HostEyeInstaller {
    param(
        [Parameter(Mandatory = $true)]$Config
    )

    $primary = Resolve-HostEyePath $Config.InstallerRelativePath
    if (Test-Path -LiteralPath $primary) {
        return $primary
    }

    if ($Config.PSObject.Properties.Name -contains "InstallerFallbackPath" -and $Config.InstallerFallbackPath) {
        $fallback = Resolve-HostEyePath $Config.InstallerFallbackPath
        if (Test-Path -LiteralPath $fallback) {
            return $fallback
        }
    }

    return $primary
}

function Read-HostEyeDemoConfig {
    param(
        [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json")
    )

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Config not found: $ConfigPath"
    }

    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.TemplateVmName) { throw "TemplateVmName is required in config.demo.json" }
    if (-not $config.TemplateSnapshotName) { throw "TemplateSnapshotName is required in config.demo.json" }
    if (-not $config.VmNamePrefix) { throw "VmNamePrefix is required in config.demo.json" }
    if ($config.VmCount -lt 1) { throw "VmCount must be >= 1" }
    if ($config.VmMemoryMB -lt 2048) { throw "VmMemoryMB should be at least 2048 for Windows 11" }
    return $config
}

function Resolve-VBoxManage {
    $cmd = Get-Command VBoxManage.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe",
        "${env:ProgramFiles(x86)}\Oracle\VirtualBox\VBoxManage.exe"
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }

    throw "VBoxManage.exe was not found. Install VirtualBox or add VBoxManage to PATH."
}

function Invoke-VBoxManage {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $vbox = Resolve-VBoxManage
    & $vbox @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "VBoxManage failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
}

function Get-HostEyeVmNames {
    param(
        [Parameter(Mandatory = $true)]$Config
    )

    $names = New-Object System.Collections.Generic.List[string]
    for ($i = 1; $i -le [int]$Config.VmCount; $i++) {
        $names.Add(("{0}-{1:00}" -f $Config.VmNamePrefix, $i))
    }
    return $names
}

function Test-VBoxVmExists {
    param(
        [Parameter(Mandatory = $true)][string]$Name
    )

    $vbox = Resolve-VBoxManage
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $vbox showvminfo $Name --machinereadable 1>$null 2>$null
        return $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function New-HostEyeVmClone {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$VmName
    )

    if (Test-VBoxVmExists -Name $VmName) {
        Write-Host "VM already exists: $VmName"
        return
    }

    Write-Host "Creating linked clone: $VmName"
    Invoke-VBoxManage @("clonevm", $Config.TemplateVmName, "--snapshot", $Config.TemplateSnapshotName, "--name", $VmName, "--options", "link", "--register")

    Invoke-VBoxManage @("modifyvm", $VmName, "--memory", ([string]$Config.VmMemoryMB), "--cpus", ([string]$Config.VmCpuCount))

    if ($Config.NetworkMode -eq "bridged") {
        Invoke-VBoxManage @("modifyvm", $VmName, "--nic1", "bridged")
        if ($Config.BridgeAdapterName) {
            Invoke-VBoxManage @("modifyvm", $VmName, "--bridgeadapter1", ([string]$Config.BridgeAdapterName))
        }
    } elseif ($Config.NetworkMode -eq "nat") {
        Invoke-VBoxManage @("modifyvm", $VmName, "--nic1", "nat")
    } else {
        throw "Unsupported NetworkMode: $($Config.NetworkMode)"
    }
}

function Start-HostEyeVm {
    param(
        [Parameter(Mandatory = $true)][string]$VmName
    )

    $vbox = Resolve-VBoxManage
    & $vbox showvminfo $VmName --machinereadable | Select-String '^VMState="running"$' *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "VM already running: $VmName"
        return
    }

    Write-Host "Starting VM: $VmName"
    Invoke-VBoxManage @("startvm", $VmName, "--type", "headless")
}

function Stop-HostEyeVm {
    param(
        [Parameter(Mandatory = $true)][string]$VmName
    )

    if (-not (Test-VBoxVmExists -Name $VmName)) {
        Write-Host "VM not found, skip stop: $VmName"
        return
    }

    Write-Host "Stopping VM: $VmName"
    $vbox = Resolve-VBoxManage
    & $vbox controlvm $VmName acpipowerbutton *> $null
    if ($LASTEXITCODE -ne 0) {
        & $vbox controlvm $VmName poweroff *> $null
    }
}

function Remove-HostEyeVmClone {
    param(
        [Parameter(Mandatory = $true)][string]$VmName
    )

    if (-not (Test-VBoxVmExists -Name $VmName)) {
        Write-Host "VM not found, skip remove: $VmName"
        return
    }

    Write-Host "Powering off and deleting VM clone: $VmName"
    $vbox = Resolve-VBoxManage
    & $vbox controlvm $VmName poweroff *> $null
    & $vbox unregistervm $VmName --delete
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to delete VM clone: $VmName"
    }
}

function Start-HostEyeServerPipeline {
    param(
        [Parameter(Mandatory = $true)]$Config
    )

    $composeDir = Resolve-HostEyePath $Config.DockerComposeDirectory
    $composeFile = Join-Path $composeDir $Config.DockerComposeFile
    if (-not (Test-Path -LiteralPath $composeFile)) {
        throw "Docker compose file not found: $composeFile"
    }

    Write-Host "Starting HostEye server pipeline with Docker Compose..."
    docker compose -f $composeFile up -d
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose up failed"
    }
}

function Start-HostEyeDashboardProcesses {
    param(
        [Parameter(Mandatory = $true)]$Config
    )

    $apiDir = Resolve-HostEyePath $Config.DashboardApiDirectory
    $webDir = Resolve-HostEyePath $Config.DashboardWebDirectory

    Start-NodeIfPortFree -Port ([int]$Config.DashboardApiPort) -WorkingDirectory $apiDir -Script "src/server.js"
    Start-NodeIfPortFree -Port ([int]$Config.DashboardWebPort) -WorkingDirectory $webDir -Script "server.js"
}

function Start-NodeIfPortFree {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Script
    )

    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
        Write-Host "Port $Port already listening; skip starting Node process."
        return
    }

    if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
        throw "Node working directory not found: $WorkingDirectory"
    }

    Write-Host "Starting Node process on port $Port from $WorkingDirectory"
    Start-Process -FilePath "node.exe" -ArgumentList $Script -WorkingDirectory $WorkingDirectory -WindowStyle Hidden
}

function Wait-HostEyeApi {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [int]$TimeoutSeconds = 120
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $uri = "http://localhost:$($Config.DashboardApiPort)/api/health"

    do {
        try {
            $health = Invoke-RestMethod -Uri $uri -TimeoutSec 5
            if ($health.status -eq "ok") {
                Write-Host "HostEye API is healthy. rows=$($health.rows)"
                return $health
            }
        } catch {
            Start-Sleep -Seconds 3
        }
    } while ((Get-Date) -lt $deadline)

    throw "HostEye API did not become healthy within $TimeoutSeconds seconds: $uri"
}

function Invoke-HostEyeGuestPowerShell {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$VmName,
        [Parameter(Mandatory = $true)][string]$Command
    )

    if (-not $Config.GuestPassword) {
        throw "GuestPassword is empty in config.demo.json; cannot run guest automation."
    }

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
    Invoke-VBoxManage @(
        "guestcontrol", $VmName, "run",
        "--username", ([string]$Config.GuestUsername),
        "--password", ([string]$Config.GuestPassword),
        "--exe", "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        "--",
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
    )
}

function Copy-HostEyeFileToGuest {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$VmName,
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not $Config.GuestPassword) {
        throw "GuestPassword is empty in config.demo.json; cannot copy into guest."
    }

    Invoke-VBoxManage @(
        "guestcontrol", $VmName, "copyto",
        "--username", ([string]$Config.GuestUsername),
        "--password", ([string]$Config.GuestPassword),
        $Source,
        $Destination
    )
}

function Install-HostEyeAgentInVm {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$VmName
    )

    if (-not $Config.UseVBoxGuestControl) {
        Write-Host "UseVBoxGuestControl=false; skip agent install in $VmName"
        return
    }

    $installer = Resolve-HostEyeInstaller -Config $Config
    if (-not (Test-Path -LiteralPath $installer)) {
        throw "HostEye installer not found: $installer"
    }

    Write-Host "Installing HostEye Agent in VM: $VmName"
    Invoke-HostEyeGuestPowerShell -Config $Config -VmName $VmName -Command "New-Item -ItemType Directory -Force C:\HostEyeDemo | Out-Null"
    Copy-HostEyeFileToGuest -Config $Config -VmName $VmName -Source $installer -Destination "C:\HostEyeDemo\HostEye_Endpoint_Installer.exe"

    if ($Config.GatewayIp) {
        $hostsCommand = @"
`$line = "$($Config.GatewayIp) $($Config.GatewayHostName)"
`$hosts = "C:\Windows\System32\drivers\etc\hosts"
`$content = Get-Content `$hosts -ErrorAction SilentlyContinue
if (-not (`$content -match [regex]::Escape("$($Config.GatewayHostName)"))) {
  Add-Content -LiteralPath `$hosts -Value `$line
}
"@
        Invoke-HostEyeGuestPowerShell -Config $Config -VmName $VmName -Command $hostsCommand
    }

    $installCommand = "Start-Process -FilePath C:\HostEyeDemo\HostEye_Endpoint_Installer.exe -ArgumentList '$($Config.InstallerArguments)' -Wait -PassThru | Select-Object ExitCode | ConvertTo-Json"
    Invoke-HostEyeGuestPowerShell -Config $Config -VmName $VmName -Command $installCommand
}

function Test-HostEyeAgentInVm {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$VmName
    )

    $command = @"
`$result = [ordered]@{}
foreach (`$name in @("HostEyeAgent", "HostEyeShipper", "Sysmon64")) {
  `$svc = Get-Service -Name `$name -ErrorAction SilentlyContinue
  `$result[`$name] = if (`$svc) { `$svc.Status.ToString() } else { "Missing" }
}
`$result.Gateway443 = (Test-NetConnection $($Config.GatewayHostName) -Port 443).TcpTestSucceeded
`$result | ConvertTo-Json -Compress
"@
    Invoke-HostEyeGuestPowerShell -Config $Config -VmName $VmName -Command $command
}



