CREATE TABLE IF NOT EXISTS default.raw_chunk_vault
(
    `kafka_timestamp` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `chunk_id` String DEFAULT '',
    `checksum` String DEFAULT '',
    `event_count` UInt32 DEFAULT 0,
    `sequence_number` UInt64 DEFAULT 0,
    `schema_version` String DEFAULT '',
    `raw_path` String DEFAULT '',
    `raw_size_bytes` UInt64 DEFAULT 0,
    `compressed_size_bytes` UInt64 DEFAULT 0,
    `compression` String DEFAULT 'gzip',
    `raw_sha256` String DEFAULT '',
    `status` String DEFAULT '',
    `message` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(kafka_timestamp)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (agent_id, chunk_id)
TTL kafka_timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS default.admission_decisions
(
    `decided_at` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `queue_used_mb` Float64 DEFAULT 0,
    `next_chunk_size_mb` Float64 DEFAULT 0,
    `retry_count` UInt32 DEFAULT 0,
    `rank` UInt32 DEFAULT 0,
    `active_uploads` UInt32 DEFAULT 0,
    `max_active_uploads` UInt32 DEFAULT 0,
    `decision` String DEFAULT '',
    `lease_id` String DEFAULT '',
    `lease_ttl_seconds` UInt32 DEFAULT 0,
    `retry_after_seconds` UInt32 DEFAULT 0,
    `message` String DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(decided_at)
ORDER BY (decided_at, agent_id, computer)
TTL decided_at + toIntervalDay(30)
SETTINGS index_granularity = 8192;

ALTER TABLE default.shipper_runtime_metrics
    ADD COLUMN IF NOT EXISTS byte_offset UInt64 DEFAULT 0 AFTER next_line_offset,
    ADD COLUMN IF NOT EXISTS next_byte_offset UInt64 DEFAULT 0 AFTER byte_offset;
