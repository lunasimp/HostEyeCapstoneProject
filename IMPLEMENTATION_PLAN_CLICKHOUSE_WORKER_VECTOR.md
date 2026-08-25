# Implementation Plan: ClickHouse Analytic Schema, Worker Logic & Vector Migration

## 0. Muc tieu

Tai lieu nay lap ke hoach thiet ke lai cac bang ClickHouse lien quan den:

- `suppression_state`: tom tat duplicate ma khong xoa log goc.
- `process_context_edges` / `network_context_edges`: graph duoc Worker build co ngu canh, khong phu thuoc vao Materialized View "copy dong".
- Analytic views: cac view cho Dashboard/SOC query du lieu sach, nhanh, nhung van giu duong truy vet forensic day du.
- Worker business logic: suppression, context builder, wait Vector persist.
- Vector input migration: chi Worker duoc POST vao Vector, khong con Nginx proxy thang sang Vector.

Nguyen tac quan trong:

> `windows_system_logs` la kho forensic chinh va phai giu 100% event sau khi Vector normalize, ke ca duplicate. Suppression khong xoa, khong chan, khong UPDATE bang forensic nay. Suppression chi tao read-model phu de analytic layer hien thi gon hon.

## 1. Hien trang ClickHouse

Thu muc schema hien tai: `Vector-HA-Cluster/clickhouse-init`.

### 1.1 Bang hien co

- `windows_system_logs`: kho event Windows chinh, duoc Vector ghi sau khi normalize.
- `shipper_runtime_metrics`: metric suc khoe Agent/Shipper.
- `ingest_chunks`: tracking trang thai tung chunk.
- `raw_chunk_vault`: audit path/file hash cua raw `.json.gz`.
- `registered_agents`: danh sach agent va trang thai enrollment/check-in.
- `admission_decisions`: lich su admission/rate-limit decision.
- `process_context_edges`: hien dang la bang copy mot phan process fields tu `windows_system_logs`.
- `network_context_edges`: hien dang la bang copy mot phan network fields tu `windows_system_logs`.

### 1.2 Normal views hien co

Trong `001_schema.sql` dang co cac view theo domain:

- `dns_events`
- `endpoint_events`
- `file_events`
- `network_events`
- `powershell_events`
- `process_access_events`
- `process_events`
- `registry_events`
- `security_overview_events`

Nhung cac view nay hien doc truc tiep tu `windows_system_logs`, nen chua biet suppression. Neu dashboard dung cac view nay se van thay duplicate.

### 1.3 Materialized views hien co

Trong `004_server_processing_quality.sql` dang co:

- `process_context_edges_mv`
- `network_context_edges_mv`

Hai MV nay tu dong copy event moi tu `windows_system_logs` vao bang edge. Thiet ke nay chua du vi:

- MV chi nhin thay batch insert hien tai, khong chu dong query lai cua so thoi gian `-5m/+5m`.
- MV khong duoc sinh ra de lam correlation co trang thai, nhu process parent-child lookup, network timestamp matching `+-1s`, file/registry relation.
- Bang edge hien tai thieu cac field cua mot edge dung nghia: `edge_type`, `source_event_key`, `target_event_key`, `confidence`, `evidence`, `context_window`.

## 2. Thiet ke ClickHouse moi

Them migration moi:

`Vector-HA-Cluster/clickhouse-init/009_worker_analytic_schema.sql`

### 2.1 `suppression_state`

Muc dich: moi row dai dien cho trang thai moi nhat cua mot duplicate fingerprint trong mot time window. Worker chi `INSERT`, khong dung `ALTER TABLE UPDATE`.

De xuat schema:

```sql
CREATE TABLE IF NOT EXISTS default.suppression_state
(
    kafka_timestamp DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3),

    fingerprint String,
    window_start DateTime64(3),
    window_end DateTime64(3),

    agent_id String DEFAULT '',
    host_id String DEFAULT '',
    computer String DEFAULT '',
    channel String DEFAULT '',
    event_id UInt32 DEFAULT 0,
    record_id UInt64 DEFAULT 0,
    user_name String DEFAULT '',

    first_seen DateTime64(3),
    last_seen DateTime64(3),

    representative_event_key String DEFAULT '',
    representative_chunk_id String DEFAULT '',
    representative_record_id UInt64 DEFAULT 0,
    representative_event_json String DEFAULT '',

    suppressed_count UInt32 DEFAULT 0,
    total_count UInt32 DEFAULT 1,

    rule_id String DEFAULT 'event_fingerprint_v1',
    rule_version String DEFAULT '1',
    bypassed UInt8 DEFAULT 0,
    bypass_reason String DEFAULT ''
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(window_start)
ORDER BY (fingerprint, window_start, host_id)
TTL updated_at + toIntervalDay(90)
SETTINGS index_granularity = 8192;
```

Ghi chu:

- `suppressed_count`: so event duplicate bi gop, khong tinh representative.
- `total_count`: `suppressed_count + 1`.
- `representative_event_key`: join ve `windows_system_logs.idempotency_key`.
- `representative_event_json`: snapshot phuc vu dashboard nhanh, nhung source of truth van la `windows_system_logs`.
- `bypassed`: danh dau cac rule skip neu sau nay muon ghi audit. Phase dau co the khong insert bypassed Sysmon vao bang nay.

### 2.2 Latest view cho suppression

Khong nen bat Dashboard query `suppression_state FINAL` truc tiep neu traffic cao. Tao view gom row moi nhat bang `argMax`:

```sql
CREATE VIEW IF NOT EXISTS default.v_suppression_latest AS
SELECT
    fingerprint,
    window_start,
    host_id,
    argMax(window_end, updated_at) AS window_end,
    argMax(agent_id, updated_at) AS agent_id,
    argMax(computer, updated_at) AS computer,
    argMax(channel, updated_at) AS channel,
    argMax(event_id, updated_at) AS event_id,
    argMax(record_id, updated_at) AS record_id,
    argMax(user_name, updated_at) AS user_name,
    argMax(first_seen, updated_at) AS first_seen,
    argMax(last_seen, updated_at) AS last_seen,
    argMax(representative_event_key, updated_at) AS representative_event_key,
    argMax(representative_chunk_id, updated_at) AS representative_chunk_id,
    argMax(representative_record_id, updated_at) AS representative_record_id,
    argMax(representative_event_json, updated_at) AS representative_event_json,
    argMax(suppressed_count, updated_at) AS suppressed_count,
    argMax(total_count, updated_at) AS total_count,
    max(updated_at) AS updated_at
FROM default.suppression_state
GROUP BY fingerprint, window_start, host_id;
```

Ly do dung view nay:

- Tranh `FINAL` trong dashboard query mac dinh.
- Vua dung voi `ReplacingMergeTree`, vua de doc va debug.
- Neu sau nay dashboard qua nang, co the nang cap thanh bang read-model worker-maintained.

### 2.3 Clean analytic view

Muc tieu: Dashboard/SOC query view nay thay vi query truc tiep `windows_system_logs` khi can UI khong lap.

De xuat tao:

`default.v_clean_system_logs`

Logic:

- Lay representative event tu `v_suppression_latest`.
- Join representative ve `windows_system_logs` bang `representative_event_key = idempotency_key`.
- Include metadata: `suppressed_count`, `total_count`, `first_seen`, `last_seen`, `suppression_fingerprint`.
- Include critical Sysmon bypass events truc tiep tu `windows_system_logs`, vi cac event nay luon giu full event va khong suppression.

Pseudo SQL:

```sql
CREATE VIEW IF NOT EXISTS default.v_clean_system_logs AS
SELECT
    w.*,
    s.fingerprint AS suppression_fingerprint,
    s.suppressed_count AS suppressed_count_effective,
    s.total_count AS total_count_effective,
    s.first_seen AS suppression_first_seen,
    s.last_seen AS suppression_last_seen,
    1 AS is_representative,
    0 AS is_suppression_bypassed
FROM default.v_suppression_latest s
INNER JOIN default.windows_system_logs w
    ON w.idempotency_key = s.representative_event_key

UNION ALL

SELECT
    w.*,
    '' AS suppression_fingerprint,
    0 AS suppressed_count_effective,
    1 AS total_count_effective,
    w.timestamp AS suppression_first_seen,
    w.timestamp AS suppression_last_seen,
    1 AS is_representative,
    1 AS is_suppression_bypassed
FROM default.windows_system_logs w
WHERE w.channel = 'Microsoft-Windows-Sysmon/Operational'
  AND w.event_id IN (1, 3, 7, 11, 25);
```

Can than:

- Neu mot critical Sysmon event cung duoc insert vao `suppression_state` trong tuong lai, view tren co the duplicate. Phase dau nen Worker khong insert bypassed event vao `suppression_state`.
- View nay phu hop analytic/dashboard. Forensic export van query `windows_system_logs`.

### 2.4 Domain analytic views

Sau khi co `v_clean_system_logs`, tao lai cac domain view analytic doc tu view sach:

- `v_clean_dns_events`
- `v_clean_process_events`
- `v_clean_network_events`
- `v_clean_file_events`
- `v_clean_registry_events`
- `v_clean_powershell_events`
- `v_clean_security_overview_events`

Vi du:

```sql
CREATE VIEW IF NOT EXISTS default.v_clean_process_events AS
SELECT *
FROM default.v_clean_system_logs
WHERE channel = 'Microsoft-Windows-Sysmon/Operational'
  AND event_id IN (1, 5, 7, 8, 10, 11, 25);
```

Quy uoc:

- View cu nhu `process_events`, `network_events` co the giu lai de backward compatibility.
- Dashboard moi nen chuyen sang `v_clean_*`.
- API nen expose option `mode=clean|forensic`, trong do `clean` doc `v_clean_*`, `forensic` doc `windows_system_logs` hoac view cu.

### 2.5 Redesign context edge tables

Khong tiep tuc dung MV copy event thanh edge. Worker se tu tinh correlation va insert edge dung nghia.

Migration nen:

```sql
DROP VIEW IF EXISTS default.process_context_edges_mv;
DROP VIEW IF EXISTS default.network_context_edges_mv;
```

Sau do tao/alter bang edge co field ro rang. Neu muon tranh migration pha du lieu cu, tao bang moi:

- `worker_process_context_edges`
- `worker_network_context_edges`

Neu chap nhan thay schema cu, drop/recreate `process_context_edges` va `network_context_edges`.

De xuat schema process edges:

```sql
CREATE TABLE IF NOT EXISTS default.process_context_edges
(
    kafka_timestamp DateTime64(3) DEFAULT now64(3),
    built_at DateTime64(3) DEFAULT now64(3),
    context_window_start DateTime64(3),
    context_window_end DateTime64(3),

    edge_id String,
    edge_type LowCardinality(String),
    confidence Float32 DEFAULT 1.0,
    evidence String DEFAULT '',

    agent_id String DEFAULT '',
    host_id String DEFAULT '',
    computer String DEFAULT '',

    source_event_key String DEFAULT '',
    target_event_key String DEFAULT '',

    source_process_guid String DEFAULT '',
    target_process_guid String DEFAULT '',
    parent_process_guid String DEFAULT '',
    process_guid String DEFAULT '',

    source_process_path String DEFAULT '',
    target_process_path String DEFAULT '',
    command_line String DEFAULT '',

    target_file String DEFAULT '',
    target_registry_key String DEFAULT '',

    chunk_id String DEFAULT '',
    builder_version String DEFAULT 'context-builder-v1'
)
ENGINE = ReplacingMergeTree(built_at)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (host_id, edge_type, source_event_key, target_event_key, edge_id)
TTL kafka_timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192;
```

Edge types toi thieu:

- `SPAWNS`: parent process -> child process.
- `LOADS_IMAGE`: process -> image/DLL load.
- `TOUCHES_FILE`: process -> file event.
- `TOUCHES_REGISTRY`: process -> registry event.
- `ACCESSES_PROCESS`: source process -> target process.

De xuat schema network edges:

```sql
CREATE TABLE IF NOT EXISTS default.network_context_edges
(
    kafka_timestamp DateTime64(3) DEFAULT now64(3),
    built_at DateTime64(3) DEFAULT now64(3),
    context_window_start DateTime64(3),
    context_window_end DateTime64(3),

    edge_id String,
    edge_type LowCardinality(String) DEFAULT 'CONNECTS_TO',
    confidence Float32 DEFAULT 1.0,
    match_delta_ms Int32 DEFAULT 0,
    evidence String DEFAULT '',

    agent_id String DEFAULT '',
    host_id String DEFAULT '',
    computer String DEFAULT '',

    process_event_key String DEFAULT '',
    network_event_key String DEFAULT '',
    process_guid String DEFAULT '',
    process_path String DEFAULT '',
    process_name String DEFAULT '',

    source_ip String DEFAULT '',
    source_port UInt32 DEFAULT 0,
    destination_ip String DEFAULT '',
    destination_port UInt32 DEFAULT 0,
    protocol String DEFAULT '',

    chunk_id String DEFAULT '',
    builder_version String DEFAULT 'context-builder-v1'
)
ENGINE = ReplacingMergeTree(built_at)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (host_id, process_guid, destination_ip, destination_port, network_event_key, edge_id)
TTL kafka_timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192;
```

### 2.6 Graph analytic views

Tao view cho dashboard graph:

- `v_process_graph_edges`: doc `process_context_edges`, join label tu `v_clean_system_logs` neu can.
- `v_network_graph_edges`: doc `network_context_edges`, co san source/target labels.
- `v_host_activity_timeline`: hop nhat `v_clean_system_logs` + edge metadata theo `host_id`, `timestamp`.

Nguyen tac:

- View graph nen doc tu bang edge Worker ghi, khong join nguoc qua nhieu bang neu UI can realtime.
- Neu dashboard cham, Worker nen ghi them denormalized labels vao edge table de UI doc mot bang la du.

## 3. Worker Suppression

Tao file:

`HostEyeBackend/src/worker/suppression.rs`

Them module:

`HostEyeBackend/src/worker/mod.rs`

```rust
pub mod suppression;
```

Logic:

1. Input la list enriched events sau khi Vector da persist vao `windows_system_logs`.
2. Bo qua suppression cho Sysmon EID `1, 3, 7, 11, 25`.
3. Tinh fingerprint:

```text
sha256(computer + "|" + channel + "|" + event_id + "|" + record_id + "|" + user_name)
```

4. Query `v_suppression_latest` hoac `suppression_state FINAL` theo:

```sql
WHERE fingerprint = ?
  AND host_id = ?
  AND window_start <= event_timestamp
  AND window_end >= event_timestamp
```

5. Neu trung trong time window:

- Insert replacement state row voi `suppressed_count + 1`.
- Khong xoa event goc trong `windows_system_logs`.
- Return event vao list `suppressed`.

6. Neu moi:

- Insert representative state row voi `suppressed_count = 0`, `total_count = 1`.
- Return event vao list `kept`.

Luu y concurrency:

- Phase dau co the chap nhan race nho neu chi co mot raw worker instance.
- Neu scale nhieu worker, can chuyen sang event observation ledger hoac partition/route job theo `host_id` de tranh lost increment.

## 4. Wait Vector Persist

Chinh sua:

`HostEyeBackend/src/worker/processor.rs`

Sau `forward_to_vector(...)`, them ham:

```rust
wait_for_vector_persist(ch, chunk_id, expected_count, timeout_ms)
```

Query lap lai:

```sql
SELECT count()
FROM default.windows_system_logs
WHERE chunk_id = ?
```

Default:

- interval: `200ms`
- timeout: `10s`
- expected count: `enriched.len()`

Neu timeout:

- Insert `ingest_chunks` status `worker_vector_persist_timeout`.
- Return error de Worker khong chay suppression/context voi du lieu chua san sang.
- Khong commit offset neu policy muon retry. Neu muon bo qua message loi doc lap, commit offset sau khi ghi failed status can duoc quy dinh ro.

## 5. Worker Context Builder

Tao file:

`HostEyeBackend/src/worker/context_builder.rs`

Them module:

```rust
pub mod context_builder;
```

Logic:

1. Chay sau suppression.
2. Chi dung list `kept`/representative events de lam seed.
3. Chay async background bang `tokio::spawn`, khong block pipeline chinh.
4. Query `windows_system_logs` cung `host_id` trong window:

```text
min(seed.timestamp) - 5 minutes
max(seed.timestamp) + 5 minutes
```

5. Build maps:

- `process_guid -> process create event`
- `process_guid -> parent_process_guid`
- `process_guid -> network events`
- `process_guid -> file/registry/process-access events`

6. Insert edges:

- `SPAWNS`: `parent_process_guid -> process_guid`.
- `CONNECTS_TO`: `process_guid -> destination_ip:port` voi timestamp delta `+-1s`.
- `TOUCHES_FILE`: `process_guid -> target_filename`.
- `TOUCHES_REGISTRY`: `process_guid -> target_object`.
- `ACCESSES_PROCESS`: `process_guid -> target_process_guid`.

Error policy:

- Context Builder loi thi log va ghi metric/status rieng, khong lam fail ingest forensic.
- Suppression loi thi nen fail job de tranh analytic state bi lech.

## 6. Lap rap pipeline Worker

Chinh sua:

`HostEyeBackend/src/worker/processor.rs`

Thu tu moi trong `process_job()`:

1. Doc raw `.json.gz`.
2. Verify `raw_sha256`, `chunk_id`, `checksum`, `event_count`.
3. `enrich_events()`.
4. `forward_to_vector()`.
5. Wait Vector persist vao `windows_system_logs`.
6. Insert tracking `worker_index_queued`.
7. Run suppression.
8. Spawn context builder.
9. Insert tracking `indexed`.
10. Return `Ok(())` de worker index commit offset.

Trang thai tracking de them:

- `worker_index_queued`
- `worker_vector_persist_timeout`
- `worker_suppression_failed`
- `worker_context_queued`
- `indexed`

## 7. Vector Input Migration

Chinh sua:

`Vector-HA-Cluster/vector-gateway.toml`

Thay:

```toml
[sources.from_nginx_lb]
type = "http_server"
address = "0.0.0.0:8686"
```

Bang:

```toml
[sources.from_worker]
type = "http_server"
address = "0.0.0.0:8686"
```

Va thay tat ca:

```toml
inputs = ["from_nginx_lb"]
```

Bang:

```toml
inputs = ["from_worker"]
```

Luu y:

- `prepare_batch` phai doc tu `from_worker`.
- `raw_forensic_vault` neu con can giu raw Vector input thi cung doc tu `from_worker`.
- Forensic source chinh van la `raw_chunk_vault` + raw chunk file, khong phai file sink cua Vector.

## 8. Nginx Cleanup

Chinh sua:

`Vector-HA-Cluster/nginx.conf`

Cong viec:

- Xoa `upstream vector_gateways` neu khong con location nao dung.
- Xac nhan khong co route proxy public nao den Vector `:8686`.
- Giu route Agent -> Collector qua `/api/v1/telemetry/...`.
- Giu route Control Plane va Dashboard neu dang dung.

Muc tieu bao mat:

- Agent khong bao gio goi Vector truc tiep.
- Vector chi nhan traffic noi bo Docker network tu Worker.
- Nginx chi terminate mTLS va route sang Collector/Control Plane/Dashboard.

## 9. Verification Plan

### 9.1 Static verification

- `cargo fmt` trong `HostEyeBackend`.
- `cargo check` hoac `cargo test` trong `HostEyeBackend`.
- Validate Vector config.
- Validate ClickHouse SQL migration bang container ClickHouse local.

### 9.2 Pipeline verification

1. Gui chunk hop le.
2. Kiem tra `raw_chunk_vault` co row.
3. Kiem tra `ingest_chunks`: `raw_stored -> broker_queued -> worker_index_queued -> indexed`.
4. Kiem tra `windows_system_logs` co du `event_count` theo `chunk_id`.
5. Kiem tra `suppression_state` co representative cho non-critical event.
6. Gui duplicate non-critical trong cung window, kiem tra `suppressed_count` tang.
7. Gui Sysmon EID `1, 3, 7, 11, 25`, kiem tra khong bi gop trong clean view.
8. Kiem tra `v_clean_system_logs` chi hien representative + critical bypass events.
9. Kiem tra `process_context_edges` / `network_context_edges` co edge dung `host_id`, `process_guid`, `idempotency_key`.

### 9.3 Analytic verification

Dashboard/API can test 2 mode:

- `clean`: query `v_clean_*`, dung cho UI mac dinh.
- `forensic`: query `windows_system_logs`, dung de export day du bang chung.

Query mau:

```sql
SELECT
    timestamp,
    computer,
    event_id,
    process_name,
    command_line,
    suppressed_count_effective,
    total_count_effective
FROM default.v_clean_system_logs
WHERE timestamp >= now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC
LIMIT 200;
```

Forensic query mau:

```sql
SELECT *
FROM default.windows_system_logs
WHERE chunk_id = '...'
ORDER BY timestamp, record_id;
```

## 10. Thu tu trien khai de giam rui ro

1. Them migration `009_worker_analytic_schema.sql`, chua sua Worker.
2. Tao storage row structs cho `suppression_state` va edge tables.
3. Them `wait_for_vector_persist()`.
4. Them `worker/suppression.rs`.
5. Them `worker/context_builder.rs`.
6. Noi vao `process_job()`.
7. Tao `v_suppression_latest`, `v_clean_system_logs`, `v_clean_*`.
8. Migrate Dashboard/API sang `v_clean_*` theo mode `clean`; giu forensic mode doc `windows_system_logs`.
9. Doi `vector-gateway.toml` source `from_nginx_lb -> from_worker`.
10. Don `nginx.conf`.
11. Chay verification end-to-end.

## 11. Ngoai pham vi cua plan nay

- Agent-side response handling cho `400`, `409`, `413`, `429`, `403`, `500`.
- Toi uu distributed ClickHouse/sharding.
- Multi-worker race-free counter tuyet doi. Neu can scale nhieu worker, can them host-based partitioning hoac suppression observation ledger.

