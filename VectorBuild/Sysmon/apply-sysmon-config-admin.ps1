$ErrorActionPreference = "Continue"
$out = "C:\VectorBuild\Sysmon\apply-sysmon-config-output.txt"
"=== $(Get-Date -Format o) apply config ===" | Out-File -FilePath $out -Encoding utf8
& "C:\Windows\Sysmon64.exe" -c "C:\VectorBuild\Sysmon\soc-sysmon-config.xml" *>&1 | Out-File -FilePath $out -Append -Encoding utf8
"=== $(Get-Date -Format o) dump active config ===" | Out-File -FilePath $out -Append -Encoding utf8
& "C:\Windows\Sysmon64.exe" -c *>&1 | Out-File -FilePath $out -Append -Encoding utf8
"=== service ===" | Out-File -FilePath $out -Append -Encoding utf8
Get-Service Sysmon64 | Format-List * | Out-File -FilePath $out -Append -Encoding utf8