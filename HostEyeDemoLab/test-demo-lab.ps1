[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json"),
    [switch]$SkipGuestChecks
)

. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-HostEyeDemoConfig -ConfigPath $ConfigPath

Write-Host "Docker containers:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

Write-Host "Testing gateway 443..."
Test-NetConnection localhost -Port 443

Write-Host "Testing HostEye API..."
$health = Wait-HostEyeApi -Config $config
$health | ConvertTo-Json

if (-not $SkipGuestChecks) {
    foreach ($vmName in (Get-HostEyeVmNames -Config $config)) {
        Write-Host "Guest check: $vmName"
        Test-HostEyeAgentInVm -Config $config -VmName $vmName
    }
}
