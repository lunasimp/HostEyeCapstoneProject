$ErrorActionPreference = "Stop"
$configPath = "C:\VectorBuild\Sysmon\soc-sysmon-config.xml"
$sysmon = "C:\VectorBuild\Sysmon\Sysmon64.exe"

Write-Host "Installing Sysmon with SOC baseline config..." -ForegroundColor Cyan
& $sysmon -accepteula -i $configPath

Write-Host "`nSysmon service:" -ForegroundColor Cyan
Get-Service -Name Sysmon64,Sysmon -ErrorAction SilentlyContinue | Select-Object Name,DisplayName,Status,StartType | Format-Table -AutoSize

Write-Host "`nRecent Sysmon events:" -ForegroundColor Cyan
Get-WinEvent -LogName "Microsoft-Windows-Sysmon/Operational" -MaxEvents 5 | Select-Object TimeCreated,Id,ProviderName | Format-Table -AutoSize