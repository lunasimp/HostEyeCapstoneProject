param(
    [string]$PublicBaseUrl = "https://hosteye.csp.vn",
    [int]$StartupJitterWindowSeconds = 300,
    [string]$OutputBaseFilename = "HostEye_Endpoint_Installer_Public_CSP"
)

$ErrorActionPreference = "Stop"
$baseUrl = $PublicBaseUrl.TrimEnd('/')
if (-not [Uri]::IsWellFormedUriString($baseUrl, [UriKind]::Absolute)) {
    throw "PublicBaseUrl must be an absolute HTTPS URL."
}
$uri = [Uri]$baseUrl
if ($uri.Scheme -ne "https") {
    throw "Public installer endpoints must use HTTPS."
}

& (Join-Path $PSScriptRoot "build-installer.ps1") `
    -GatewayUri "$baseUrl/api/v1/telemetry/collector-a" `
    -ConfigUri "$baseUrl/api/v1/agent/config" `
    -AdmissionUri "$baseUrl/api/v1/admission/request" `
    -RegistrationUri "$baseUrl/api/v1/enroll" `
    -StartupJitterWindowSeconds $StartupJitterWindowSeconds `
    -OutputBaseFilename $OutputBaseFilename

if ($LASTEXITCODE -ne 0) {
    throw "Public installer build failed with exit code $LASTEXITCODE."
}
