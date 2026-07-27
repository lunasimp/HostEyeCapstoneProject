param(
    [string]$SourceDir = (Resolve-Path "$PSScriptRoot\..\..\VectorBuild").Path,
    [string]$MsiPath,
    [Parameter(Mandatory = $true)]
    [string]$CertificateThumbprint,
    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Find-CodeSigningCert {
    param([string]$Thumbprint)

    $normalized = ($Thumbprint -replace "\s", "").ToUpperInvariant()
    $candidates = @(
        "Cert:\CurrentUser\My\$normalized",
        "Cert:\LocalMachine\My\$normalized"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $cert = Get-Item -LiteralPath $candidate
            if (-not $cert.HasPrivateKey) {
                throw "Certificate $normalized was found at $candidate but has no private key."
            }
            return $cert
        }
    }

    throw "Code-signing certificate $normalized was not found in CurrentUser\My or LocalMachine\My."
}

function Sign-OneFile {
    param(
        [string]$Path,
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Cannot sign missing file: $Path"
    }

    Write-Host "[HostEye Sign] Signing $Path"
    $signParams = @{
        FilePath = $Path
        Certificate = $Certificate
        HashAlgorithm = "SHA256"
    }
    if (-not [string]::IsNullOrWhiteSpace($TimestampServer)) {
        $signParams.TimestampServer = $TimestampServer
    }

    $result = Set-AuthenticodeSignature @signParams

    if ($result.Status -ne "Valid") {
        throw "Signing failed for $Path. Status=$($result.Status) Message=$($result.StatusMessage)"
    }
}

$cert = Find-CodeSigningCert -Thumbprint $CertificateThumbprint

$filesToSign = @(
    (Join-Path $SourceDir "vector.exe"),
    (Join-Path $SourceDir "SOCShipper\publish\HostEyeShipper.exe"),
    (Join-Path $SourceDir "SOCShipper\publish\HostEyeShipper.dll")
)

foreach ($file in $filesToSign) {
    Sign-OneFile -Path $file -Certificate $cert
}

if ($MsiPath) {
    Sign-OneFile -Path $MsiPath -Certificate $cert
}

Write-Host "[HostEye Sign] Verifying signatures"
$verifyPaths = @($filesToSign)
if ($MsiPath) { $verifyPaths += $MsiPath }

$verifyPaths |
    ForEach-Object { Get-AuthenticodeSignature -FilePath $_ } |
    Select-Object Path, Status, StatusMessage, SignerCertificate

