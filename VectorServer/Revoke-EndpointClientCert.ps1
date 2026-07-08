param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$EndpointId,

    [string]$AllowlistPath = "",
    [switch]$ReloadNginx
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($AllowlistPath)) {
    $AllowlistPath = Join-Path $RepoRoot "Vector-HA-Cluster\certs\client_allowlist.conf"
}

if (-not (Test-Path $AllowlistPath)) {
    Write-Host "Allowlist does not exist: $AllowlistPath"
    return
}

$Before = Get-Content -LiteralPath $AllowlistPath
$After = $Before | Where-Object { $_ -notmatch "#\s*$([regex]::Escape($EndpointId))\s*$" }
Set-Content -LiteralPath $AllowlistPath -Value $After -Encoding ASCII

$Removed = $Before.Count - $After.Count
Write-Host "Revoked endpoint: $EndpointId"
Write-Host "Removed entries: $Removed"

if ($ReloadNginx) {
    docker exec nginx-load-balancer nginx -s reload
}
