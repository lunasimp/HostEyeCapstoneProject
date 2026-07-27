param(
    [string]$Subject = "CN=HostEye Demo Code Signing",
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "certs"),
    [switch]$TrustForLocalMachine
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(3)

$cerPath = Join-Path $OutputDirectory "HostEyeDemoCodeSigning.cer"
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

if ($TrustForLocalMachine) {
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).
        IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw "TrustForLocalMachine requires an elevated PowerShell session."
    }

    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\Root" | Out-Null
    Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\LocalMachine\TrustedPublisher" | Out-Null
}

[pscustomobject]@{
    Subject = $cert.Subject
    Thumbprint = $cert.Thumbprint
    CertStore = "Cert:\CurrentUser\My"
    PublicCertificate = $cerPath
    TrustedForLocalMachine = [bool]$TrustForLocalMachine
}
