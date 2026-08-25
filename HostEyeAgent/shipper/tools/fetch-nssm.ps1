param(
    [string]$Version = "2.24",
    [string]$Destination = (Join-Path $PSScriptRoot "nssm.exe"),
    [switch]$Force
)

$ErrorActionPreference = "Stop"
if ((Test-Path -LiteralPath $Destination) -and -not $Force) {
    Write-Host "nssm.exe already exists: $Destination"
    exit 0
}

$uri = "https://nssm.cc/release/nssm-$Version.zip"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("hosteye-nssm-" + [guid]::NewGuid().ToString("n"))
$archive = Join-Path $work "nssm.zip"
$extract = Join-Path $work "extract"
New-Item -ItemType Directory -Force -Path $work, $extract | Out-Null

try {
    Write-Host "Downloading NSSM $Version from $uri"
    try {
        Invoke-WebRequest -Uri $uri -OutFile $archive -UseBasicParsing
    } catch {
        Write-Warning "Invoke-WebRequest failed; retrying with curl.exe: $($_.Exception.Message)"
        & curl.exe -L --fail --retry 3 --output $archive $uri
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed to download NSSM (exit code $LASTEXITCODE)." }
    }

    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $source = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter "nssm.exe" |
        Where-Object { $_.FullName -match "win64" } |
        Select-Object -First 1
    if (-not $source) { throw "The NSSM archive does not contain a win64 nssm.exe." }

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $source.FullName -Destination $Destination -Force
    Write-Host "Installed NSSM service wrapper to $Destination"
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
