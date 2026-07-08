ALTER TABLE default.windows_system_logs
    ADD COLUMN IF NOT EXISTS schema_version String DEFAULT '' AFTER source_platform,
    ADD COLUMN IF NOT EXISTS parser_status String DEFAULT 'unknown' AFTER schema_version,
    ADD COLUMN IF NOT EXISTS parser_error String DEFAULT '' AFTER parser_status,
    ADD COLUMN IF NOT EXISTS validation_errors String DEFAULT '' AFTER parser_error,
    ADD COLUMN IF NOT EXISTS chunk_id String DEFAULT '' AFTER validation_errors,
    ADD COLUMN IF NOT EXISTS chunk_checksum String DEFAULT '' AFTER chunk_id,
    ADD COLUMN IF NOT EXISTS sequence_number UInt64 DEFAULT 0 AFTER chunk_checksum,
    ADD COLUMN IF NOT EXISTS suppression_rule_id String DEFAULT '' AFTER idempotency_key,
    ADD COLUMN IF NOT EXISTS suppression_rule_version String DEFAULT '' AFTER suppression_rule_id,
    ADD COLUMN IF NOT EXISTS suppressed_count UInt32 DEFAULT 0 AFTER suppression_rule_version,
    ADD COLUMN IF NOT EXISTS first_seen DateTime64(3) DEFAULT timestamp AFTER suppressed_count,
    ADD COLUMN IF NOT EXISTS last_seen DateTime64(3) DEFAULT timestamp AFTER first_seen;

CREATE TABLE IF NOT EXISTS default.process_context_edges
(
    `kafka_timestamp` DateTime64(3) DEFAULT now64(3),
    `timestamp` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `user_name` String DEFAULT '',
    `process_guid` String DEFAULT '',
    `parent_process_guid` String DEFAULT '',
    `process_id` UInt32 DEFAULT 0,
    `parent_process_id` UInt32 DEFAULT 0,
    `process_name` String DEFAULT '',
    `process_path` String DEFAULT '',
    `parent_process_path` String DEFAULT '',
    `command_line` String DEFAULT '',
    `event_id` UInt32 DEFAULT 0,
    `record_id` UInt64 DEFAULT 0,
    `idempotency_key` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(kafka_timestamp)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (computer, process_guid, parent_process_guid, timestamp, idempotency_key)
TTL kafka_timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS default.process_context_edges_mv
TO default.process_context_edges
AS
SELECT
    kafka_timestamp,
    timestamp,
    agent_id,
    host_id,
    computer,
    user_name,
    process_guid,
    parent_process_guid,
    process_id,
    parent_process_id,
    process_name,
    process_path,
    parent_process_path,
    command_line,
    event_id,
    record_id,
    idempotency_key
FROM default.windows_system_logs
WHERE (process_guid != '' OR parent_process_guid != '')
  AND parser_status != 'invalid';

CREATE TABLE IF NOT EXISTS default.network_context_edges
(
    `kafka_timestamp` DateTime64(3) DEFAULT now64(3),
    `timestamp` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `process_guid` String DEFAULT '',
    `process_name` String DEFAULT '',
    `process_path` String DEFAULT '',
    `source_ip` String DEFAULT '',
    `source_port` UInt32 DEFAULT 0,
    `destination_ip` String DEFAULT '',
    `destination_port` UInt32 DEFAULT 0,
    `protocol` String DEFAULT '',
    `event_id` UInt32 DEFAULT 0,
    `record_id` UInt64 DEFAULT 0,
    `idempotency_key` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(kafka_timestamp)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (computer, destination_ip, destination_port, timestamp, idempotency_key)
TTL kafka_timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS default.network_context_edges_mv
TO default.network_context_edges
AS
SELECT
    kafka_timestamp,
    timestamp,
    agent_id,
    host_id,
    computer,
    process_guid,
    process_name,
    process_path,
    source_ip,
    source_port,
    destination_ip,
    destination_port,
    protocol,
    event_id,
    record_id,
    idempotency_key
FROM default.windows_system_logs
WHERE (source_ip != '' OR destination_ip != '')
  AND parser_status != 'invalid';
