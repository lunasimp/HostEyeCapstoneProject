const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://host.docker.internal:8080/clickhouse/";
const intervalMs = Number(process.env.BUILD_INTERVAL_MS || 10000);
const lookbackMinutes = Number(process.env.LOOKBACK_MINUTES || 60);
const windowSizeSec = Number(process.env.WINDOW_SIZE_SEC || 300);
const featureSchemaVersion = process.env.FEATURE_SCHEMA_VERSION || "hosteye-feature-v1";

async function ch(sql) {
  const res = await fetch(clickhouseUrl, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}\nSQL=${sql}`);
  return text;
}

async function ensureSchema() {
  await ch(`CREATE TABLE IF NOT EXISTS default.feature_windows
(
  window_id String,
  feature_schema_version String,
  behavior_group String,
  entity_type String,
  entity_id String,
  host_id String,
  window_size_sec UInt32,
  window_start DateTime64(3),
  window_end DateTime64(3),
  watermark_at DateTime64(3),
  computed_at DateTime64(3),
  revision UInt64,
  is_final UInt8,
  total_event_count UInt64,
  unique_event_count UInt64,
  duplicate_event_count UInt64,
  duplicate_record_rate Float64,
  late_event_count UInt64,
  parser_error_count UInt64,
  parser_error_rate Float64,
  ingest_delay_avg_ms Float64,
  ingest_delay_p95_ms Float64,
  ingest_delay_max_ms Float64,
  eps Float64,
  process_create_count UInt64,
  unique_process_count UInt64,
  powershell_event_count UInt64,
  encoded_command_count UInt64,
  lolbin_count UInt64,
  file_create_count UInt64,
  registry_event_count UInt64,
  scheduled_task_event_count UInt64,
  service_install_count UInt64,
  process_access_count UInt64,
  lsass_access_count UInt64,
  remote_thread_count UInt64,
  process_tampering_count UInt64,
  defender_alert_count UInt64,
  network_connection_count UInt64,
  outbound_connection_count UInt64,
  inbound_connection_count UInt64,
  allowed_connection_count UInt64,
  blocked_connection_count UInt64,
  unique_destination_ip_count UInt64,
  unique_destination_port_count UInt64,
  external_destination_count UInt64,
  internal_destination_count UInt64,
  peer_connection_count UInt64,
  peer_first_seen Nullable(DateTime64(3)),
  peer_last_seen Nullable(DateTime64(3)),
  peer_span_sec Nullable(Float64),
  interarrival_count UInt64,
  interarrival_mean_ms Nullable(Float64),
  interarrival_std_ms Nullable(Float64),
  interarrival_cv Nullable(Float64),
  periodicity_score Nullable(Float64),
  reconnect_count UInt64,
  dns_query_count UInt64,
  unique_dns_query_count UInt64,
  dns_failure_count UInt64,
  dns_failure_ratio Float64,
  nxdomain_count UInt64,
  txt_query_count UInt64,
  avg_dns_query_length Float64,
  max_dns_query_length UInt32,
  high_entropy_dns_query_count UInt64,
  successful_logon_count UInt64,
  failed_logon_count UInt64,
  failed_logon_ratio Float64,
  unique_logon_source_count UInt64,
  remote_logon_count UInt64,
  bytes_out Nullable(UInt64),
  bytes_in Nullable(UInt64),
  packets_out Nullable(UInt64),
  packets_in Nullable(UInt64),
  session_duration_avg_ms Nullable(Float64),
  has_flow_telemetry UInt8,
  has_http_telemetry UInt8,
  has_tls_telemetry UInt8,
  evidence_event_ids Array(String),
  evidence_total_count UInt64,
  evidence_truncated UInt8
)
ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(window_start)
ORDER BY (behavior_group, entity_type, entity_id, window_size_sec, window_start, feature_schema_version, window_id)`);

  await ch(`CREATE TABLE IF NOT EXISTS default.feature_window_evidence
(
  window_id String,
  event_key String,
  behavior_group String,
  entity_id String,
  event_time DateTime64(3),
  created_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(event_time)
ORDER BY (window_id, event_key)`);

  await ch(`CREATE TABLE IF NOT EXISTS default.feature_builder_checkpoints
(
  builder_id String,
  checkpoint_time DateTime64(3),
  checkpoint_key String,
  updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY builder_id`);
}

function baseSelect(behaviorGroup, entityType, entityExpr, whereExtra, peerFields) {
  const peer = peerFields || {
    peer_first_seen: "CAST(NULL, 'Nullable(DateTime64(3))')",
    peer_last_seen: "CAST(NULL, 'Nullable(DateTime64(3))')",
    peer_span_sec: "CAST(NULL, 'Nullable(Float64)')",
    peer_connection_count: "toUInt64(0)",
    interarrival_count: "toUInt64(0)",
    interarrival_mean_ms: "CAST(NULL, 'Nullable(Float64)')",
    interarrival_std_ms: "CAST(NULL, 'Nullable(Float64)')",
    interarrival_cv: "CAST(NULL, 'Nullable(Float64)')",
    periodicity_score: "CAST(NULL, 'Nullable(Float64)')",
  };
  return `INSERT INTO default.feature_windows
SELECT
  lower(hex(SHA256(concat('${behaviorGroup}', '|', '${entityType}', '|', ${entityExpr}, '|', toString(${windowSizeSec}), '|', toString(window_start), '|', '${featureSchemaVersion}')))) AS window_id,
  '${featureSchemaVersion}' AS feature_schema_version,
  '${behaviorGroup}' AS behavior_group,
  '${entityType}' AS entity_type,
  ${entityExpr} AS entity_id,
  host_id,
  toUInt32(${windowSizeSec}) AS window_size_sec,
  window_start,
  window_start + INTERVAL ${windowSizeSec} SECOND AS window_end,
  now64(3) AS watermark_at,
  now64(3) AS computed_at,
  toUInt64(toUnixTimestamp64Milli(max(kafka_timestamp))) AS revision,
  toUInt8(1) AS is_final,
  count() AS total_event_count,
  uniqExact(idempotency_key) AS unique_event_count,
  total_event_count - unique_event_count AS duplicate_event_count,
  if(total_event_count = 0, 0, duplicate_event_count / total_event_count) AS duplicate_record_rate,
  toUInt64(0) AS late_event_count,
  toUInt64(0) AS parser_error_count,
  toFloat64(0) AS parser_error_rate,
  avg(dateDiff('millisecond', timestamp, kafka_timestamp)) AS ingest_delay_avg_ms,
  quantile(0.95)(dateDiff('millisecond', timestamp, kafka_timestamp)) AS ingest_delay_p95_ms,
  max(dateDiff('millisecond', timestamp, kafka_timestamp)) AS ingest_delay_max_ms,
  total_event_count / ${windowSizeSec} AS eps,
  countIf(event_id IN (1, 4688)) AS process_create_count,
  uniqExact(process_path) AS unique_process_count,
  countIf(channel LIKE '%PowerShell%' OR event_id = 4104) AS powershell_event_count,
  countIf(positionCaseInsensitive(command_line, 'encodedcommand') > 0 OR positionCaseInsensitive(command_line, '-enc') > 0) AS encoded_command_count,
  countIf(lower(process_path) LIKE '%\\\\rundll32.exe' OR lower(process_path) LIKE '%\\\\regsvr32.exe' OR lower(process_path) LIKE '%\\\\mshta.exe' OR lower(process_path) LIKE '%\\\\powershell.exe') AS lolbin_count,
  countIf(event_id IN (11, 15, 23) OR target_filename != '') AS file_create_count,
  countIf(event_id IN (12, 13, 14) OR target_object != '') AS registry_event_count,
  countIf(channel LIKE '%TaskScheduler%') AS scheduled_task_event_count,
  countIf(event_id = 7045) AS service_install_count,
  countIf(event_id = 10 OR granted_access != '') AS process_access_count,
  countIf(event_id = 10 AND lower(target_image) LIKE '%\\\\lsass.exe') AS lsass_access_count,
  countIf(event_id = 8) AS remote_thread_count,
  countIf(event_id = 25) AS process_tampering_count,
  countIf(channel LIKE '%Defender%') AS defender_alert_count,
  countIf(event_id IN (3, 5156) OR destination_ip != '' OR source_ip != '') AS network_connection_count,
  countIf(destination_ip != '') AS outbound_connection_count,
  countIf(source_ip != '' AND destination_ip = '') AS inbound_connection_count,
  countIf(event_id != 5157) AS allowed_connection_count,
  countIf(event_id = 5157) AS blocked_connection_count,
  uniqExactIf(destination_ip, destination_ip != '') AS unique_destination_ip_count,
  uniqExactIf(destination_port, destination_port != 0) AS unique_destination_port_count,
  countIf(destination_ip != '' AND NOT (startsWith(destination_ip, '10.') OR startsWith(destination_ip, '192.168.') OR startsWith(destination_ip, '172.16.'))) AS external_destination_count,
  countIf(destination_ip != '' AND (startsWith(destination_ip, '10.') OR startsWith(destination_ip, '192.168.') OR startsWith(destination_ip, '172.16.'))) AS internal_destination_count,
  ${peer.peer_connection_count} AS peer_connection_count,
  ${peer.peer_first_seen} AS peer_first_seen,
  ${peer.peer_last_seen} AS peer_last_seen,
  ${peer.peer_span_sec} AS peer_span_sec,
  ${peer.interarrival_count} AS interarrival_count,
  ${peer.interarrival_mean_ms} AS interarrival_mean_ms,
  ${peer.interarrival_std_ms} AS interarrival_std_ms,
  ${peer.interarrival_cv} AS interarrival_cv,
  ${peer.periodicity_score} AS periodicity_score,
  toUInt64(0) AS reconnect_count,
  countIf(event_id = 22 OR dns_query != '') AS dns_query_count,
  uniqExactIf(dns_query, dns_query != '') AS unique_dns_query_count,
  countIf(query_status != '' AND query_status != '0') AS dns_failure_count,
  if(dns_query_count = 0, 0, dns_failure_count / dns_query_count) AS dns_failure_ratio,
  countIf(positionCaseInsensitive(query_status, 'nxdomain') > 0) AS nxdomain_count,
  countIf(endsWith(lower(dns_query), '.txt')) AS txt_query_count,
  avgIf(length(dns_query), dns_query != '') AS avg_dns_query_length,
  max(length(dns_query)) AS max_dns_query_length,
  countIf(length(dns_query) >= 50) AS high_entropy_dns_query_count,
  countIf(event_id = 4624) AS successful_logon_count,
  countIf(event_id = 4625) AS failed_logon_count,
  if(successful_logon_count + failed_logon_count = 0, 0, failed_logon_count / (successful_logon_count + failed_logon_count)) AS failed_logon_ratio,
  toUInt64(0) AS unique_logon_source_count,
  countIf(event_id = 4624) AS remote_logon_count,
  CAST(NULL, 'Nullable(UInt64)') AS bytes_out,
  CAST(NULL, 'Nullable(UInt64)') AS bytes_in,
  CAST(NULL, 'Nullable(UInt64)') AS packets_out,
  CAST(NULL, 'Nullable(UInt64)') AS packets_in,
  CAST(NULL, 'Nullable(Float64)') AS session_duration_avg_ms,
  toUInt8(0) AS has_flow_telemetry,
  toUInt8(0) AS has_http_telemetry,
  toUInt8(0) AS has_tls_telemetry,
  groupUniqArray(100)(idempotency_key) AS evidence_event_ids,
  count() AS evidence_total_count,
  toUInt8(evidence_total_count > 100) AS evidence_truncated
FROM
(
  SELECT *, toStartOfInterval(timestamp, INTERVAL ${windowSizeSec} SECOND) AS window_start
  FROM default.windows_system_logs
  WHERE kafka_timestamp >= now() - INTERVAL ${lookbackMinutes} MINUTE ${whereExtra ? `AND ${whereExtra}` : ""}
)
GROUP BY host_id, entity_id, window_start`;
}

async function buildOnce() {
  await ch(baseSelect("host_activity", "host", "host_id", "host_id != ''"));
  await ch(baseSelect("endpoint_behavior", "host", "host_id", "host_id != ''"));
  await ch(baseSelect("dns_activity", "host", "host_id", "host_id != '' AND (event_id = 22 OR dns_query != '')"));
  await ch(baseSelect("auth_activity", "host", "host_id", "host_id != '' AND channel = 'Security'"));
  await ch(baseSelect("pipeline_quality", "host", "host_id", "host_id != ''"));
  await ch(baseSelect(
    "network_peer",
    "host_destination_peer",
    "concat(host_id, '|', destination_ip, '|', toString(destination_port), '|', protocol)",
    "host_id != '' AND destination_ip != ''",
    {
      peer_connection_count: "count()",
      peer_first_seen: "min(timestamp)",
      peer_last_seen: "max(timestamp)",
      peer_span_sec: "dateDiff('second', min(timestamp), max(timestamp))",
      interarrival_count: "if(count() >= 5, count() - 1, 0)",
      interarrival_mean_ms: "if(count() >= 5, dateDiff('millisecond', min(timestamp), max(timestamp)) / (count() - 1), CAST(NULL, 'Nullable(Float64)'))",
      interarrival_std_ms: "if(count() >= 5, toFloat64(0), CAST(NULL, 'Nullable(Float64)'))",
      interarrival_cv: "if(count() >= 5, toFloat64(0), CAST(NULL, 'Nullable(Float64)'))",
      periodicity_score: "if(count() >= 5, toFloat64(1), CAST(NULL, 'Nullable(Float64)'))",
    }
  ));
  await ch(`INSERT INTO default.feature_builder_checkpoints (builder_id, checkpoint_time, checkpoint_key) VALUES ('feature-builder-local', now64(3), '')`);
}

async function main() {
  console.log(`feature-builder starting clickhouse=${clickhouseUrl} intervalMs=${intervalMs}`);
  await ensureSchema();
  while (true) {
    try {
      await buildOnce();
      const count = await ch("SELECT count() AS rows FROM default.feature_windows FORMAT JSONEachRow");
      console.log(`feature-builder wrote features ${count.trim()}`);
    } catch (err) {
      console.error(`feature-builder error: ${err.stack || err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


