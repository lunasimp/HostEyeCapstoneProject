param(
    [switch]$RemoveData,
    [switch]$RemoveSysmon
)

$ErrorActionPreference = "SilentlyContinue"
$targetDir = "C:\Program Files\HostEye"
$programData = "C:\ProgramData\HostEye"
$nssm = Join-Path $targetDir "HostEyeShipper\tools\nssm.exe"

foreach ($task in @("HostEye_Agent_Startup", "HostEye_Shipper_Startup", "HostEye_Agent_Updater", "HostEye_Dynamic_Config_Sync", "SOC_Vector_Startup", "SOC_Shipper_Startup", "SOC_Agent_Updater")) {
    Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
}

if ((Test-Path -LiteralPath $nssm) -and (Get-Service -Name "HostEyeShipper" -ErrorAction SilentlyContinue)) {
    & $nssm stop HostEyeShipper confirm | Out-Null
    & $nssm remove HostEyeShipper confirm | Out-Null
}
foreach ($service in @("HostEyeLocalMirror", "HostEyeShipper", "HostEyeAgent", "SOCShipper", "Vector")) {
    Stop-Service -Name $service -Force -ErrorAction SilentlyContinue
    sc.exe delete $service | Out-Null
}
foreach ($process in @("HostEyeShipper", "hosteye-shipper", "vector")) {
    Get-Process -Name $process -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($RemoveSysmon) {
    $sysmon = Join-Path $targetDir "Sysmon\Sysmon64.exe"
    if (Test-Path -LiteralPath $sysmon) { & $sysmon -u force | Out-Null }
}

if ($RemoveData -and (Test-Path -LiteralPath $programData)) {
    Remove-Item -LiteralPath $programData -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "HostEye endpoint services and scheduled tasks were removed."
