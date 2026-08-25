[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$deployDir = Join-Path $repoRoot "deploy\cloudflare-tunnel"
$composeFile = Join-Path $deployDir "docker-compose.dashboard-tunnel.yml"
$envFile = Join-Path $deployDir ".env"

$arguments = @("compose", "--project-name", "hosteye-dashboard-tunnel")
if (Test-Path -LiteralPath $envFile) { $arguments += @("--env-file", $envFile) }
$arguments += @("-f", $composeFile, "down")

& docker @arguments
if ($LASTEXITCODE -ne 0) { throw "Cloudflare Tunnel container failed to stop cleanly." }
Write-Host "Cloudflare Tunnel stopped. The local HostEye stack remains running."

