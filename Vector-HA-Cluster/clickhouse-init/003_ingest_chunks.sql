CREATE TABLE IF NOT EXISTS default.ingest_chunks
(
    `kafka_timestamp` DateTime64(3) DEFAULT now64(3),
    `first_seen` DateTime64(3) DEFAULT now64(3),
    `last_seen` DateTime64(3) DEFAULT now64(3),
    `agent_id` String DEFAULT '',
    `host_id` String DEFAULT '',
    `computer` String DEFAULT '',
    `chunk_id` String DEFAULT '',
    `sequence_number` UInt64 DEFAULT 0,
    `checksum` String DEFAULT '',
    `event_count` UInt32 DEFAULT 0,
    `status` String DEFAULT '',
    `duplicate` UInt8 DEFAULT 0,
    `attempts` UInt32 DEFAULT 1,
    `message` String DEFAULT ''
)
ENGINE = ReplacingMergeTree(last_seen)
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (agent_id, chunk_id)
TTL kafka_timestamp + toIntervalDay(30)
SETTINGS index_granularity = 8192;

ALTER TABLE default.shipper_runtime_metrics
    ADD COLUMN IF NOT EXISTS chunk_id String DEFAULT '' AFTER next_line_offset,
    ADD COLUMN IF NOT EXISTS chunk_checksum String DEFAULT '' AFTER chunk_id,
    ADD COLUMN IF NOT EXISTS sequence_number UInt64 DEFAULT 0 AFTER chunk_checksum,
    ADD COLUMN IF NOT EXISTS ack_status String DEFAULT '' AFTER sequence_number;
