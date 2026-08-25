$out = "C:\VectorBuild\Sysmon\check-sysmon-specific-output.csv"
$events = Get-WinEvent -LogName "Microsoft-Windows-Sysmon/Operational" -MaxEvents 1000
$summary = $events | Group-Object Id | Sort-Object {[int]$_.Name} | ForEach-Object { [pscustomobject]@{Id=$_.Name; Count=$_.Count} }
$specific = $events | Where-Object { $_.Id -in 1,3,22 } | Select-Object -First 30 TimeCreated,Id,@{n='MessageOneLine';e={($_.Message -replace "`r`n", " | ")}}
"SUMMARY" | Out-File $out -Encoding utf8
$summary | ConvertTo-Csv -NoTypeInformation | Out-File $out -Append -Encoding utf8
"SPECIFIC" | Out-File $out -Append -Encoding utf8
$specific | ConvertTo-Csv -NoTypeInformation | Out-File $out -Append -Encoding utf8