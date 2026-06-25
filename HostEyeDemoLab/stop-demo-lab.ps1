[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json")
)

. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-HostEyeDemoConfig -ConfigPath $ConfigPath
foreach ($vmName in (Get-HostEyeVmNames -Config $config)) {
    Stop-HostEyeVm -VmName $vmName
}

Write-Host "Stop signal sent to HostEye demo VMs."
