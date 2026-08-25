param(
    [Parameter(Mandatory = $true)][string]$RegistrationUri,
    [Parameter(Mandatory = $true)][string]$EnrollmentToken,
    [Parameter(Mandatory = $true)][string]$BootstrapSigningKey,
    [string]$CertDirectory = "C:\Program Files\HostEye\certs",
    [string]$StateDirectory = "C:\ProgramData\HostEye\identity"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $CertDirectory, $StateDirectory | Out-Null

# Enrollment state contains the random PKCS#12 password and must not inherit
# ProgramData read access for ordinary interactive users.
$stateAcl = Get-Acl -LiteralPath $StateDirectory
$stateAcl.SetAccessRuleProtection($true, $false)
$stateAcl.ResetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    "Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))
$stateAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    "SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))
Set-Acl -LiteralPath $StateDirectory -AclObject $stateAcl

$agentId = [Environment]::GetEnvironmentVariable("HOSTEYE_AGENT_ID", "Machine")
$hostId = [Environment]::GetEnvironmentVariable("HOSTEYE_HOST_ID", "Machine")
$computer = $env:COMPUTERNAME
if ([string]::IsNullOrWhiteSpace($agentId) -or [string]::IsNullOrWhiteSpace($hostId)) {
    throw "Stable HostEye Agent/Host identity must exist before enrollment."
}

$requestDirectory = Join-Path (Join-Path $StateDirectory "request") ("{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmss"), [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $requestDirectory | Out-Null
$infPath = Join-Path $requestDirectory "endpoint-request.inf"
$csrPath = Join-Path $requestDirectory "endpoint-request.csr"
$certificatePath = Join-Path $CertDirectory "client.crt"
$pfxPath = Join-Path $CertDirectory "client.pfx"
$caPath = Join-Path $CertDirectory "company_ca.crt"

$subject = "CN=$agentId,OU=HostEye Endpoint,O=HostEye"
$inf = @"
[Version]
Signature=`"`$Windows NT`$`"

[NewRequest]
Subject = `"$subject`"
MachineKeySet = TRUE
Exportable = TRUE
KeyLength = 2048
KeyAlgorithm = RSA
HashAlgorithm = sha256
ProviderName = `"Microsoft Software Key Storage Provider`"
RequestType = PKCS10
KeyUsage = 0xa0

[EnhancedKeyUsageExtension]
OID=1.3.6.1.5.5.7.3.2
"@
[System.IO.File]::WriteAllText($infPath, $inf, [System.Text.UTF8Encoding]::new($false))
$certreqOutput = @(& certreq.exe -new -q $infPath $csrPath 2>&1)
$certreqExitCode = $LASTEXITCODE
if ($certreqExitCode -ne 0 -or -not (Test-Path -LiteralPath $csrPath)) {
    $certreqDetail = ($certreqOutput | ForEach-Object { [string]$_ }) -join " | "
    if ([string]::IsNullOrWhiteSpace($certreqDetail)) { $certreqDetail = "certreq did not return diagnostic output" }
    throw "Windows CSR creation failed (exit code $certreqExitCode): $certreqDetail"
}

$payload = [ordered]@{
    token = $EnrollmentToken
    agentId = $agentId
    hostId = $hostId
    actualHostname = $computer
    agentVersion = "1.0.0"
    csr = [System.IO.File]::ReadAllText($csrPath)
}
try {
    $response = Invoke-RestMethod -Uri $RegistrationUri -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json -Depth 5) -TimeoutSec 60
} catch {
    $statusCode = $null
    $responseMessage = $null
    if ($_.Exception.Response) {
        try { $statusCode = [int]$_.Exception.Response.StatusCode } catch {}
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) {
                $reader = [System.IO.StreamReader]::new($stream)
                try { $responseMessage = $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
        } catch {}
    }
    $detail = if ([string]::IsNullOrWhiteSpace($responseMessage)) { $_.Exception.Message } else { $responseMessage }
    $prefix = if ($statusCode) { "HTTP $statusCode" } else { "request error" }
    throw "Enrollment endpoint rejected the request ($prefix): $detail"
}

$hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($BootstrapSigningKey))
try {
    $computed = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$response.bootstrapCanonical))
} finally { $hmac.Dispose() }
$computedSignature = [Convert]::ToBase64String($computed).TrimEnd('=').Replace('+', '-').Replace('/', '_')
if ($computedSignature -cne [string]$response.bootstrapSignature) { throw "Signed bootstrap verification failed." }

[System.IO.File]::WriteAllText($certificatePath, [string]$response.certificatePem, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($caPath, [string]$response.caCertificatePem, [System.Text.UTF8Encoding]::new($false))

# Windows validates the issuer while accepting the certificate and associating
# it with the pending machine private key. Trust the returned HostEye CA first.
Import-Certificate -FilePath $caPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
$acceptOutput = @(& certreq.exe -accept -machine -q $certificatePath 2>&1)
$acceptExitCode = $LASTEXITCODE
if ($acceptExitCode -ne 0) {
    $acceptDetail = ($acceptOutput | ForEach-Object { [string]$_ }) -join " | "
    if ([string]::IsNullOrWhiteSpace($acceptDetail)) { $acceptDetail = "certreq did not return diagnostic output" }
    throw "Issued HostEye client certificate could not be installed (exit code $acceptExitCode): $acceptDetail"
}

$serial = ([string]$response.device.certificateSerial -replace '[^0-9A-Fa-f]', '').TrimStart('0')
$certificate = Get-ChildItem Cert:\LocalMachine\My | Where-Object {
    (($_.SerialNumber -replace '[^0-9A-Fa-f]', '').TrimStart('0')) -ieq $serial -and $_.HasPrivateKey
} | Sort-Object NotBefore -Descending | Select-Object -First 1
if (-not $certificate) { throw "The enrolled certificate private key was not found in LocalMachine certificate store." }

$passwordBytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($passwordBytes) } finally { $rng.Dispose() }
$pfxPasswordPlain = [Convert]::ToBase64String($passwordBytes)
$pfxPassword = ConvertTo-SecureString $pfxPasswordPlain -AsPlainText -Force
Export-PfxCertificate -Cert $certificate.PSPath -FilePath $pfxPath -Password $pfxPassword -ChainOption EndEntityCertOnly -CryptoAlgorithmOption AES256_SHA256 -Force | Out-Null

[Environment]::SetEnvironmentVariable("HOSTEYE_CI_ID", [string]$response.ciId, "Machine")
[Environment]::SetEnvironmentVariable("HOSTEYE_CI_ID", [string]$response.ciId, "Process")
$result = [ordered]@{
    ciId = [string]$response.ciId
    agentId = $agentId
    hostId = $hostId
    certificateSerial = [string]$response.device.certificateSerial
    certificateThumbprint = $certificate.Thumbprint
    certificateNotAfter = $certificate.NotAfter.ToUniversalTime().ToString("o")
    clientIdentityPfxFile = $pfxPath
    clientIdentityPfxPassword = $pfxPasswordPlain
    bootstrap = $response.bootstrap
    bootstrapSignature = [string]$response.bootstrapSignature
    enrolledAt = (Get-Date).ToUniversalTime().ToString("o")
}
[System.IO.File]::WriteAllText((Join-Path $StateDirectory "enrollment.json"), ($result | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
$result
