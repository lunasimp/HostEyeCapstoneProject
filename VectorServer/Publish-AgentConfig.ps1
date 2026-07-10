param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "HostEye_UpdateServer\master-vector.toml"),
    [string]$Version,
    [string]$MinimumAgentVersion = "1.0.0",
    [string]$OpenSsl = "",
    [string]$PrivateKey = (Join-Path $PSScriptRoot "organization_private.pem"),
    [string]$UpdateServerDir = (Join-Path $PSScriptRoot "HostEye_UpdateServer")
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OpenSsl)) {
    $OpenSslCandidates = @(
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        "openssl.exe"
    )
    $OpenSsl = $OpenSslCandidates | Where-Object {
        if ($_ -eq "openssl.exe") {
            $null -ne (Get-Command $_ -ErrorAction SilentlyContinue)
        } else {
            Test-Path -LiteralPath $_
        }
    } | Select-Object -First 1
}
$ManifestPath = Join-Path $UpdateServerDir "manifest.json"
$ManifestSigPath = Join-Path $UpdateServerDir "manifest.json.sig"
$ConfigSigPath = Join-Path $UpdateServerDir "master-vector.toml.sig"

if (-not (Test-Path -LiteralPath $OpenSsl)) { throw "OpenSSL not found: $OpenSsl" }
if (-not (Test-Path -LiteralPath $PrivateKey)) { throw "Release private key not found: $PrivateKey" }
if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Config not found: $ConfigPath" }
New-Item -ItemType Directory -Force -Path $UpdateServerDir | Out-Null

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = Get-Date -Format "yyyy.MM.dd.HHmmss"
}

$hash = (Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
    version = $Version
    file = "vector.toml"
    sha256 = $hash
    created_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    signature = "manifest.json.sig"
    config_signature = "vector.toml.sig"
    minimum_agent_version = $MinimumAgentVersion
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding ASCII

& $OpenSsl dgst -sha256 -sign $PrivateKey -out $ManifestSigPath $ManifestPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to sign manifest.json" }

# Legacy compatibility for agents that still verify vector.toml.sig directly.
& $OpenSsl dgst -sha256 -sign $PrivateKey -out $ConfigSigPath $ConfigPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to sign master-vector.toml" }

Write-Host "Published agent config manifest: $ManifestPath"
Write-Host "Version: $Version"
Write-Host "SHA256: $hash"
