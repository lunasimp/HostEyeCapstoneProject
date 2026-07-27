param(
    [string]$SourceDir = (Resolve-Path "$PSScriptRoot\..\..\VectorBuild").Path,
    [string]$GatewayUri = "https://agent.hosteye.iahn.hanoi.vn/api/v1/telemetry",
    [string]$Configuration = "Release",
    [Parameter(Mandatory = $true)]
    [string]$CertificateThumbprint,
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

$signScript = Resolve-Path "$PSScriptRoot\..\CodeSigning\Sign-HostEyeArtifacts.ps1"
$buildScript = Resolve-Path "$PSScriptRoot\build-msi.ps1"
$outputMsi = Join-Path $PSScriptRoot "bin\$Configuration\HostEyeBootstrap.msi"

Write-Host "[HostEye MSI] Signing payload before MSI packaging"
& $signScript `
    -SourceDir $SourceDir `
    -CertificateThumbprint $CertificateThumbprint `
    -TimestampServer $TimestampServer

Write-Host "[HostEye MSI] Building MSI"
& $buildScript `
    -SourceDir $SourceDir `
    -GatewayUri $GatewayUri `
    -Configuration $Configuration

Write-Host "[HostEye MSI] Signing MSI"
& $signScript `
    -SourceDir $SourceDir `
    -MsiPath $outputMsi `
    -CertificateThumbprint $CertificateThumbprint `
    -TimestampServer $TimestampServer

Write-Host "[HostEye MSI] Signed MSI ready: $outputMsi"

