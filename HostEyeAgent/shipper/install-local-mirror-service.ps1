param(
    [string]$ServiceName = 'HostEyeLocalMirror'
)

$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ServiceName `"$ServiceName`""
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs
    return
}

$nssm = Join-Path $PSScriptRoot 'tools\nssm.exe'
$supervisor = Join-Path $PSScriptRoot 'run-local-mirror-service.ps1'
$runtime = Join-Path $PSScriptRoot 'runtime\local-mirror'
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $nssm)) { throw "NSSM not found: $nssm" }
if (-not (Test-Path -LiteralPath $supervisor)) { throw "Service supervisor not found: $supervisor" }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

& (Join-Path $PSScriptRoot 'stop-local-mirror.ps1') | Out-Null
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existingService) {
    & $nssm stop $ServiceName confirm | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

& $nssm install $ServiceName $powerShellExe
if ($LASTEXITCODE -ne 0) { throw "Unable to install $ServiceName" }

& $nssm set $ServiceName AppParameters "-NoProfile -ExecutionPolicy Bypass -File `"$supervisor`""
& $nssm set $ServiceName AppDirectory $PSScriptRoot
& $nssm set $ServiceName DisplayName 'HostEye Local Mirror Shipper'
& $nssm set $ServiceName Description 'Mirrors new HostEye durable spool chunks to the localhost control/data plane without changing the DNS spool.'
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm set $ServiceName AppThrottle 1500
& $nssm set $ServiceName AppKillProcessTree 1
& $nssm set $ServiceName AppStdout (Join-Path $runtime 'service.stdout.log')
& $nssm set $ServiceName AppStderr (Join-Path $runtime 'service.stderr.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760

$agentId = [Environment]::GetEnvironmentVariable('HOSTEYE_AGENT_ID', 'Process')
$hostId = [Environment]::GetEnvironmentVariable('HOSTEYE_HOST_ID', 'Process')

if (-not $agentId -or -not $hostId) {
    $sampleChunk = Get-ChildItem 'C:\ProgramData\HostEye\spool' -Filter 'chunk_*.gz' -File | Select-Object -First 1
    if ($null -ne $sampleChunk) {
        $fileStream = $null
        $gzipStream = $null
        $reader = $null
        try {
            $fileStream = [System.IO.File]::OpenRead($sampleChunk.FullName)
            $gzipStream = [System.IO.Compression.GZipStream]::new($fileStream, [System.IO.Compression.CompressionMode]::Decompress)
            $reader = [System.IO.StreamReader]::new($gzipStream)
            $payload = $reader.ReadToEnd() | ConvertFrom-Json
            if (-not $agentId) { $agentId = $payload.agent_id }
            if (-not $hostId) { $hostId = $payload.host_id }
        } finally {
            if ($null -ne $reader) { $reader.Dispose() }
            elseif ($null -ne $gzipStream) { $gzipStream.Dispose() }
            elseif ($null -ne $fileStream) { $fileStream.Dispose() }
        }
    }
}

if (-not $agentId -or -not $hostId) { throw 'Unable to determine HostEye agent_id/host_id for the service environment.' }

$environment = @(
    "HOSTEYE_AGENT_ID=$agentId",
    "HOSTEYE_HOST_ID=$hostId",
    "VECTOR_AGENT_ID=$agentId",
    "VECTOR_HOST_ID=$hostId"
)
if ($environment.Count -gt 0) {
    & $nssm set $ServiceName AppEnvironmentExtra @environment
}

sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/30000 | Out-Null
& $nssm start $ServiceName
if ($LASTEXITCODE -ne 0) { throw "Installed $ServiceName but could not start it" }

Start-Sleep -Seconds 5
sc.exe query $ServiceName
Write-Output "Installed Windows Service: $ServiceName"
