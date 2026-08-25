param(
    [string]$BaseUrl = "https://hosteye.csp.vn"
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd('/')
$results = [ordered]@{}

function Test-Endpoint([string]$Name, [string]$Method, [string]$Path, [string]$Body = "") {
    try {
        $params = @{
            Method = $Method
            Uri = "$base$Path"
            TimeoutSec = 20
            UseBasicParsing = $true
        }
        if ($Body) {
            $params.ContentType = "application/json"
            $params.Body = $Body
        }
        $response = Invoke-WebRequest @params
        $results[$Name] = @{ status = "PASS"; http_status = [int]$response.StatusCode; path = $Path }
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $results[$Name] = @{ status = "FAIL"; http_status = $status; path = $Path; error = $_.Exception.Message }
    }
}

Test-Endpoint "edge" "GET" "/healthz"
Test-Endpoint "dashboard" "GET" "/"
Test-Endpoint "dashboard_api" "GET" "/api/health"
Test-Endpoint "control_plane" "GET" "/api/v1/agent/config"
Test-Endpoint "admission_route" "POST" "/api/v1/admission/request" '{"agent_id":"public-smoke-agent","host_id":"public-smoke-host","computer":"PUBLIC-SMOKE","queue_used_mb":0,"next_chunk_size_mb":0.001,"retry_count":0}'

$results | ConvertTo-Json -Depth 6
if (@($results.Values | Where-Object { $_.status -ne "PASS" }).Count -gt 0) {
    throw "HostEye public deployment validation failed. Do not distribute the public installer."
}

Write-Host "HostEye public deployment routes PASS. The installer may now be tested on a separate endpoint."
