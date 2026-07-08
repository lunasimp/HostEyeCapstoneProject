CREATE TABLE IF NOT EXISTS default.registered_agents
(
    `first_seen` DateTime64(3) DEFAULT now64(3),
    `last_seen` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `cert_serial` String DEFAULT '',
    `schema_version` String DEFAULT '',
    `source_platform` String DEFAULT '',
    `shipper_version` String DEFAULT '',
    `status` String DEFAULT 'active',
    `enrollment_status` String DEFAULT 'auto_registered',
    `last_chunk_id` String DEFAULT '',
    `last_ack_status` String DEFAULT '',
    `last_event_count` UInt32 DEFAULT 0,
    `normal_jitter_window_ms` UInt32 DEFAULT 0,
    `recovery_jitter_window_ms` UInt32 DEFAULT 0,
    `max_events` UInt32 DEFAULT 0,
    `max_bytes` UInt64 DEFAULT 0,
    `message` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(last_seen)
PARTITION BY toYYYYMM(last_seen)
ORDER BY (agent_id, host_id, computer)
TTL last_seen + toIntervalDay(180)
SETTINGS index_granularity = 8192;

ALTER TABLE default.shipper_runtime_metrics
    ADD COLUMN IF NOT EXISTS scheduled_send_at DateTime64(3) DEFAULT metric_timestamp AFTER ack_status,
    ADD COLUMN IF NOT EXISTS actual_send_at DateTime64(3) DEFAULT metric_timestamp AFTER scheduled_send_at,
    ADD COLUMN IF NOT EXISTS send_started_at DateTime64(3) DEFAULT metric_timestamp AFTER actual_send_at,
    ADD COLUMN IF NOT EXISTS send_completed_at DateTime64(3) DEFAULT metric_timestamp AFTER send_started_at,
    ADD COLUMN IF NOT EXISTS jitter_delay_ms UInt32 DEFAULT 0 AFTER send_completed_at,
    ADD COLUMN IF NOT EXISTS backoff_delay_ms UInt32 DEFAULT 0 AFTER jitter_delay_ms,
    ADD COLUMN IF NOT EXISTS next_retry_at DateTime64(3) DEFAULT metric_timestamp AFTER backoff_delay_ms;
