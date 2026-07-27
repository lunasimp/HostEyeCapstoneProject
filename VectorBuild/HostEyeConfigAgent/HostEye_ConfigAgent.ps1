param(
    [string]$ServerUri = "https://agent.hosteye.iahn.hanoi.vn",
    [string]$GroupId = "",
    [int]$PollJitterWindowSeconds = 60,
    [string]$ApplyMode = "apply"
)

$ErrorActionPreference = "Stop"

$ProgramDataDir = "C:\ProgramData\HostEye"
$OutputDir = Join-Path $ProgramDataDir "dynamic-config"
$LogDir = Join-Path $ProgramDataDir "logs"
$LogPath = Join-Path $LogDir "config-agent.log"
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClientExe = Join-Path $AgentDir "hosteye-config-client.exe"
$IdentityPath = Join-Path $ProgramDataDir "identity.json"
$AgentVersionPath = "C:\Program Files\HostEye\agent.version"

function Write-ConfigAgentLog([string]$Message) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
}

function Get-StableJitterSeconds([string]$Seed, [int]$WindowSeconds) {
    if ($WindowSeconds -le 0) { return 0 }
    if ([string]::IsNullOrWhiteSpace($Seed)) { $Seed = [guid]::NewGuid().ToString("n") }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Seed))
        $value = [BitConverter]::ToUInt32($hash, 0)
        return [int]($value % [uint32]$WindowSeconds)
    } finally {
        $sha.Dispose()
    }
}

function Get-IdentityValue([object]$Identity, [string]$PropertyName, [string]$EnvName, [string]$DefaultValue) {
    $fromIdentity = $null
    if ($Identity -and $Identity.PSObject.Properties.Name -contains $PropertyName) {
        $fromIdentity = [string]$Identity.$PropertyName
    }
    if (-not [string]::IsNullOrWhiteSpace($fromIdentity)) { return $fromIdentity }

    $fromMachineEnv = [Environment]::GetEnvironmentVariable($EnvName, "Machine")
    if (-not [string]::IsNullOrWhiteSpace($fromMachineEnv)) { return $fromMachineEnv }

    $fromProcessEnv = [Environment]::GetEnvironmentVariable($EnvName, "Process")
    if (-not [string]::IsNullOrWhiteSpace($fromProcessEnv)) { return $fromProcessEnv }

    return $DefaultValue
}

try {
    New-Item -ItemType Directory -Force -Path $OutputDir, $LogDir | Out-Null

    if (-not (Test-Path -LiteralPath $ClientExe)) {
        Write-ConfigAgentLog "ERROR: hosteye-config-client.exe not found at $ClientExe. Dynamic config sync cannot run."
        exit 2
    }

    $identity = $null
    if (Test-Path -LiteralPath $IdentityPath) {
        try {
            $identity = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
        } catch {
            Write-ConfigAgentLog "WARNING: failed to parse identity.json: $($_.Exception.Message)"
        }
    }

    $machineGuid = ""
    try { $machineGuid = (Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid).MachineGuid } catch {}
    if ([string]::IsNullOrWhiteSpace($machineGuid)) { $machineGuid = [guid]::NewGuid().ToString("n") }

    $agentId = Get-IdentityValue $identity "agent_id" "HOSTEYE_AGENT_ID" "hosteye-agent-$machineGuid"
    $hostId = Get-IdentityValue $identity "host_id" "HOSTEYE_HOST_ID" "hosteye-host-$machineGuid"
    $resolvedGroupId = $GroupId
    if ([string]::IsNullOrWhiteSpace($resolvedGroupId)) {
        $resolvedGroupId = Get-IdentityValue $identity "group_id" "HOSTEYE_GROUP_ID" "default"
    }
    $identitySecret = Get-IdentityValue $identity "agent_identity_secret" "HOSTEYE_DYNAMIC_CONFIG_AGENT_IDENTITY_SECRET" "hosteye-agent-identity-demo-secret"
    $agentVersion = "1.0.0"
    if (Test-Path -LiteralPath $AgentVersionPath) {
        $agentVersion = (Get-Content -LiteralPath $AgentVersionPath -TotalCount 1).Trim()
    }

    $seed = "$agentId|$hostId|dynamic-config"
    $jitter = Get-StableJitterSeconds -Seed $seed -WindowSeconds $PollJitterWindowSeconds
    if ($jitter -gt 0) {
        Write-ConfigAgentLog "Applying config poll jitter: $jitter seconds in $PollJitterWindowSeconds-second window."
        Start-Sleep -Seconds $jitter
    }

    $env:HOSTEYE_CONFIG_SERVER_URL = $ServerUri
    $env:HOSTEYE_AGENT_ID = $agentId
    $env:HOSTEYE_HOST_ID = $hostId
    $env:HOSTEYE_GROUP_ID = $resolvedGroupId
    $env:HOSTEYE_AGENT_VERSION = $agentVersion
    $env:HOSTEYE_CONFIG_OUTPUT_DIR = $OutputDir
    $env:HOSTEYE_CONFIG_STATE_PATH = Join-Path $OutputDir "state.json"
    $env:HOSTEYE_APPLIED_POLICY_PATH = Join-Path $OutputDir "applied-policy.json"
    $env:HOSTEYE_VECTOR_DYNAMIC_PATH = Join-Path $OutputDir "vector-dynamic.toml"
    $env:HOSTEYE_CONFIG_BACKUP_DIR = Join-Path $OutputDir "backups"
    $env:HOSTEYE_CONFIG_APPLY_MODE = $ApplyMode
    $env:HOSTEYE_CONFIG_ONCE = "true"
    $env:HOSTEYE_DYNAMIC_CONFIG_AGENT_IDENTITY_SECRET = $identitySecret

    Write-ConfigAgentLog "Polling dynamic config. server=$ServerUri agent=$agentId host=$hostId group=$resolvedGroupId apply_mode=$ApplyMode"
    $output = & $ClientExe 2>&1
    $exitCode = $LASTEXITCODE
    if ($output) {
        foreach ($line in $output) {
            Write-ConfigAgentLog "client: $line"
        }
    }
    if ($exitCode -ne 0) {
        Write-ConfigAgentLog "ERROR: hosteye-config-client exited with code $exitCode"
        exit $exitCode
    }

    Write-ConfigAgentLog "Dynamic config sync completed."
    exit 0
} catch {
    Write-ConfigAgentLog "ERROR: $($_.Exception.Message)"
    exit 1
}
