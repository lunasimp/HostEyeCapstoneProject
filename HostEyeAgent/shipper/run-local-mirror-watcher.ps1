param(
    [string]$Source = 'C:\ProgramData\HostEye\spool',
    [string]$Destination = "$PSScriptRoot\runtime\local-mirror\spool",
    [string]$LogFile = "$PSScriptRoot\runtime\local-mirror\watcher.log"
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format o) watcher_started source=$Source destination=$Destination"

$watcher = [System.IO.FileSystemWatcher]::new($Source, 'chunk_*.gz')
$watcher.IncludeSubdirectories = $false
$watcher.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite, Size'
$watcher.EnableRaisingEvents = $true

$messageData = @{ Destination = $Destination; LogFile = $LogFile }
$copyAction = {
    $sourcePath = $Event.SourceEventArgs.FullPath
    $destinationDir = $Event.MessageData.Destination
    $logPath = $Event.MessageData.LogFile
    $destinationPath = Join-Path $destinationDir ([System.IO.Path]::GetFileName($sourcePath))
    $partialPath = "$destinationPath.partial"

    if (Test-Path -LiteralPath $destinationPath) { return }

    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try {
            if (-not (Test-Path -LiteralPath $sourcePath)) { return }
            $firstLength = (Get-Item -LiteralPath $sourcePath).Length
            Start-Sleep -Milliseconds 250
            $secondLength = (Get-Item -LiteralPath $sourcePath).Length
            if ($firstLength -le 0 -or $firstLength -ne $secondLength) { continue }

            Copy-Item -LiteralPath $sourcePath -Destination $partialPath -Force
            Move-Item -LiteralPath $partialPath -Destination $destinationPath -Force
            Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) staged=$([System.IO.Path]::GetFileName($sourcePath)) bytes=$secondLength"
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) stage_failed=$sourcePath"
}

$created = Register-ObjectEvent -InputObject $watcher -EventName Created -MessageData $messageData -Action $copyAction
$renamed = Register-ObjectEvent -InputObject $watcher -EventName Renamed -MessageData $messageData -Action $copyAction

try {
    while ($true) {
        Wait-Event -Timeout 5 | Remove-Event -ErrorAction SilentlyContinue
    }
} finally {
    Unregister-Event -SourceIdentifier $created.Name -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier $renamed.Name -ErrorAction SilentlyContinue
    $watcher.Dispose()
}
