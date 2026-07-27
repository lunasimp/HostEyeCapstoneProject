param(
    [string]$SourceDir = (Resolve-Path "$PSScriptRoot\..\..\VectorBuild").Path,
    [string]$GatewayUri = "https://agent.hosteye.iahn.hanoi.vn/api/v1/telemetry",
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$WxsPath = Join-Path $PSScriptRoot "HostEyeBootstrap.wxs"
$OutputDir = Join-Path $PSScriptRoot "bin\$Configuration"
$OutputMsi = Join-Path $OutputDir "HostEyeBootstrap.msi"

$requiredFiles = @(
    "vector.exe",
    "vector.toml",
    "vector.toml.sig",
    "collector-policy.json",
    "install.ps1",
    "SOC_Updater.ps1",
    "SOCShipper\publish\HostEyeShipper.exe",
    "SOCShipper\publish\shipper-config.json",
    "HostEyeConfigAgent\HostEye_ConfigAgent.ps1",
    "HostEyeConfigAgent\hosteye-config-client.exe",
    "certs\company_ca.crt",
    "certs\client.crt",
    "certs\client.key",
    "Sysmon\Eula.txt",
    "Sysmon\soc-sysmon-config.xml"
)

$missing = @()
foreach ($relative in $requiredFiles) {
    $path = Join-Path $SourceDir $relative
    if (-not (Test-Path -LiteralPath $path)) { $missing += $relative }
}

if ($missing.Count -gt 0) {
    Write-Host "[HostEye MSI] Missing input files in $SourceDir" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    throw "MSI input validation failed. Build/publish the agent payload first."
}

$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
    Write-Host "[HostEye MSI] WiX CLI was not found." -ForegroundColor Yellow
    Write-Host "Install option: dotnet tool install --global wix" -ForegroundColor Yellow
    throw "WiX CLI is required to build HostEyeBootstrap.msi."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Write-Host "[HostEye MSI] Building with SourceDir=$SourceDir"
wix build $WxsPath -arch x64 -d SourceDir="$SourceDir" -d GatewayUri="$GatewayUri" -o $OutputMsi
if ($LASTEXITCODE -ne 0) { throw "WiX build failed with exit code $LASTEXITCODE" }
Write-Host "[HostEye MSI] Built $OutputMsi"





