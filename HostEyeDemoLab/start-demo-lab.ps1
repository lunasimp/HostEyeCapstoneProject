[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json"),
    [switch]$SkipPipeline,
    [switch]$SkipVmInstall
)

. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-HostEyeDemoConfig -ConfigPath $ConfigPath
$vmNames = Get-HostEyeVmNames -Config $config

if (-not $SkipPipeline) {
    Start-HostEyeServerPipeline -Config $config
    Start-HostEyeDashboardProcesses -Config $config
    Wait-HostEyeApi -Config $config | Out-Null
}

foreach ($vmName in $vmNames) {
    New-HostEyeVmClone -Config $config -VmName $vmName
}

foreach ($vmName in $vmNames) {
    Start-HostEyeVm -VmName $vmName
}

if (-not $SkipVmInstall) {
    Write-Host "Waiting 60 seconds for guest OS boot before installing HostEye Agent..."
    Start-Sleep -Seconds 60
    foreach ($vmName in $vmNames) {
        Install-HostEyeAgentInVm -Config $config -VmName $vmName
    }
}

Write-Host "HostEye demo lab start sequence completed."
Write-Host "Dashboard: http://localhost:$($config.DashboardWebPort)"
Write-Host "Grafana:   http://localhost:3000"
