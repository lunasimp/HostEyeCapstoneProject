param(
  [string]$ImageName = "hosteye-all-in-one:local",
  [string]$ContainerName = "hosteye-all-in-one",
  [int]$HttpPort = 8080,
  [int]$HttpsPort = 8443,
  [int]$ClickHouseHttpPort = 8123,
  [int]$ClickHouseNativePort = 9000
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

docker build -f (Join-Path $PSScriptRoot "Dockerfile") -t $ImageName $root

$existing = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($existing -eq $ContainerName) {
  docker rm -f $ContainerName | Out-Null
}

docker run --name $ContainerName --rm `
  -p "${HttpPort}:80" `
  -p "${HttpsPort}:443" `
  -p "${ClickHouseHttpPort}:8123" `
  -p "${ClickHouseNativePort}:9000" `
  -v hosteye_clickhouse:/var/lib/clickhouse `
  -v hosteye_vault:/var/log/soc_vault `
  $ImageName

