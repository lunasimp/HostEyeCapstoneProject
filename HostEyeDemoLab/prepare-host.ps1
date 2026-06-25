[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.demo.json")
)

. (Join-Path $PSScriptRoot "Common.ps1")

$config = Read-HostEyeDemoConfig -ConfigPath $ConfigPath
$vbox = Resolve-VBoxManage
Write-Host "VBoxManage: $vbox"

if (-not (Test-VBoxVmExists -Name $config.TemplateVmName)) {
    throw "Template VM not found: $($config.TemplateVmName)"
}

$installer = Resolve-HostEyeInstaller -Config $config
if (-not (Test-Path -LiteralPath $installer)) {
    Write-Warning "HostEye installer not found yet: $installer"
} else {
    Write-Host "Installer: $installer"
}

docker ps *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker is not available. Start Docker Desktop first."
}
Write-Host "Docker is available."

Write-Host "Config OK for $($config.VmCount) VM(s), $($config.VmMemoryMB)MB RAM each."

