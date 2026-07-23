-- 010_agent_chunk_errors.sql
-- Bảng lưu metadata các chunk bị Agent cách ly (lỗi 400/409 từ Data Plane).
-- KHÔNG lưu nội dung chunk, chỉ lưu metadata để hiển thị trên Dashboard.
-- Agent gửi batch 5 lỗi lên POST /api/v1/agent/telemetry/errors sau đó xóa file khỏi spool.

CREATE TABLE IF NOT EXISTS default.agent_chunk_errors
(
    reported_at    DateTime64(3, 'UTC'),
    agent_id       LowCardinality(String),
    chunk_id       String,
    -- Các giá trị có thể: checksum_invalid | event_count_mismatch | missing_fields | schema_invalid | conflict_409
    error_type     LowCardinality(String),
    quarantined_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(reported_at)
ORDER BY (agent_id, reported_at)
TTL reported_at + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
