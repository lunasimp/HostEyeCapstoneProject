$out = "C:\VectorBuild\Sysmon\check-sysmon-events-output.txt"
"=== $(Get-Date -Format o) recent Sysmon ===" | Out-File $out -Encoding utf8
Get-WinEvent -LogName "Microsoft-Windows-Sysmon/Operational" -MaxEvents 50 |
  Select-Object TimeCreated,Id,@{n="FirstLine";e={($_.Message -split "`r?`n")[0]}} |
  Format-Table -AutoSize | Out-File $out -Append -Encoding utf8
"=== grouped ===" | Out-File $out -Append -Encoding utf8
Get-WinEvent -LogName "Microsoft-Windows-Sysmon/Operational" -MaxEvents 200 |
  Group-Object Id | Sort-Object Count -Descending |
  Select-Object Name,Count | Format-Table -AutoSize | Out-File $out -Append -Encoding utf8