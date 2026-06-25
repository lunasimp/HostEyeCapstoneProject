[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json"),
    [switch]$Force
)

. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-HostEyeDemoConfig -ConfigPath $ConfigPath
foreach ($vmName in (Get-HostEyeVmNames -Config $config)) {
    if ($Force -or $PSCmdlet.ShouldProcess($vmName, "Delete linked clone VM")) {
        Remove-HostEyeVmClone -VmName $vmName
    }
}

Write-Host "HostEye demo VM clones reset completed."
