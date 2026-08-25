param(
    [string]$ServiceName = 'HostEyeLocalMirror'
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ServiceName `"$ServiceName`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
    return
}

$nssm = Join-Path $PSScriptRoot 'tools\nssm.exe'
if (-not (Test-Path -LiteralPath $nssm)) { throw "NSSM not found: $nssm" }

& $nssm stop $ServiceName confirm
& $nssm remove $ServiceName confirm
Write-Output "Removed Windows Service: $ServiceName"
