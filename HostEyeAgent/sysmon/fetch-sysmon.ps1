param(
    [string]$DestinationDirectory = $PSScriptRoot,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$required = @("Sysmon.exe", "Sysmon64.exe", "Sysmon64a.exe", "Eula.txt")
$complete = $true
foreach ($name in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $DestinationDirectory $name))) {
        $complete = $false
    }
}
if ($complete -and -not $Force) {
    Write-Host "Sysmon dependencies already exist in $DestinationDirectory"
    exit 0
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("hosteye-sysmon-" + [guid]::NewGuid().ToString("n"))
$archive = Join-Path $work "Sysmon.zip"
$extract = Join-Path $work "extract"
New-Item -ItemType Directory -Force -Path $work, $extract, $DestinationDirectory | Out-Null
try {
    $uri = "https://download.sysinternals.com/files/Sysmon.zip"
    Write-Host "Downloading Sysmon from $uri"
    try {
        Invoke-WebRequest -Uri $uri -OutFile $archive -UseBasicParsing
    } catch {
        Write-Warning "Invoke-WebRequest failed; retrying with curl.exe: $($_.Exception.Message)"
        & curl.exe -L --fail --retry 3 --output $archive $uri
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed to download Sysmon (exit code $LASTEXITCODE)." }
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    foreach ($name in $required) {
        $source = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter $name | Select-Object -First 1
        if (-not $source) { throw "Downloaded Sysmon archive does not contain $name" }
        Copy-Item -LiteralPath $source.FullName -Destination (Join-Path $DestinationDirectory $name) -Force
    }
    Write-Host "Sysmon dependencies restored to $DestinationDirectory"
}
finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
