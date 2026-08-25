param(
    [string]$GatewayUri = "https://hosteye.iahn.hanoi.vn/api/v1/telemetry",
    [string]$ConfigUri = "https://hosteye.iahn.hanoi.vn/api/v1/agent/config",
    [string]$AdmissionUri = "https://hosteye.iahn.hanoi.vn/api/v1/admission/request",
    [string]$RegistrationUri = "https://hosteye.iahn.hanoi.vn/api/v1/enroll",
    [string]$EnrollmentToken = "",
    [string]$BootstrapSigningKey = "hosteye-bootstrap-demo-signing-key-change-me",
    [int]$StartupJitterWindowSeconds = 300,
    [string]$OutputBaseFilename = "HostEye_Endpoint_Installer",
    [switch]$ForceDependencies,
    [switch]$SkipShipperBuild
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$repoRoot = Split-Path -Parent $root
$vectorExe = Join-Path $root "vector\vector.exe"
$sysmonExe = Join-Path $root "sysmon\Sysmon64.exe"
$shipperExe = Join-Path $root "shipper\target\release\hosteye-shipper.exe"
$nssmExe = Join-Path $root "shipper\tools\nssm.exe"
$iscc = "C:\Program Files\Inno Setup 7\ISCC.exe"

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing: $Path"
    }
}

if ($SkipShipperBuild) {
    Assert-File $shipperExe "Prebuilt HostEyeShipper release binary"
    Write-Host "Using prebuilt HostEyeShipper release binary: $shipperExe"
} else {
    Write-Host "Building HostEyeShipper release binary..."
    Push-Location (Join-Path $root "shipper")
    try { cargo build --release } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release failed" }
}

if ($ForceDependencies -or -not (Test-Path -LiteralPath $vectorExe)) {
    $installedVector = "C:\Program Files\HostEye\vector.exe"
    if (-not $ForceDependencies -and (Test-Path -LiteralPath $installedVector)) {
        Write-Host "Restoring Vector from the currently installed HostEye endpoint."
        Copy-Item -LiteralPath $installedVector -Destination $vectorExe -Force
    } else {
        & (Join-Path $root "vector\fetch-vector.ps1") -Destination $vectorExe -Force:$ForceDependencies
    }
}

if ($ForceDependencies -or -not (Test-Path -LiteralPath $sysmonExe)) {
    $installedSysmon = "C:\Program Files\HostEye\Sysmon"
    if (-not $ForceDependencies -and (Test-Path -LiteralPath (Join-Path $installedSysmon "Sysmon64.exe"))) {
        Write-Host "Restoring Sysmon from the currently installed HostEye endpoint."
        New-Item -ItemType Directory -Force -Path (Join-Path $root "sysmon") | Out-Null
        Copy-Item -Path (Join-Path $installedSysmon "*") -Destination (Join-Path $root "sysmon") -Recurse -Force
    } else {
        & (Join-Path $root "sysmon\fetch-sysmon.ps1") -DestinationDirectory (Join-Path $root "sysmon") -Force:$ForceDependencies
    }
}

if ($ForceDependencies -or -not (Test-Path -LiteralPath $nssmExe)) {
    & (Join-Path $root "shipper\tools\fetch-nssm.ps1") -Destination $nssmExe -Force:$ForceDependencies
}

Assert-File $vectorExe "Vector binary"
Assert-File $sysmonExe "Sysmon binary"
Assert-File $shipperExe "HostEyeShipper binary"
Assert-File $nssmExe "NSSM service wrapper"
Assert-File (Join-Path $root "vector\vector.toml") "Vector configuration"
Assert-File (Join-Path $root "vector\vector.toml.sig") "Vector configuration signature"
Assert-File (Join-Path $root "sysmon\soc-sysmon-config.xml") "HostEye Sysmon configuration"
Assert-File $iscc "Inno Setup compiler"

Write-Host "Validating Vector configuration with the packaged Vector binary..."
& $vectorExe validate --no-environment (Join-Path $root "vector\vector.toml")
if ($LASTEXITCODE -ne 0) { throw "Vector configuration validation failed" }

$generatedSettingsDirectory = Join-Path $root "installer\generated"
New-Item -ItemType Directory -Force -Path $generatedSettingsDirectory | Out-Null
$generatedSettings = Join-Path $generatedSettingsDirectory "$OutputBaseFilename.settings.json"
[ordered]@{
    GatewayUri = $GatewayUri
    ConfigUri = $ConfigUri
    AdmissionUri = $AdmissionUri
    RegistrationUri = $RegistrationUri
    EnrollmentToken = $EnrollmentToken
    BootstrapSigningKey = $BootstrapSigningKey
    StartupJitterWindowSeconds = [Math]::Max(0, $StartupJitterWindowSeconds)
} | ConvertTo-Json | Set-Content -LiteralPath $generatedSettings -Encoding UTF8
Write-Host "Generated installer runtime settings: $generatedSettings"

$iss = Join-Path $root "installer\app_setup.iss"
Write-Host "Compiling installer..."
& $iscc "/DInstallerGatewayUri=$GatewayUri" "/DInstallerConfigUri=$ConfigUri" "/DInstallerAdmissionUri=$AdmissionUri" "/DInstallerRegistrationUri=$RegistrationUri" "/DInstallerBootstrapSigningKey=$BootstrapSigningKey" "/DInstallerStartupJitterWindowSeconds=$([Math]::Max(0, $StartupJitterWindowSeconds))" "/DInstallerOutputBaseFilename=$OutputBaseFilename" "/DInstallerSettingsFile=$generatedSettings" $iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed" }

$installer = Join-Path $root "Output\$OutputBaseFilename.exe"
Assert-File $installer "Compiled installer"
Write-Host "Installer ready: $installer"
