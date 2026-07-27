param(
    [string]$OutputDir = (Resolve-Path "$PSScriptRoot\..\VectorBuild\HostEyeConfigAgent").Path,
    [string]$ShipperOutputDir = (Resolve-Path "$PSScriptRoot\..\VectorBuild\SOCShipper\publish").Path,
    [string]$Image = "rust:1.88-bookworm"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path "$PSScriptRoot\.."
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$ShipperOutputDir = [System.IO.Path]::GetFullPath($ShipperOutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir, $ShipperOutputDir | Out-Null

Write-Host "[HostEye Dynamic Config] Building Windows Rust payloads with Docker image $Image"
docker run --rm `
    -v "$RepoRoot`:/workspace" `
    -w /workspace/HostEyeDynamicConfig `
    $Image `
    bash -lc "apt-get update && apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64-win32 ca-certificates pkg-config curl && if ! command -v rustup >/dev/null 2>&1; then curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain 1.88.0; . /usr/local/cargo/env; fi && rustup target add x86_64-pc-windows-gnu && cargo build --release --bin hosteye-config-client --bin hosteye-shipper --target x86_64-pc-windows-gnu"

if ($LASTEXITCODE -ne 0) {
    throw "HostEye Rust Windows build failed with exit code $LASTEXITCODE"
}

$configClientExe = Join-Path $RepoRoot "HostEyeDynamicConfig\target\x86_64-pc-windows-gnu\release\hosteye-config-client.exe"
$shipperExe = Join-Path $RepoRoot "HostEyeDynamicConfig\target\x86_64-pc-windows-gnu\release\hosteye-shipper.exe"
foreach ($builtExe in @($configClientExe, $shipperExe)) {
    if (-not (Test-Path -LiteralPath $builtExe)) {
        throw "Expected build output was not found: $builtExe"
    }
}

Copy-Item -LiteralPath $configClientExe -Destination (Join-Path $OutputDir "hosteye-config-client.exe") -Force
Copy-Item -LiteralPath $shipperExe -Destination (Join-Path $ShipperOutputDir "HostEyeShipper.exe") -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "VectorBuild\SOCShipper\shipper-config.json") -Destination (Join-Path $ShipperOutputDir "shipper-config.json") -Force
Write-Host "[HostEye Dynamic Config] Copied hosteye-config-client.exe to $OutputDir"
Write-Host "[HostEye Dynamic Config] Copied Rust HostEyeShipper.exe to $ShipperOutputDir"
