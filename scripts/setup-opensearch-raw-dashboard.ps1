param(
  [string]$DashboardsUrl = "http://127.0.0.1:5601",
  [string]$OpenSearchUrl = "http://127.0.0.1:9200",
  [string]$IndexPatternId = "hosteye-raw-windows-v1",
  [string]$IndexPattern = "hosteye-raw-windows-v1-*",
  [string]$TimeField = "kafka_timestamp"
)

$ErrorActionPreference = "Stop"
$Headers = @{ "osd-xsrf" = "true" }

function Save-Object {
  param([string]$Type, [string]$Id, [hashtable]$Attributes, [array]$References = @())
  $body = @{ attributes = $Attributes; references = $References } | ConvertTo-Json -Depth 100 -Compress
  Invoke-RestMethod -Method Post -Uri "$DashboardsUrl/api/saved_objects/$Type/${Id}?overwrite=true" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
}

function Ensure-DataViewFields {
  $mapping = Invoke-RestMethod -Method Get -Uri "$OpenSearchUrl/$IndexPattern/_mapping"
  $firstIndex = ($mapping.PSObject.Properties | Select-Object -First 1).Name
  if (-not $firstIndex) { throw "No OpenSearch index found for $IndexPattern" }
  $props = $mapping.$firstIndex.mappings.properties
  $fields = @()
  foreach ($field in $props.PSObject.Properties) {
    $name = $field.Name
    $esType = [string]$field.Value.type
    $dashType = switch ($esType) {
      "date" { "date" }
      "keyword" { "string" }
      "text" { "string" }
      "ip" { "ip" }
      "boolean" { "boolean" }
      "float" { "number" }
      "double" { "number" }
      "integer" { "number" }
      "long" { "number" }
      default { "string" }
    }
    $fields += [ordered]@{
      name = $name
      type = $dashType
      esTypes = @($esType)
      searchable = $true
      aggregatable = ($esType -in @("keyword", "date", "boolean", "float", "double", "integer", "long", "short", "byte", "half_float", "scaled_float", "ip"))
      readFromDocValues = ($esType -ne "text")
    }
  }
  $fields += [ordered]@{ name = "_id"; type = "string"; esTypes = @("_id"); searchable = $true; aggregatable = $false; readFromDocValues = $false }
  $fieldsJson = $fields | ConvertTo-Json -Depth 20 -Compress
  $body = @{ attributes = @{ title = $IndexPattern; timeFieldName = $TimeField; fields = $fieldsJson } } | ConvertTo-Json -Depth 30 -Compress
  Invoke-RestMethod -Method Post -Uri "$DashboardsUrl/api/saved_objects/index-pattern/${IndexPatternId}?overwrite=true" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
}

Ensure-DataViewFields

$IndexRef = @(@{ name = "kibanaSavedObjectMeta.searchSourceJSON.index"; type = "index-pattern"; id = $IndexPatternId })
function SearchSourceJson { return (@{ query = @{ query = ""; language = "kuery" }; filter = @(); indexRefName = "kibanaSavedObjectMeta.searchSourceJSON.index" } | ConvertTo-Json -Depth 20 -Compress) }
function VisualizationAttrs { param([string]$Title, [object]$VisState) return @{ title = $Title; description = ""; version = 1; uiStateJSON = "{}"; visState = ($VisState | ConvertTo-Json -Depth 100 -Compress); kibanaSavedObjectMeta = @{ searchSourceJSON = (SearchSourceJson) } } }

$metricVis = @{ title = "Raw logs indexed"; type = "metric"; params = @{ addTooltip = $true; addLegend = $false; type = "metric"; metric = @{ percentageMode = $false; useRanges = $false; colorSchema = "Green to Red"; metricColorMode = "None"; colorsRange = @(@{ from = 0; to = 100000 }); labels = @{ show = $true }; invertColors = $false; style = @{ bgFill = "#000"; bgColor = $false; labelColor = $false; subText = "raw events"; fontSize = 42 } } }; aggs = @(@{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} }) }
$timelineVis = @{ title = "Raw logs over ingest time"; type = "line"; params = @{ type = "line"; grid = @{ categoryLines = $false; style = @{ color = "#eee" } }; categoryAxes = @(@{ id = "CategoryAxis-1"; type = "category"; position = "bottom"; show = $true; style = @{}; scale = @{ type = "linear" }; labels = @{ show = $true; truncate = 100 }; title = @{} }); valueAxes = @(@{ id = "ValueAxis-1"; name = "LeftAxis-1"; type = "value"; position = "left"; show = $true; style = @{}; scale = @{ type = "linear"; mode = "normal" }; labels = @{ show = $true; rotate = 0; filter = $false; truncate = 100 }; title = @{ text = "Count" } }); seriesParams = @(@{ show = $true; type = "line"; mode = "normal"; data = @{ label = "Count"; id = "1" }; valueAxis = "ValueAxis-1"; drawLinesBetweenPoints = $true; showCircles = $true }); addTooltip = $true; addLegend = $true; legendPosition = "right"; times = @(); addTimeMarker = $false }; aggs = @(@{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} }, @{ id = "2"; enabled = $true; type = "date_histogram"; schema = "segment"; params = @{ field = "kafka_timestamp"; timeRange = @{ from = "now-24h"; to = "now" }; useNormalizedOpenSearchInterval = $true; interval = "auto"; drop_partials = $false; min_doc_count = 1; extended_bounds = @{} } }, @{ id = "3"; enabled = $true; type = "terms"; schema = "group"; params = @{ field = "channel"; orderBy = "1"; order = "desc"; size = 6; otherBucket = $false; missingBucket = $false } }) }
$channelVis = @{ title = "Raw logs by channel"; type = "histogram"; params = @{ type = "histogram"; grid = @{ categoryLines = $false; style = @{ color = "#eee" } }; categoryAxes = @(@{ id = "CategoryAxis-1"; type = "category"; position = "bottom"; show = $true; style = @{}; scale = @{ type = "linear" }; labels = @{ show = $true; truncate = 100 }; title = @{} }); valueAxes = @(@{ id = "ValueAxis-1"; name = "LeftAxis-1"; type = "value"; position = "left"; show = $true; style = @{}; scale = @{ type = "linear"; mode = "normal" }; labels = @{ show = $true; rotate = 0; filter = $false; truncate = 100 }; title = @{ text = "Count" } }); seriesParams = @(@{ show = $true; type = "histogram"; mode = "normal"; data = @{ label = "Count"; id = "1" }; valueAxis = "ValueAxis-1"; drawLinesBetweenPoints = $true; showCircles = $true }); addTooltip = $true; addLegend = $true; legendPosition = "right"; times = @(); addTimeMarker = $false }; aggs = @(@{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} }, @{ id = "2"; enabled = $true; type = "terms"; schema = "segment"; params = @{ field = "channel"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } }) }
$tableVis = @{ title = "Latest raw events"; type = "table"; params = @{ perPage = 10; showPartialRows = $false; showMetricsAtAllLevels = $false; sort = @{ columnIndex = $null; direction = $null }; showTotal = $false; totalFunc = "sum" }; aggs = @(@{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} }, @{ id = "2"; enabled = $true; type = "terms"; schema = "bucket"; params = @{ field = "computer"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } }, @{ id = "3"; enabled = $true; type = "terms"; schema = "bucket"; params = @{ field = "channel"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } }, @{ id = "4"; enabled = $true; type = "terms"; schema = "bucket"; params = @{ field = "event_id"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } }) }

Save-Object -Type "visualization" -Id "hosteye-raw-count" -Attributes (VisualizationAttrs "Raw logs indexed" $metricVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-raw-over-time" -Attributes (VisualizationAttrs "Raw logs over ingest time" $timelineVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-raw-by-channel" -Attributes (VisualizationAttrs "Raw logs by channel" $channelVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-raw-latest-events" -Attributes (VisualizationAttrs "Latest raw events" $tableVis) -References $IndexRef

$panels = @(
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 0; w = 12; h = 8; i = "1" }; panelIndex = "1"; embeddableConfig = @{}; panelRefName = "panel_1" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 12; y = 0; w = 36; h = 8; i = "2" }; panelIndex = "2"; embeddableConfig = @{}; panelRefName = "panel_2" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 8; w = 48; h = 12; i = "3" }; panelIndex = "3"; embeddableConfig = @{}; panelRefName = "panel_3" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 20; w = 48; h = 12; i = "4" }; panelIndex = "4"; embeddableConfig = @{}; panelRefName = "panel_4" }
)
$refs = @(
  @{ name = "panel_1"; type = "visualization"; id = "hosteye-raw-count" },
  @{ name = "panel_2"; type = "visualization"; id = "hosteye-raw-over-time" },
  @{ name = "panel_3"; type = "visualization"; id = "hosteye-raw-by-channel" },
  @{ name = "panel_4"; type = "visualization"; id = "hosteye-raw-latest-events" }
)
$attrs = @{ title = "HostEye Raw Log Stream"; hits = 0; description = "Raw Windows events streamed from ClickHouse into OpenSearch."; panelsJSON = ($panels | ConvertTo-Json -Depth 50 -Compress); optionsJSON = (@{ useMargins = $true; hidePanelTitles = $false } | ConvertTo-Json -Compress); version = 1; timeRestore = $true; timeFrom = "now-24h"; timeTo = "now"; refreshInterval = @{ pause = $false; value = 5000 }; kibanaSavedObjectMeta = @{ searchSourceJSON = (@{ query = @{ query = ""; language = "kuery" }; filter = @() } | ConvertTo-Json -Depth 20 -Compress) } }
Save-Object -Type "dashboard" -Id "hosteye-raw-log-stream" -Attributes $attrs -References $refs

[pscustomobject]@{ dashboard = "HostEye Raw Log Stream"; url = "$DashboardsUrl/app/dashboards#/view/hosteye-raw-log-stream"; dataView = $IndexPattern } | ConvertTo-Json -Depth 10
