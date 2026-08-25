$ErrorActionPreference = 'Stop'

$runtime = Join-Path $PSScriptRoot 'runtime\local-mirror'
$shipper = Join-Path $PSScriptRoot 'target\release\hosteye-shipper.exe'
$config = Join-Path $PSScriptRoot 'shipper-config.local.json'
$watcherScript = Join-Path $PSScriptRoot 'run-local-mirror-watcher.ps1'

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'spool') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'state') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $runtime 'logs') | Out-Null

function Test-RunningPidFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $processId = Get-Content -LiteralPath $path -ErrorAction SilentlyContinue
    return [bool](Get-Process -Id $processId -ErrorAction SilentlyContinue)
}

$watcherPidFile = Join-Path $runtime 'watcher.pid'
if (-not (Test-RunningPidFile $watcherPidFile)) {
    $watcher = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watcherScript) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'watcher.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'watcher.stderr.log') `
        -PassThru
    Set-Content -LiteralPath $watcherPidFile -Value $watcher.Id
}

$mirrorPidFile = Join-Path $runtime 'mirror.pid'
if (-not (Test-RunningPidFile $mirrorPidFile)) {
    $mirror = Start-Process -FilePath $shipper `
        -ArgumentList @($config) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'stderr.log') `
        -PassThru
    Set-Content -LiteralPath $mirrorPidFile -Value $mirror.Id
}

Write-Output "HostEye Local Mirror is running. Runtime: $runtime"
