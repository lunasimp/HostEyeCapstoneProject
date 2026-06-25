# HostEye Agent secured configuration updater.
# Runs as SYSTEM. Applies config updates only after release signature, hash,
# version, syntax validation, backup, and health checks pass.

$ErrorActionPreference = "Stop"

$TargetDir = "C:\Program Files\HostEye"
$ProgramDataDir = "C:\ProgramData\HostEye"
$BackupDir = Join-Path $ProgramDataDir "config-backups"
$PublicKeyPath = Join-Path $TargetDir "certs\updater_public.pem"
$UpdateUrl = "https://soc-gateway.yourcorporate.com/api/v1/agent/config"
$VectorExe = Join-Path $TargetDir "vector.exe"
$ActiveConfig = Join-Path $TargetDir "vector.toml"
$VersionState = Join-Path $ProgramDataDir "config.version"
$LogDir = Join-Path $ProgramDataDir "logs"
$LogPath = Join-Path $LogDir "updater.log"

$TmpRoot = Join-Path $env:TEMP ("hosteye-agent-update-" + [guid]::NewGuid().ToString("N"))
$TmpManifest = Join-Path $TmpRoot "manifest.json"
$TmpManifestSig = Join-Path $TmpRoot "manifest.json.sig"
$TmpConfig = Join-Path $TmpRoot "vector.toml"
$TmpConfigSig = Join-Path $TmpRoot "vector.toml.sig"

New-Item -ItemType Directory -Force -Path $LogDir, $BackupDir, $TmpRoot | Out-Null

function Write-UpdateLog([string]$Message) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $LogPath -Value "$ts $Message"
}

function Remove-TempFiles {
    Remove-Item -LiteralPath $TmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CurrentVersion {
    if (Test-Path -LiteralPath $VersionState) {
        return ((Get-Content -LiteralPath $VersionState -Raw).Trim())
    }
    return "0.0.0"
}

function Test-VersionGreater([string]$Candidate, [string]$Current) {
    try { return ([version]$Candidate -gt [version]$Current) } catch { return ($Candidate -ne $Current) }
}

function Test-MinimumAgentVersion([string]$Minimum) {
    if ([string]::IsNullOrWhiteSpace($Minimum)) { return $true }
    $localVersion = "1.0.0"
    $versionFile = Join-Path $TargetDir "agent.version"
    if (Test-Path -LiteralPath $versionFile) {
        $localVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
    }
    try { return ([version]$localVersion -ge [version]$Minimum) } catch { return $true }
}

$VerifierSource = @"
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

public static class HostEyeSignatureVerifier
{
    private static int ReadLength(byte[] data, ref int offset)
    {
        int length = data[offset++];
        if ((length & 0x80) == 0) return length;
        int count = length & 0x7f;
        length = 0;
        for (int i = 0; i < count; i++) length = (length << 8) + data[offset++];
        return length;
    }

    private static void Expect(byte[] data, ref int offset, byte tag)
    {
        if (data[offset++] != tag) throw new CryptographicException("Unexpected ASN.1 tag");
    }

    private static byte[] ReadInteger(byte[] data, ref int offset)
    {
        Expect(data, ref offset, 0x02);
        int length = ReadLength(data, ref offset);
        byte[] value = new byte[length];
        Buffer.BlockCopy(data, offset, value, 0, length);
        offset += length;
        if (value.Length > 1 && value[0] == 0x00)
        {
            byte[] trimmed = new byte[value.Length - 1];
            Buffer.BlockCopy(value, 1, trimmed, 0, trimmed.Length);
            return trimmed;
        }
        return value;
    }

    private static byte[] PemToDer(string pemPath)
    {
        string pem = File.ReadAllText(pemPath);
        string b64 = Regex.Replace(pem, "-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\\s", "");
        return Convert.FromBase64String(b64);
    }

    private static RSAParameters ReadSubjectPublicKeyInfo(byte[] spki)
    {
        int o = 0;
        Expect(spki, ref o, 0x30);
        ReadLength(spki, ref o);

        Expect(spki, ref o, 0x30);
        int algLen = ReadLength(spki, ref o);
        o += algLen;

        Expect(spki, ref o, 0x03);
        int bitLen = ReadLength(spki, ref o);
        o++;

        byte[] rsaPub = new byte[bitLen - 1];
        Buffer.BlockCopy(spki, o, rsaPub, 0, rsaPub.Length);

        int r = 0;
        Expect(rsaPub, ref r, 0x30);
        ReadLength(rsaPub, ref r);

        RSAParameters p = new RSAParameters();
        p.Modulus = ReadInteger(rsaPub, ref r);
        p.Exponent = ReadInteger(rsaPub, ref r);
        return p;
    }

    public static bool Verify(string publicKeyPath, string dataPath, string signaturePath)
    {
        byte[] der = PemToDer(publicKeyPath);
        RSAParameters p = ReadSubjectPublicKeyInfo(der);
        byte[] data = File.ReadAllBytes(dataPath);
        byte[] sig = File.ReadAllBytes(signaturePath);

        using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider())
        {
            rsa.ImportParameters(p);
            return rsa.VerifyData(data, CryptoConfig.MapNameToOID("SHA256"), sig);
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $VerifierSource -Language CSharp -ErrorAction Stop
} catch {
    Write-UpdateLog "Signature verifier initialization failed: $($_.Exception.Message)"
    Remove-TempFiles
    exit 0
}

function Test-Signature([string]$DataPath, [string]$SignaturePath) {
    if (-not (Test-Path -LiteralPath $PublicKeyPath)) {
        Write-UpdateLog "Public release verification key missing: $PublicKeyPath"
        return $false
    }
    if (-not (Test-Path -LiteralPath $DataPath) -or -not (Test-Path -LiteralPath $SignaturePath)) {
        return $false
    }
    try { return [HostEyeSignatureVerifier]::Verify($PublicKeyPath, $DataPath, $SignaturePath) } catch {
        Write-UpdateLog "Signature verification error: $($_.Exception.Message)"
        return $false
    }
}

function Test-VectorConfig([string]$ConfigPath) {
    if (-not (Test-Path -LiteralPath $VectorExe)) {
        Write-UpdateLog "HostEye collector executable missing; cannot validate config: $VectorExe"
        return $false
    }
    $output = & $VectorExe validate --no-environment $ConfigPath 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-UpdateLog "HostEye config validation failed: $($output -join ' ')"
        return $false
    }
    return $true
}

function Test-VectorServiceHealthy {
    $svc = Get-Service -Name "HostEyeAgent" -ErrorAction SilentlyContinue
    if (-not $svc) { return $false }
    return ($svc.Status -eq "Running")
}

$Jitter = Get-Random -Minimum 0 -Maximum 120
Start-Sleep -Seconds $Jitter

$useManifest = $false
$manifest = $null

try {
    Invoke-WebRequest -Uri "$UpdateUrl/manifest.json" -OutFile $TmpManifest -TimeoutSec 30 -ErrorAction Stop | Out-Null
    Invoke-WebRequest -Uri "$UpdateUrl/manifest.json.sig" -OutFile $TmpManifestSig -TimeoutSec 30 -ErrorAction Stop | Out-Null
    Invoke-WebRequest -Uri "$UpdateUrl/vector.toml" -OutFile $TmpConfig -TimeoutSec 30 -ErrorAction Stop | Out-Null

    if (-not (Test-Signature $TmpManifest $TmpManifestSig)) {
        Write-UpdateLog "Manifest signature verification failed; update rejected."
        Remove-TempFiles
        exit 0
    }

    $manifest = Get-Content -LiteralPath $TmpManifest -Raw | ConvertFrom-Json
    $useManifest = $true
} catch {
    Write-UpdateLog "Manifest download failed; attempting legacy vector.toml.sig flow: $($_.Exception.Message)"
}

if (-not $useManifest) {
    try {
        Invoke-WebRequest -Uri "$UpdateUrl/vector.toml" -OutFile $TmpConfig -TimeoutSec 30 -ErrorAction Stop | Out-Null
        Invoke-WebRequest -Uri "$UpdateUrl/vector.toml.sig" -OutFile $TmpConfigSig -TimeoutSec 30 -ErrorAction Stop | Out-Null
    } catch {
        Write-UpdateLog "Download skipped/failed: $($_.Exception.Message)"
        Remove-TempFiles
        exit 0
    }

    if (-not (Test-Signature $TmpConfig $TmpConfigSig)) {
        Write-UpdateLog "Legacy config signature verification failed; config rejected."
        Remove-TempFiles
        exit 0
    }

    $manifest = [pscustomobject]@{
        version = (Get-Date -Format "yyyyMMddHHmmss")
        file = "vector.toml"
        sha256 = Get-FileSha256 $TmpConfig
        minimum_agent_version = "1.0.0"
    }
}

if ($manifest.file -ne "vector.toml") {
    Write-UpdateLog "Manifest rejected: unsupported file '$($manifest.file)'."
    Remove-TempFiles
    exit 0
}

$actualHash = Get-FileSha256 $TmpConfig
if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) {
    Write-UpdateLog "Hash mismatch; update rejected. expected=$($manifest.sha256) actual=$actualHash"
    Remove-TempFiles
    exit 0
}

if (-not (Test-MinimumAgentVersion ([string]$manifest.minimum_agent_version))) {
    Write-UpdateLog "Update requires minimum_agent_version=$($manifest.minimum_agent_version); update deferred."
    Remove-TempFiles
    exit 0
}

$currentVersion = Get-CurrentVersion
if (-not (Test-VersionGreater ([string]$manifest.version) $currentVersion)) {
    Write-UpdateLog "No newer config available. current=$currentVersion candidate=$($manifest.version)"
    Remove-TempFiles
    exit 0
}

if (-not (Test-VectorConfig $TmpConfig)) {
    Write-UpdateLog "Config syntax validation failed; current config preserved."
    Remove-TempFiles
    exit 0
}

$backupPath = Join-Path $BackupDir ("vector.toml." + (Get-Date -Format "yyyyMMddHHmmss") + ".bak")
try {
    if (Test-Path -LiteralPath $ActiveConfig) {
        Copy-Item -LiteralPath $ActiveConfig -Destination $backupPath -Force
    }
    Copy-Item -LiteralPath $TmpConfig -Destination $ActiveConfig -Force
    Set-Content -LiteralPath $VersionState -Value ([string]$manifest.version) -Encoding ASCII
    Write-UpdateLog "Config version $($manifest.version) applied after signature/hash/version/syntax checks."
} catch {
    Write-UpdateLog "Config apply failed: $($_.Exception.Message)"
    Remove-TempFiles
    exit 0
}

Start-Sleep -Seconds 5
if (-not (Test-VectorServiceHealthy)) {
    Write-UpdateLog "HostEye service unhealthy after update; rolling back."
    try {
        if (Test-Path -LiteralPath $backupPath) {
            Copy-Item -LiteralPath $backupPath -Destination $ActiveConfig -Force
            Start-Service -Name "HostEyeAgent" -ErrorAction SilentlyContinue
            Write-UpdateLog "Rollback completed from $backupPath."
        }
    } catch {
        Write-UpdateLog "Rollback failed: $($_.Exception.Message)"
    }
}

Remove-TempFiles
