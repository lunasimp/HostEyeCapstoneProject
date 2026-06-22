param(
    [Parameter(Mandatory=$true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$EndpointId,

    [string]$OutputRoot = "C:\VectorServer\issued_clients",
    [int]$Days = 365,
    [switch]$InstallToVectorBuild
)

$ErrorActionPreference = "Stop"
$OpenSSL = "C:\Program Files\Git\usr\bin\openssl.exe"
$CaCert = "C:\VectorServer\certs\company_ca.crt"
$CaKey = "C:\VectorServer\certs\company_ca.key"
$UpdaterPublic = "C:\VectorBuild\certs\updater_public.pem"

if (-not (Test-Path $OpenSSL)) { throw "OpenSSL not found: $OpenSSL" }
if (-not (Test-Path $CaCert)) { throw "CA cert not found: $CaCert" }
if (-not (Test-Path $CaKey)) { throw "CA key not found: $CaKey" }

$OutDir = Join-Path $OutputRoot $EndpointId
$CertDir = Join-Path $OutDir "certs"
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$KeyPath = Join-Path $CertDir "client.key"
$CsrPath = Join-Path $CertDir "client.csr"
$CrtPath = Join-Path $CertDir "client.crt"
$CnfPath = Join-Path $OutDir "client-cert.cnf"

$cnf = @"
[ req ]
default_bits = 2048
prompt = no
distinguished_name = dn
req_extensions = req_ext

[ dn ]
CN = $EndpointId
O = SOC Endpoint Agent

[ req_ext ]
subjectAltName = @alt_names
extendedKeyUsage = clientAuth
keyUsage = digitalSignature, keyEncipherment

[ alt_names ]
DNS.1 = $EndpointId
"@
Set-Content -LiteralPath $CnfPath -Value $cnf -Encoding ASCII

& $OpenSSL genrsa -out $KeyPath 2048 | Out-Null
& $OpenSSL req -new -key $KeyPath -out $CsrPath -config $CnfPath | Out-Null
& $OpenSSL x509 -req -in $CsrPath -CA $CaCert -CAkey $CaKey -CAcreateserial -out $CrtPath -days $Days -sha256 -extfile $CnfPath -extensions req_ext | Out-Null

Copy-Item -LiteralPath $CaCert -Destination (Join-Path $CertDir "company_ca.crt") -Force
if (Test-Path $UpdaterPublic) { Copy-Item -LiteralPath $UpdaterPublic -Destination (Join-Path $CertDir "updater_public.pem") -Force }

& $OpenSSL x509 -in $CrtPath -noout -subject -issuer -serial -dates -ext subjectAltName


$RegisterScript = "C:\VectorServer\Register-EndpointClientCert.ps1"
if (Test-Path $RegisterScript) {
    & $RegisterScript -CertPath $CrtPath -EndpointId $EndpointId
}
if ($InstallToVectorBuild) {
    $BuildCertDir = "C:\VectorBuild\certs"
    New-Item -ItemType Directory -Force -Path $BuildCertDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $CertDir "client.crt") -Destination (Join-Path $BuildCertDir "client.crt") -Force
    Copy-Item -LiteralPath (Join-Path $CertDir "client.key") -Destination (Join-Path $BuildCertDir "client.key") -Force
    Copy-Item -LiteralPath (Join-Path $CertDir "company_ca.crt") -Destination (Join-Path $BuildCertDir "company_ca.crt") -Force
    if (Test-Path (Join-Path $CertDir "updater_public.pem")) {
        Copy-Item -LiteralPath (Join-Path $CertDir "updater_public.pem") -Destination (Join-Path $BuildCertDir "updater_public.pem") -Force
    }
    Write-Host "Installed endpoint certs into $BuildCertDir for next installer build."
}

Write-Host "Issued endpoint client certificate bundle: $CertDir"
Write-Host "Use -InstallToVectorBuild before compiling a per-endpoint installer."

