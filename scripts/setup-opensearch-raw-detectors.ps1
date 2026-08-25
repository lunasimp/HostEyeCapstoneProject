param(
  [string]$OpenSearchUrl = "http://127.0.0.1:9200",
  [string]$IndexPattern = "hosteye-raw-windows-v1-*"
)

$ErrorActionPreference = "Stop"

function Invoke-OsJson {
  param([string]$Method, [string]$Path, [object]$Body = $null)
  $uri = "$OpenSearchUrl$Path"
  if ($null -eq $Body) { return Invoke-RestMethod -Method $Method -Uri $uri }
  $json = $Body | ConvertTo-Json -Depth 80 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType "application/json" -Body $json
}

function New-CountFeature {
  param([string]$Name, [string]$Field = "record_id")
  return [ordered]@{
    feature_name = $Name
    feature_enabled = $true
    aggregation_query = [ordered]@{
      $Name = [ordered]@{ value_count = [ordered]@{ field = $Field } }
    }
  }
}

function New-CardinalityFeature {
  param([string]$Name, [string]$Field)
  return [ordered]@{
    feature_name = $Name
    feature_enabled = $true
    aggregation_query = [ordered]@{
      $Name = [ordered]@{ cardinality = [ordered]@{ field = $Field } }
    }
  }
}

function New-AvgFeature {
  param([string]$Name, [string]$Field)
  return [ordered]@{
    feature_name = $Name
    feature_enabled = $true
    aggregation_query = [ordered]@{
      $Name = [ordered]@{ avg = [ordered]@{ field = $Field } }
    }
  }
}

function Remove-DetectorByName {
  param([string]$Name)
  try {
    $search = Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/_search" -Body @{ query = @{ match_all = @{} }; size = 200 }
  } catch {
    if ($_.Exception.Message -like "*index_not_found_exception*") { return }
    throw
  }
  foreach ($hit in $search.hits.hits) {
    if ($hit._source.name -ne $Name) { continue }
    $id = $hit._id
    try { Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/$id/_stop" | Out-Null } catch {}
    try { Invoke-OsJson -Method Delete -Path "/_plugins/_anomaly_detection/detectors/$id" | Out-Null } catch {}
  }
}

function New-RawDetector {
  param(
    [string]$Name,
    [string]$Description,
    [array]$Features,
    [object]$FilterQuery = $null
  )
  Remove-DetectorByName -Name $Name
  if ($null -eq $FilterQuery) { $FilterQuery = [ordered]@{ match_all = [ordered]@{} } }
  $body = [ordered]@{
    name = $Name
    description = $Description
    time_field = "kafka_timestamp"
    indices = @($IndexPattern)
    filter_query = $FilterQuery
    feature_attributes = $Features
    detection_interval = @{ period = @{ interval = 1; unit = "Minutes" } }
    window_delay = @{ period = @{ interval = 0; unit = "Minutes" } }
    schema_version = 1
  }
  $created = Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors" -Body $body
  $id = $created._id
  Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/$id/_start" | Out-Null
  [pscustomobject]@{ name = $Name; id = $id; index = $IndexPattern; time_field = "kafka_timestamp"; started = $true }
}

$powerShellFilter = [ordered]@{ bool = [ordered]@{ filter = @(@{ term = @{ channel = "Microsoft-Windows-PowerShell/Operational" } }) } }
$dnsFilter = [ordered]@{ bool = [ordered]@{ filter = @(@{ term = @{ channel = "Microsoft-Windows-DNS-Client/Operational" } }) } }
$systemFilter = [ordered]@{ bool = [ordered]@{ filter = @(@{ term = @{ channel = "System" } }) } }

$detectors = @(
  New-RawDetector `
    -Name "hosteye-raw-volume-v1" `
    -Description "Raw Windows event volume over ingest time" `
    -Features @(
      (New-CountFeature "raw_event_count"),
      (New-CardinalityFeature "unique_channels" "channel"),
      (New-CardinalityFeature "unique_event_ids" "event_id")
    )

  New-RawDetector `
    -Name "hosteye-raw-powershell-v1" `
    -Description "Raw PowerShell Operational event anomalies" `
    -FilterQuery $powerShellFilter `
    -Features @(
      (New-CountFeature "powershell_event_count"),
      (New-CardinalityFeature "powershell_event_ids" "event_id"),
      (New-CardinalityFeature "powershell_records" "record_id")
    )

  New-RawDetector `
    -Name "hosteye-raw-dns-v1" `
    -Description "Raw DNS Client event anomalies" `
    -FilterQuery $dnsFilter `
    -Features @(
      (New-CountFeature "dns_event_count"),
      (New-CardinalityFeature "dns_event_ids" "event_id"),
      (New-CardinalityFeature "dns_queries" "dns_query")
    )

  New-RawDetector `
    -Name "hosteye-raw-system-v1" `
    -Description "Raw Windows System event anomalies" `
    -FilterQuery $systemFilter `
    -Features @(
      (New-CountFeature "system_event_count"),
      (New-CardinalityFeature "system_event_ids" "event_id"),
      (New-CardinalityFeature "system_providers" "provider_name")
    )
)

$detectors | ConvertTo-Json -Depth 20
