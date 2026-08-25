param(
    [string]$Version = "0.55.0",
    [string]$Destination = (Join-Path $PSScriptRoot "vector.exe"),
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    Write-Host "vector.exe already exists: $Destination"
    try { & $Destination --version } catch {}
    Write-Host "Use -Force to download and replace it."
    exit 0
}

$uri = "https://packages.timber.io/vector/$Version/vector-$Version-x86_64-pc-windows-msvc.zip"
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("vector-download-" + [guid]::NewGuid().ToString("n"))
$zipPath = Join-Path $workDir "vector.zip"
$extractDir = Join-Path $workDir "extract"

New-Item -ItemType Directory -Force -Path $workDir, $extractDir | Out-Null

try {
    Write-Host "Downloading Vector $Version from $uri"
    try {
        Invoke-WebRequest -Uri $uri -OutFile $zipPath -UseBasicParsing
    } catch {
        Write-Warning "Invoke-WebRequest failed; retrying with curl.exe: $($_.Exception.Message)"
        & curl.exe -L --fail --retry 3 --output $zipPath $uri
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed to download Vector (exit code $LASTEXITCODE)." }
    }

    Write-Host "Extracting archive"
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $vectorExe = Get-ChildItem -LiteralPath $extractDir -Recurse -Filter "vector.exe" -File | Select-Object -First 1
    if (-not $vectorExe) {
        throw "vector.exe was not found in downloaded archive."
    }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $vectorExe.FullName -Destination $Destination -Force

    Write-Host "Installed Vector binary to $Destination"
    & $Destination --version
}
finally {
    Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
