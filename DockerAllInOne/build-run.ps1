param(
  [string]$ImageName = "hosteye-all-in-one:local",
  [string]$ContainerName = "hosteye-all-in-one",
  [int]$HttpPort = 8080,
  [string]$DashboardAdminUsername = "admin",
  [string]$DashboardAdminPassword = $env:HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DashboardAdminPassword)) {
  throw "Set HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD or pass -DashboardAdminPassword."
}

docker build -f (Join-Path $PSScriptRoot "Dockerfile") -t $ImageName $root

$existing = docker ps -a --filter "name=^/$ContainerName$" --format "{{.Names}}"
if ($existing -eq $ContainerName) {
  docker rm -f $ContainerName | Out-Null
}

docker run --name $ContainerName --rm `
  -p "${HttpPort}:80" `
  -v hosteye_clickhouse:/var/lib/clickhouse `
  -v hosteye_vault:/var/log/soc_vault `
  -v hosteye_dashboard_auth:/var/lib/hosteye-dashboard `
  -e HOSTEYE_DASHBOARD_AUTH_REQUIRED=true `
  -e HOSTEYE_DASHBOARD_USERS_FILE=/var/lib/hosteye-dashboard/dashboard-users.json `
  -e HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME=$DashboardAdminUsername `
  -e HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD=$DashboardAdminPassword `
  $ImageName
