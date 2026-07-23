param(
  [string]$DashboardsUrl = "http://127.0.0.1:5601",
  [string]$IndexPatternId = "hosteye-feature-windows-v1"
)

$ErrorActionPreference = "Stop"
$Headers = @{ "osd-xsrf" = "true" }

function Ensure-DataViewFields {
  param(
    [string]$OpenSearchUrl = "http://127.0.0.1:9200",
    [string]$IndexPattern = "hosteye-feature-windows-v1-*",
    [string]$TimeField = "window_start"
  )

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
      aggregatable = ($esType -in @("keyword", "date", "boolean", "float", "double", "integer", "long", "short", "byte", "half_float", "scaled_float"))
      readFromDocValues = ($esType -ne "text")
    }
  }
  $fields += [ordered]@{ name = "_id"; type = "string"; esTypes = @("_id"); searchable = $true; aggregatable = $false; readFromDocValues = $false }

  $fieldsJson = $fields | ConvertTo-Json -Depth 20 -Compress
  $body = @{
    attributes = @{
      title = $IndexPattern
      timeFieldName = $TimeField
      fields = $fieldsJson
    }
  } | ConvertTo-Json -Depth 30 -Compress

  Invoke-RestMethod -Method Post -Uri "$DashboardsUrl/api/saved_objects/index-pattern/${IndexPatternId}?overwrite=true" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
}

Ensure-DataViewFields
function Save-Object {
  param(
    [string]$Type,
    [string]$Id,
    [hashtable]$Attributes,
    [array]$References = @()
  )
  $body = @{ attributes = $Attributes; references = $References } | ConvertTo-Json -Depth 100 -Compress
  Invoke-RestMethod -Method Post -Uri "$DashboardsUrl/api/saved_objects/$Type/${Id}?overwrite=true" -Headers $Headers -ContentType "application/json" -Body $body | Out-Null
}

$IndexRef = @(@{
  name = "kibanaSavedObjectMeta.searchSourceJSON.index"
  type = "index-pattern"
  id = $IndexPatternId
})

function SearchSourceJson {
  return (@{
    query = @{ query = ""; language = "kuery" }
    filter = @()
    indexRefName = "kibanaSavedObjectMeta.searchSourceJSON.index"
  } | ConvertTo-Json -Depth 20 -Compress)
}

function VisualizationAttrs {
  param([string]$Title, [object]$VisState)
  return @{
    title = $Title
    description = ""
    version = 1
    uiStateJSON = "{}"
    visState = ($VisState | ConvertTo-Json -Depth 100 -Compress)
    kibanaSavedObjectMeta = @{ searchSourceJSON = (SearchSourceJson) }
  }
}

$metricVis = @{
  title = "Feature windows indexed"
  type = "metric"
  params = @{
    addTooltip = $true
    addLegend = $false
    type = "metric"
    metric = @{
      percentageMode = $false
      useRanges = $false
      colorSchema = "Green to Red"
      metricColorMode = "None"
      colorsRange = @(@{ from = 0; to = 10000 })
      labels = @{ show = $true }
      invertColors = $false
      style = @{ bgFill = "#000"; bgColor = $false; labelColor = $false; subText = "feature docs"; fontSize = 42 }
    }
  }
  aggs = @(@{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} })
}

$groupBarVis = @{
  title = "Feature windows by behavior group"
  type = "histogram"
  params = @{
    type = "histogram"
    grid = @{ categoryLines = $false; style = @{ color = "#eee" } }
    categoryAxes = @(@{ id = "CategoryAxis-1"; type = "category"; position = "bottom"; show = $true; style = @{}; scale = @{ type = "linear" }; labels = @{ show = $true; truncate = 100 }; title = @{} })
    valueAxes = @(@{ id = "ValueAxis-1"; name = "LeftAxis-1"; type = "value"; position = "left"; show = $true; style = @{}; scale = @{ type = "linear"; mode = "normal" }; labels = @{ show = $true; rotate = 0; filter = $false; truncate = 100 }; title = @{ text = "Count" } })
    seriesParams = @(@{ show = $true; type = "histogram"; mode = "normal"; data = @{ label = "Count"; id = "1" }; valueAxis = "ValueAxis-1"; drawLinesBetweenPoints = $true; showCircles = $true })
    addTooltip = $true
    addLegend = $true
    legendPosition = "right"
    times = @()
    addTimeMarker = $false
  }
  aggs = @(
    @{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} },
    @{ id = "2"; enabled = $true; type = "terms"; schema = "segment"; params = @{ field = "behavior_group"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } }
  )
}

$timelineVis = @{
  title = "Feature windows over time"
  type = "line"
  params = @{
    type = "line"
    grid = @{ categoryLines = $false; style = @{ color = "#eee" } }
    categoryAxes = @(@{ id = "CategoryAxis-1"; type = "category"; position = "bottom"; show = $true; style = @{}; scale = @{ type = "linear" }; labels = @{ show = $true; truncate = 100 }; title = @{} })
    valueAxes = @(@{ id = "ValueAxis-1"; name = "LeftAxis-1"; type = "value"; position = "left"; show = $true; style = @{}; scale = @{ type = "linear"; mode = "normal" }; labels = @{ show = $true; rotate = 0; filter = $false; truncate = 100 }; title = @{ text = "Count" } })
    seriesParams = @(@{ show = $true; type = "line"; mode = "normal"; data = @{ label = "Count"; id = "1" }; valueAxis = "ValueAxis-1"; drawLinesBetweenPoints = $true; showCircles = $true })
    addTooltip = $true
    addLegend = $true
    legendPosition = "right"
    times = @()
    addTimeMarker = $false
  }
  aggs = @(
    @{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} },
    @{ id = "2"; enabled = $true; type = "date_histogram"; schema = "segment"; params = @{ field = "window_start"; timeRange = @{ from = "now-24h"; to = "now" }; useNormalizedOpenSearchInterval = $true; interval = "auto"; drop_partials = $false; min_doc_count = 1; extended_bounds = @{} } },
    @{ id = "3"; enabled = $true; type = "terms"; schema = "group"; params = @{ field = "behavior_group"; orderBy = "1"; order = "desc"; size = 6; otherBucket = $false; missingBucket = $false } }
  )
}

$tableVis = @{
  title = "Top entities by feature docs"
  type = "table"
  params = @{ perPage = 10; showPartialRows = $false; showMetricsAtAllLevels = $false; sort = @{ columnIndex = $null; direction = $null }; showTotal = $false; totalFunc = "sum" }
  aggs = @(
    @{ id = "1"; enabled = $true; type = "count"; schema = "metric"; params = @{} },
    @{ id = "2"; enabled = $true; type = "terms"; schema = "bucket"; params = @{ field = "entity_id"; orderBy = "1"; order = "desc"; size = 10; otherBucket = $false; missingBucket = $false } },
    @{ id = "3"; enabled = $true; type = "terms"; schema = "bucket"; params = @{ field = "behavior_group"; orderBy = "1"; order = "desc"; size = 6; otherBucket = $false; missingBucket = $false } }
  )
}

Save-Object -Type "visualization" -Id "hosteye-feature-count" -Attributes (VisualizationAttrs "Feature windows indexed" $metricVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-feature-by-group" -Attributes (VisualizationAttrs "Feature windows by behavior group" $groupBarVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-feature-over-time" -Attributes (VisualizationAttrs "Feature windows over time" $timelineVis) -References $IndexRef
Save-Object -Type "visualization" -Id "hosteye-top-entities" -Attributes (VisualizationAttrs "Top entities by feature docs" $tableVis) -References $IndexRef

$panels = @(
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 0; w = 12; h = 8; i = "1" }; panelIndex = "1"; embeddableConfig = @{}; panelRefName = "panel_1" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 12; y = 0; w = 36; h = 8; i = "2" }; panelIndex = "2"; embeddableConfig = @{}; panelRefName = "panel_2" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 8; w = 48; h = 12; i = "3" }; panelIndex = "3"; embeddableConfig = @{}; panelRefName = "panel_3" },
  @{ version = "7.10.2"; type = "visualization"; gridData = @{ x = 0; y = 20; w = 48; h = 12; i = "4" }; panelIndex = "4"; embeddableConfig = @{}; panelRefName = "panel_4" }
)

$dashboardRefs = @(
  @{ name = "panel_1"; type = "visualization"; id = "hosteye-feature-count" },
  @{ name = "panel_2"; type = "visualization"; id = "hosteye-feature-by-group" },
  @{ name = "panel_3"; type = "visualization"; id = "hosteye-feature-over-time" },
  @{ name = "panel_4"; type = "visualization"; id = "hosteye-top-entities" }
)

$dashboardAttrs = @{
  title = "HostEye Feature Overview"
  hits = 0
  description = "Feature-level telemetry indexed from ClickHouse into OpenSearch."
  panelsJSON = ($panels | ConvertTo-Json -Depth 50 -Compress)
  optionsJSON = (@{ useMargins = $true; hidePanelTitles = $false } | ConvertTo-Json -Compress)
  version = 1
  timeRestore = $true
  timeFrom = "now-24h"
  timeTo = "now"
  refreshInterval = @{ pause = $false; value = 10000 }
  kibanaSavedObjectMeta = @{ searchSourceJSON = (@{ query = @{ query = ""; language = "kuery" }; filter = @() } | ConvertTo-Json -Depth 20 -Compress) }
}

Save-Object -Type "dashboard" -Id "hosteye-feature-overview" -Attributes $dashboardAttrs -References $dashboardRefs

[pscustomobject]@{
  dashboard = "HostEye Feature Overview"
  url = "$DashboardsUrl/app/dashboards#/view/hosteye-feature-overview"
  dataView = "hosteye-feature-windows-v1-*"
} | ConvertTo-Json -Depth 10



