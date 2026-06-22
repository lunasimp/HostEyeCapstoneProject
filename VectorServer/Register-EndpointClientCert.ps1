param(
    [Parameter(Mandatory=$true)]
    [string]$CertPath,

    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$EndpointId,

    [string]$AllowlistPath = "C:\Vector-HA-Cluster\certs\client_allowlist.conf"
)

$ErrorActionPreference = "Stop"
$OpenSSL = "C:\Program Files\Git\usr\bin\openssl.exe"

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
$Content = @($Existing + $Entry) | Where-Object { $_ -ne $null }
Set-Content -LiteralPath $AllowlistPath -Value $Content -Encoding ASCII

Write-Host "Allowed endpoint certificate: $EndpointId"
Write-Host "Serial: $Serial"
Write-Host "Allowlist: $AllowlistPath"
Write-Host "Reload Nginx after changing allowlist: docker exec nginx-load-balancer nginx -s reload"
