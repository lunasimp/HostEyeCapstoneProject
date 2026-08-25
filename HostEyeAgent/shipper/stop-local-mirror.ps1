$runtime = Join-Path $PSScriptRoot 'runtime\local-mirror'

foreach ($name in 'mirror', 'watcher') {
    $pidFile = Join-Path $runtime "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }

    $processId = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
    if ($processId) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

Write-Output 'HostEye Local Mirror stopped.'
