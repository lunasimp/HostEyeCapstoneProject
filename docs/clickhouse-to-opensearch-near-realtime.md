# Hướng dẫn setup ClickHouse -> OpenSearch raw log streaming và anomaly detector

Tài liệu này hướng dẫn cách cắm dữ liệu log từ ClickHouse sang OpenSearch theo kiểu gần real-time, tạo dashboard để xem raw log, và tạo anomaly detector chạy trực tiếp trên raw log.

Mục tiêu chính:

```text
Windows Agent
  -> HostEye Server / Collector
  -> ClickHouse default.windows_system_logs
  -> raw-log-indexer, poll mỗi 2 giây
  -> OpenSearch hosteye-raw-windows-v1-YYYY.MM.DD
  -> OpenSearch Dashboards
  -> OpenSearch Anomaly Detection raw detectors
```

> Lưu ý quan trọng: OpenSearch không tự kéo dữ liệu từ ClickHouse. Ta phải có một service trung gian, ở đây là `hosteye-raw-log-indexer`, đọc ClickHouse định kỳ rồi bulk index sang OpenSearch.

## 1. Các thành phần cần hiểu

### ClickHouse

ClickHouse là nơi lưu raw log chính của server HostEye.

Bảng raw log:

```text
default.windows_system_logs
```

Các cột quan trọng:

```text
kafka_timestamp    thời điểm log được ingest vào server/ClickHouse
timestamp          thời điểm event xảy ra trên máy Windows
computer           tên máy gửi log
host_id            host id/agent host
channel            Windows Event Log channel
event_id           Windows event id
record_id          Windows record id, dùng để chống trùng
message            nội dung log
raw_log            log gốc nếu có
```

### OpenSearch raw index

Raw log được index sang OpenSearch theo ngày:

```text
hosteye-raw-windows-v1-YYYY.MM.DD
```

Ví dụ:

```text
hosteye-raw-windows-v1-2026.07.22
```

Data view trong OpenSearch Dashboards:

```text
hosteye-raw-windows-v1-*
```

Time field dùng cho raw log:

```text
kafka_timestamp
```

Dùng `kafka_timestamp` để xem stream theo thời điểm server nhận log. Nếu dùng `timestamp`, khi agent replay backlog cũ thì UI có thể nhìn như bị đứng ở thời điểm event cũ.

### raw-log-indexer

Service `hosteye-raw-log-indexer` làm nhiệm vụ:

```text
ClickHouse default.windows_system_logs
  -> query raw log mới
  -> bulk index sang OpenSearch
```

Cấu hình hiện tại:

```text
RAW_INDEX_INTERVAL_MS=2000       poll mỗi 2 giây
RAW_LOOKBACK_SECONDS=10          đọc lùi 10 giây để tránh miss event
RAW_BOOTSTRAP_MINUTES=240        lần đầu lấy lại 240 phút gần nhất
RAW_BATCH_SIZE=5000              mỗi batch tối đa 5000 rows
OPENSEARCH_RAW_INDEX_PREFIX=hosteye-raw-windows-v1
```

Indexer dùng `_id` OpenSearch theo logic:

```text
host_id hoặc computer + channel + record_id
```

Ý nghĩa: nếu indexer đọc lùi 10 giây và upsert lại event cũ thì OpenSearch không tăng duplicate document count.

## 2. File cần có trong repo

Từ root repo:

```text
D:\Tai_lieu_hoc\DoAn\tettet\f-smooth-criminal-lab-team
```

Các file chính:

```text
DockerAllInOne/docker-compose.opensearch.yml
FeaturePipeline/Dockerfile
FeaturePipeline/raw-log-indexer.js
scripts/setup-opensearch-raw-dashboard.ps1
scripts/setup-opensearch-raw-detectors.ps1
```

Các file phụ cho feature/anomaly aggregate nếu vẫn cần:

```text
FeaturePipeline/feature-builder.js
FeaturePipeline/feature-indexer.js
scripts/setup-opensearch-dashboard.ps1
scripts/setup-opensearch-detectors.ps1
```

Trong yêu cầu hiện tại, anomaly chạy trên raw log, nên trọng tâm là `raw-log-indexer.js` và `setup-opensearch-raw-detectors.ps1`.

## 3. Điều kiện trước khi setup

Cần có:

- Docker Desktop đang chạy.
- HostEye all-in-one server đang chạy local.
- ClickHouse trong container `hosteye-all-in-one` có bảng `default.windows_system_logs`.
- OpenSearch và OpenSearch Dashboards chạy local.

Kiểm tra container:

```powershell
docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Các container mong muốn:

```text
hosteye-all-in-one
hosteye-opensearch
hosteye-opensearch-dashboards
hosteye-raw-log-indexer
```

Có thể có thêm:

```text
hosteye-feature-builder
hosteye-feature-indexer
```

## 4. Kiểm tra ClickHouse có raw log chưa

Chạy:

```powershell
docker exec hosteye-all-in-one clickhouse-client --query "SELECT count() AS rows, max(kafka_timestamp) AS latest_ingest, max(timestamp) AS latest_event_time FROM default.windows_system_logs WHERE channel != ''"
```

Nếu `rows = 0`, chưa có dữ liệu để đẩy sang OpenSearch. Khi đó phải kiểm agent/collector trước.

Xem vài log mới nhất:

```powershell
docker exec hosteye-all-in-one clickhouse-client --query "SELECT kafka_timestamp, timestamp, computer, channel, event_id, record_id, left(replaceRegexpAll(message, '[\r\n]+', ' '), 160) AS message FROM default.windows_system_logs WHERE channel != '' ORDER BY kafka_timestamp DESC LIMIT 10 FORMAT PrettyCompact"
```

## 5. Chạy OpenSearch stack và raw-log-indexer

Từ root repo:

```powershell
cd D:\Tai_lieu_hoc\DoAn\tettet\f-smooth-criminal-lab-team
```

Chạy stack:

```powershell
docker compose -f DockerAllInOne\docker-compose.opensearch.yml up -d --build
```

Lệnh này sẽ tạo/chạy:

```text
hosteye-opensearch
hosteye-opensearch-dashboards
hosteye-feature-builder
hosteye-feature-indexer
hosteye-raw-log-indexer
```

Nếu chỉ muốn rebuild và bật lại raw-log-indexer:

```powershell
docker compose -f DockerAllInOne\docker-compose.opensearch.yml build feature-builder
docker compose -f DockerAllInOne\docker-compose.opensearch.yml up -d --force-recreate raw-log-indexer
```

> Trong compose hiện tại image dùng chung tên `hosteye-feature-pipeline:local`, dù service raw-log-indexer nằm trong cùng image đó.

## 6. Kiểm tra OpenSearch health

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:9200/_cluster/health -UseBasicParsing
```

Single-node local có thể trả `green` hoặc `yellow` tùy replica. Nếu API trả JSON và không lỗi kết nối là OpenSearch đang sống.

Kiểm tra Dashboards:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:5601/api/status -UseBasicParsing
```

UI OpenSearch Dashboards:

```text
http://127.0.0.1:5601
```

## 7. Kiểm tra raw-log-indexer có stream không

Xem log container:

```powershell
docker logs --tail 80 hosteye-raw-log-indexer
```

Log tốt sẽ giống:

```text
raw-log-indexer starting clickhouse=http://host.docker.internal:8080/clickhouse/ opensearch=http://opensearch:9200
raw-log-indexer indexed 3761 raw rows through kafka_timestamp=2026-07-22 07:00:39.071
raw-log-indexer indexed 18 raw rows through kafka_timestamp=2026-07-22 07:00:50.555
```

Dòng `indexed N raw rows` nghĩa là nó đã đọc ClickHouse và bulk index sang OpenSearch.

## 8. Kiểm tra OpenSearch đã có raw log chưa

Kiểm tra index:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_cat/indices/hosteye-raw-windows-v1-*?v" -UseBasicParsing
```

Kết quả mong muốn:

```text
hosteye-raw-windows-v1-YYYY.MM.DD docs.count > 0
```

Đếm document:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_count" -UseBasicParsing
```

Lấy vài document mới nhất:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"size":5,"sort":[{"kafka_timestamp":{"order":"desc"}}],"_source":["kafka_timestamp","timestamp","computer","channel","event_id","record_id","message"]}' `
  -UseBasicParsing
```

## 9. Cách chứng minh đang streaming near real-time

Đo trước và sau 15 giây:

```powershell
$beforeCh = docker exec hosteye-all-in-one clickhouse-client --query "SELECT count(), max(kafka_timestamp) FROM default.windows_system_logs WHERE channel != ''"
$beforeOs = Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_count" -UseBasicParsing | Select-Object -ExpandProperty Content
Start-Sleep -Seconds 15
$afterCh = docker exec hosteye-all-in-one clickhouse-client --query "SELECT count(), max(kafka_timestamp) FROM default.windows_system_logs WHERE channel != ''"
$afterOs = Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_count" -UseBasicParsing | Select-Object -ExpandProperty Content
[pscustomobject]@{
  beforeClickHouse = $beforeCh
  beforeOpenSearch = $beforeOs
  afterClickHouse = $afterCh
  afterOpenSearch = $afterOs
} | ConvertTo-Json -Depth 4
```

Nếu ClickHouse tăng từ `3822` lên `3826` và OpenSearch cũng tăng từ `3822` lên `3826`, nghĩa là raw log đang stream sang OpenSearch.

## 10. Tạo raw log dashboard

Chạy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-opensearch-raw-dashboard.ps1
```

Script này tạo:

```text
Data view: hosteye-raw-windows-v1-*
Time field: kafka_timestamp
Dashboard: HostEye Raw Log Stream
```

Mở dashboard:

```text
http://127.0.0.1:5601/app/dashboards#/view/hosteye-raw-log-stream
```

Nếu chưa thấy data:

1. Set time range `Last 24 hours`.
2. Bấm refresh.
3. Kiểm tra index `hosteye-raw-windows-v1-*` có docs chưa.
4. Kiểm tra time field đang là `kafka_timestamp`, không phải `timestamp`.

## 11. Setup anomaly detector chạy trên raw log

Chạy script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-opensearch-raw-detectors.ps1
```

Script tạo và start 4 detector raw:

```text
hosteye-raw-volume-v1
hosteye-raw-powershell-v1
hosteye-raw-dns-v1
hosteye-raw-system-v1
```

Tất cả đọc từ:

```text
hosteye-raw-windows-v1-*
```

Time field:

```text
kafka_timestamp
```

Detection interval:

```text
1 minute
```

Window delay:

```text
0 minute
```

## 12. Ý nghĩa từng raw detector

### hosteye-raw-volume-v1

Mục tiêu: phát hiện bất thường về volume raw event tổng thể.

Features:

```text
raw_event_count     value_count(record_id)
unique_channels     cardinality(channel)
unique_event_ids    cardinality(event_id)
```

Dùng để phát hiện:

- Log tăng đột biến.
- Nhiều channel lạ xuất hiện.
- Event id đa dạng bất thường.

### hosteye-raw-powershell-v1

Mục tiêu: phát hiện bất thường trên PowerShell Operational log.

Filter:

```text
channel = Microsoft-Windows-PowerShell/Operational
```

Features:

```text
powershell_event_count    value_count(record_id)
powershell_event_ids      cardinality(event_id)
powershell_records        cardinality(record_id)
```

Dùng để phát hiện:

- PowerShell log tăng mạnh.
- Nhiều loại PowerShell event lạ.
- Script block / module logging tăng bất thường.

### hosteye-raw-dns-v1

Mục tiêu: phát hiện bất thường trên DNS Client log.

Filter:

```text
channel = Microsoft-Windows-DNS-Client/Operational
```

Features:

```text
dns_event_count    value_count(record_id)
dns_event_ids      cardinality(event_id)
dns_queries        cardinality(dns_query)
```

Dùng để phát hiện:

- DNS query tăng đột biến.
- Nhiều query domain khác nhau.
- Hành vi DNS khác baseline.

### hosteye-raw-system-v1

Mục tiêu: phát hiện bất thường trên Windows System log.

Filter:

```text
channel = System
```

Features:

```text
system_event_count    value_count(record_id)
system_event_ids      cardinality(event_id)
system_providers      cardinality(provider_name)
```

Dùng để phát hiện:

- System event tăng bất thường.
- Provider mới/lạ.
- Service/system lỗi tăng đột biến.

## 13. Xem anomaly detector ở đâu

Mở OpenSearch Dashboards:

```text
http://127.0.0.1:5601/app/anomaly-detection-dashboards#/detectors
```

Trong danh sách detector, tìm:

```text
hosteye-raw-volume-v1
hosteye-raw-powershell-v1
hosteye-raw-dns-v1
hosteye-raw-system-v1
```

Vào từng detector để xem:

- trạng thái detector
- anomaly grade
- confidence
- feature contribution
- anomaly history

## 14. Kiểm tra detector đang RUNNING bằng API

Lấy danh sách detector:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_plugins/_anomaly_detection/detectors/_search" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"size":20,"query":{"match_all":{}},"_source":["name","indices","time_field","detection_interval","window_delay"]}' `
  -UseBasicParsing
```

Kiểm tra profile từng detector:

```powershell
$ids = @(
  "<detector-id-raw-volume>",
  "<detector-id-raw-powershell>",
  "<detector-id-raw-dns>",
  "<detector-id-raw-system>"
)
foreach ($id in $ids) {
  Invoke-WebRequest -Uri "http://127.0.0.1:9200/_plugins/_anomaly_detection/detectors/$id/_profile" -UseBasicParsing
}
```

Trạng thái tốt:

```json
{"state":"RUNNING"}
```

## 15. Xóa detector feature cũ nếu không dùng nữa

Detector cũ chạy trên feature index có dạng:

```text
hosteye-host-activity-v1
hosteye-dns-activity-v1
hosteye-pipeline-quality-v1
hosteye-network-peer-v1
```

Chúng đọc từ:

```text
hosteye-feature-windows-v1-*
```

Nếu chỉ muốn raw anomaly, có thể xóa detector cũ. Ví dụ script PowerShell:

```powershell
$OpenSearchUrl='http://127.0.0.1:9200'
function Invoke-OsJson {
  param([string]$Method,[string]$Path,[object]$Body=$null)
  $uri="$OpenSearchUrl$Path"
  if ($null -eq $Body) { return Invoke-RestMethod -Method $Method -Uri $uri }
  $json=$Body | ConvertTo-Json -Depth 60 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType 'application/json' -Body $json
}
$search = Invoke-OsJson -Method Post -Path '/_plugins/_anomaly_detection/detectors/_search' -Body @{ query=@{ match_all=@{} }; size=200 }
foreach ($hit in $search.hits.hits) {
  $name = $hit._source.name
  $id = $hit._id
  if ($name -like 'hosteye-raw-*') { continue }
  try { Invoke-OsJson -Method Post -Path "/_plugins/_anomaly_detection/detectors/$id/_stop" | Out-Null } catch {}
  Invoke-OsJson -Method Delete -Path "/_plugins/_anomaly_detection/detectors/$id" | Out-Null
}
```

Sau khi xóa, kiểm lại:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_plugins/_anomaly_detection/detectors/_search" -Method Post -ContentType "application/json" -Body '{"size":20,"query":{"match_all":{}},"_source":["name","indices","time_field"]}' -UseBasicParsing
```

Chỉ nên còn:

```text
hosteye-raw-volume-v1
hosteye-raw-powershell-v1
hosteye-raw-dns-v1
hosteye-raw-system-v1
```

## 16. Vì sao mới setup chưa thấy anomaly ngay?

OpenSearch Anomaly Detection dùng model cần học baseline. Vì vậy:

- Vừa tạo detector có thể chưa có anomaly result ngay.
- Detector cần nhiều bucket thời gian liên tiếp.
- Nếu log đều đều, không có biến động lớn, anomaly grade có thể bằng 0.
- Nếu channel lọc không có data, detector đó không có gì để học.

Kiểm tra raw data cho từng detector:

```powershell
# PowerShell raw count
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search" -Method Post -ContentType "application/json" -Body '{"size":0,"query":{"term":{"channel":"Microsoft-Windows-PowerShell/Operational"}}}' -UseBasicParsing

# DNS raw count
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search" -Method Post -ContentType "application/json" -Body '{"size":0,"query":{"term":{"channel":"Microsoft-Windows-DNS-Client/Operational"}}}' -UseBasicParsing

# System raw count
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search" -Method Post -ContentType "application/json" -Body '{"size":0,"query":{"term":{"channel":"System"}}}' -UseBasicParsing
```

## 17. Chống duplicate khi stream raw log

`raw-log-indexer` đọc lùi `RAW_LOOKBACK_SECONDS=10` giây để tránh mất event ở ranh giới poll. Vì vậy log container có thể in:

```text
raw-log-indexer indexed 6 raw rows
raw-log-indexer indexed 6 raw rows
```

Điều này không có nghĩa OpenSearch bị duplicate. Indexer dùng `_id` ổn định:

```text
host/channel/record_id
```

Nên cùng một Windows event sẽ bị upsert lên cùng document.

Kiểm tra duplicate theo `record_id` trong ClickHouse:

```powershell
docker exec hosteye-all-in-one clickhouse-client --query "SELECT count() AS rows, uniqExact(concat(computer,'|',channel,'|',toString(record_id))) AS uniq_by_record, rows - uniq_by_record AS dup_by_record FROM default.windows_system_logs WHERE record_id != 0"
```

Kiểm tra count ClickHouse và OpenSearch có khớp không:

```powershell
docker exec hosteye-all-in-one clickhouse-client --query "SELECT count() FROM default.windows_system_logs WHERE channel != ''"
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_count" -UseBasicParsing
```

Nếu lệch ít trong vài giây là bình thường do poll interval. Nếu lệch lâu, kiểm `docker logs hosteye-raw-log-indexer`.

## 18. Troubleshooting thường gặp

### OpenSearch raw dashboard hiện 0

Kiểm tra:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_cat/indices/hosteye-raw-windows-v1-*?v" -UseBasicParsing
```

Nếu có docs, vào dashboard set time range `Last 24 hours` và refresh.

Nếu không có docs, kiểm:

```powershell
docker logs --tail 100 hosteye-raw-log-indexer
```

### raw-log-indexer lỗi kết nối ClickHouse

Kiểm tra server all-in-one:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:8080/api/health -UseBasicParsing
```

Kiểm tra ClickHouse proxy:

```powershell
docker exec hosteye-all-in-one clickhouse-client --query "SELECT count() FROM default.windows_system_logs"
```

Trong Docker, raw-log-indexer gọi ClickHouse qua:

```text
http://host.docker.internal:8080/clickhouse/
```

Nếu host Docker không resolve, kiểm compose có:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### Detector raw không RUNNING

Kiểm profile:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_plugins/_anomaly_detection/detectors/<detector-id>/_profile" -UseBasicParsing
```

Nếu không RUNNING, vào OpenSearch Dashboards -> Anomaly Detection -> Detectors -> Start detector.

Hoặc chạy lại:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-opensearch-raw-detectors.ps1
```

Script này sẽ xóa detector raw cùng tên cũ rồi tạo/start lại.

### Detector có RUNNING nhưng không có anomaly result

Có thể do:

- Chưa đủ thời gian học baseline.
- Dữ liệu quá ít.
- Filter channel không có log.
- Log đều đều, không có bất thường.

Kiểm raw stream vẫn có data:

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search" -Method Post -ContentType "application/json" -Body '{"size":0,"aggs":{"channels":{"terms":{"field":"channel","size":20}}}}' -UseBasicParsing
```

## 19. Checklist setup từ đầu cho máy mới

Chạy theo thứ tự:

```powershell
# 1. Vào repo
cd D:\Tai_lieu_hoc\DoAn\tettet\f-smooth-criminal-lab-team

# 2. Kiểm HostEye server/ClickHouse có raw log
Invoke-WebRequest -Uri http://127.0.0.1:8080/api/health -UseBasicParsing
docker exec hosteye-all-in-one clickhouse-client --query "SELECT count(), max(kafka_timestamp) FROM default.windows_system_logs WHERE channel != ''"

# 3. Bật OpenSearch + indexer
docker compose -f DockerAllInOne\docker-compose.opensearch.yml up -d --build

# 4. Kiểm OpenSearch sống
Invoke-WebRequest -Uri http://127.0.0.1:9200/_cluster/health -UseBasicParsing

# 5. Kiểm raw indexer
docker logs --tail 80 hosteye-raw-log-indexer
Invoke-WebRequest -Uri "http://127.0.0.1:9200/_cat/indices/hosteye-raw-windows-v1-*?v" -UseBasicParsing

# 6. Tạo raw dashboard
powershell -ExecutionPolicy Bypass -File scripts\setup-opensearch-raw-dashboard.ps1

# 7. Tạo raw detectors
powershell -ExecutionPolicy Bypass -File scripts\setup-opensearch-raw-detectors.ps1

# 8. Mở UI
# Raw log dashboard:
# http://127.0.0.1:5601/app/dashboards#/view/hosteye-raw-log-stream
# Anomaly detectors:
# http://127.0.0.1:5601/app/anomaly-detection-dashboards#/detectors
```

## 20. Các URL cần nhớ

HostEye Overview:

```text
http://127.0.0.1:8080/dashboard/#overview
```

OpenSearch Dashboards:

```text
http://127.0.0.1:5601
```

Raw log dashboard:

```text
http://127.0.0.1:5601/app/dashboards#/view/hosteye-raw-log-stream
```

Anomaly Detection detectors:

```text
http://127.0.0.1:5601/app/anomaly-detection-dashboards#/detectors
```

OpenSearch raw index API:

```text
http://127.0.0.1:9200/hosteye-raw-windows-v1-*/_search
```
