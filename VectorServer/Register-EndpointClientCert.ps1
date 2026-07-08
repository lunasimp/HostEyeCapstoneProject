param(
    [Parameter(Mandatory=$true)]
    [string]$CertPath,

    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$EndpointId,

    [string]$AllowlistPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path

function Resolve-OpenSsl {
    $candidates = @(
        "C:\Program Files\Git\usr\bin\openssl.exe",
        "C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
        "openssl.exe"
    )
    foreach ($candidate in $candidates) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw "OpenSSL not found. Install Git for Windows or OpenSSL and retry."
}

$OpenSSL = Resolve-OpenSsl
if ([string]::IsNullOrWhiteSpace($AllowlistPath)) {
    $AllowlistPath = Join-Path $RepoRoot "Vector-HA-Cluster\certs\client_allowlist.conf"
}

if (-not (Test-Path $OpenSSL)) { throw "OpenSSL not found: $OpenSSL" }
if (-not (Test-Path $CertPath)) { throw "Certificate not found: $CertPath" }

$AllowlistDir = Split-Path -Parent $AllowlistPath
New-Item -ItemType Directory -Force -Path $AllowlistDir | Out-Null

$Serial = (& $OpenSSL x509 -in $CertPath -noout -serial) -replace '^serial=', ''
if ([string]::IsNullOrWhiteSpace($Serial)) { throw "Unable to read certificate serial from $CertPath" }

$Existing = @()
if (Test-Path $AllowlistPath) {
    $Existing = Get-Content -LiteralPath $AllowlistPath | Where-Object {
        ($_ -notmatch "^\s*$([regex]::Escape($Serial))\s+") -and ($_ -notmatch "#\s*$([regex]::Escape($EndpointId))\s*$")
    }
}

$Entry = "$Serial 1; # $EndpointId"
$Content = @(@($Existing) + $Entry) | Where-Object { $_ -ne $null }
Set-Content -LiteralPath $AllowlistPath -Value $Content -Encoding ASCII

Write-Host "Allowed endpoint certificate: $EndpointId"
Write-Host "Serial: $Serial"
Write-Host "Allowlist: $AllowlistPath"
Write-Host "Reload Nginx after changing allowlist: docker exec nginx-load-balancer nginx -s reload"
