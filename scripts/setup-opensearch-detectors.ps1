param(
  [string]$OpenSearchUrl = "http://127.0.0.1:9200",
  [string]$IndexPattern = "hosteye-feature-windows-v1-*"
)

$ErrorActionPreference = "Stop"

function Invoke-OsJson {
  param(
    [string]$Method,
    [string]$Path,
    [object]$Body = $null
  )
  $uri = "$OpenSearchUrl$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }
  $json = $Body | ConvertTo-Json -Depth 50 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType "application/json" -Body $json
}

function New-FeatureAttribute {
  param([string]$Name, [string]$Field)
  return [ordered]@{
    feature_name = $Name
    feature_enabled = $true
    aggregation_query = [ordered]@{
      $Name = [ordered]@{
        avg = [ordered]@{ field = $Field }
      }
    }
  }
}

function Remove-DetectorByName {
  param([string]$Name)
  try {
    $search = Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/_search" -Body @{
      query = @{ match_all = @{} }
      size = 100
    }
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

function New-Detector {
  param(
    [string]$Name,
    [string]$Description,
    [string]$BehaviorGroup,
    [array]$Features
  )
  Remove-DetectorByName -Name $Name
  $body = [ordered]@{
    name = $Name
    description = $Description
    time_field = "window_start"
    indices = @($IndexPattern)
    filter_query = [ordered]@{
      bool = [ordered]@{
        filter = @(@{ term = @{ behavior_group = $BehaviorGroup } })
      }
    }
    feature_attributes = $Features
    detection_interval = @{ period = @{ interval = 5; unit = "Minutes" } }
    window_delay = @{ period = @{ interval = 1; unit = "Minutes" } }
    schema_version = 1
  }
  $created = Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors" -Body $body
  $id = $created._id
  Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/$id/_start" | Out-Null
  [pscustomobject]@{ name = $Name; id = $id; behavior_group = $BehaviorGroup; started = $true }
}

$detectors = @(
  New-Detector `
    -Name "hosteye-host-activity-v1" `
    -Description "HostEye RCF detector for host_activity feature windows" `
    -BehaviorGroup "host_activity" `
    -Features @(
      (New-FeatureAttribute "total_event_count" "total_event_count"),
      (New-FeatureAttribute "process_create_count" "process_create_count"),
      (New-FeatureAttribute "powershell_event_count" "powershell_event_count"),
      (New-FeatureAttribute "network_connection_count" "network_connection_count"),
      (New-FeatureAttribute "failed_logon_count" "failed_logon_count")
    )

  New-Detector `
    -Name "hosteye-network-peer-v1" `
    -Description "HostEye RCF detector for network_peer feature windows" `
    -BehaviorGroup "network_peer" `
    -Features @(
      (New-FeatureAttribute "peer_connection_count" "peer_connection_count"),
      (New-FeatureAttribute "interarrival_mean_ms" "interarrival_mean_ms"),
      (New-FeatureAttribute "interarrival_cv" "interarrival_cv"),
      (New-FeatureAttribute "periodicity_score" "periodicity_score"),
      (New-FeatureAttribute "reconnect_count" "reconnect_count")
    )

  New-Detector `
    -Name "hosteye-dns-activity-v1" `
    -Description "HostEye RCF detector for dns_activity feature windows" `
    -BehaviorGroup "dns_activity" `
    -Features @(
      (New-FeatureAttribute "dns_query_count" "dns_query_count"),
      (New-FeatureAttribute "unique_dns_query_count" "unique_dns_query_count"),
      (New-FeatureAttribute "dns_failure_ratio" "dns_failure_ratio"),
      (New-FeatureAttribute "avg_dns_query_length" "avg_dns_query_length"),
      (New-FeatureAttribute "high_entropy_dns_query_count" "high_entropy_dns_query_count")
    )

  New-Detector `
    -Name "hosteye-pipeline-quality-v1" `
    -Description "HostEye RCF detector for pipeline_quality feature windows" `
    -BehaviorGroup "pipeline_quality" `
    -Features @(
      (New-FeatureAttribute "total_event_count" "total_event_count"),
      (New-FeatureAttribute "ingest_delay_p95_ms" "ingest_delay_p95_ms"),
      (New-FeatureAttribute "duplicate_record_rate" "duplicate_record_rate"),
      (New-FeatureAttribute "parser_error_rate" "parser_error_rate"),
      (New-FeatureAttribute "late_event_count" "late_event_count")
    )
)

$detectors | ConvertTo-Json -Depth 10


