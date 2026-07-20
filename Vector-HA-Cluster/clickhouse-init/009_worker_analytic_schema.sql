-- Migration 009: Tái cấu trúc Schema cho Worker Analytics

-- 1. Xóa các Materialized Views cũ (do Worker sẽ tự build Context Graph)
DROP VIEW IF EXISTS default.process_context_edges_mv;
DROP VIEW IF EXISTS default.network_context_edges_mv;

-- 2. Bảng suppression_state: Lưu trạng thái của event deduplication (fingerprint)
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
    
    suppressed_count UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(window_start)
ORDER BY (computer, fingerprint, window_start)
TTL window_start + toIntervalDay(30)
SETTINGS index_granularity = 8192;

-- 3. Bảng context_edges: Hỗ trợ đồ thị thực thụ
CREATE TABLE IF NOT EXISTS default.context_edges
(
    edge_timestamp DateTime64(3) DEFAULT now64(3),
    computer String,
    
    edge_type String, -- 'process_child', 'process_network', 'process_file', v.v.
    source_event_key String,
    target_event_key String,
    
    source_guid String DEFAULT '',
    target_guid String DEFAULT '',
    
    confidence UInt8 DEFAULT 100,
    evidence String DEFAULT '',
    context_window_ms Int32 DEFAULT 300000 -- Khoảng thời gian correlation (mặc định 5 phút)
)
ENGINE = ReplacingMergeTree(edge_timestamp)
PARTITION BY toYYYYMM(edge_timestamp)
ORDER BY (computer, edge_type, source_guid, target_guid)
TTL edge_timestamp + toIntervalDay(90)
SETTINGS index_granularity = 8192;

-- 4. Cập nhật các Analytic Views để sử dụng suppression_state 
-- Lọc các log thừa, chỉ giữ lại event đầu tiên (representative) hoặc các event không đi qua suppression.
-- Lưu ý: event không qua suppression sẽ có suppression_rule_id = 'bypassed' hoặc không map vào suppression_state.

CREATE OR REPLACE VIEW default.process_events_analytic AS
SELECT w.*, s.suppressed_count
FROM default.windows_system_logs w
LEFT JOIN default.suppression_state s 
  ON w.idempotency_key = s.representative_event_key
WHERE (w.channel = 'Microsoft-Windows-Sysmon/Operational' AND w.event_id IN (1, 5, 7, 8, 10, 11, 25))
  AND (s.representative_event_key IS NOT NULL OR w.suppression_rule_id = 'bypassed');

CREATE OR REPLACE VIEW default.network_events_analytic AS
SELECT w.*, s.suppressed_count
FROM default.windows_system_logs w
LEFT JOIN default.suppression_state s 
  ON w.idempotency_key = s.representative_event_key
WHERE ((w.destination_ip != '') OR (w.source_ip != '') OR (w.event_id IN (3, 5156)))
  AND (s.representative_event_key IS NOT NULL OR w.suppression_rule_id = 'bypassed');

CREATE OR REPLACE VIEW default.file_events_analytic AS
SELECT w.*, s.suppressed_count
FROM default.windows_system_logs w
LEFT JOIN default.suppression_state s 
  ON w.idempotency_key = s.representative_event_key
WHERE ((w.target_filename != '') OR (w.event_id IN (11, 15, 23)))
  AND (s.representative_event_key IS NOT NULL OR w.suppression_rule_id = 'bypassed');

CREATE OR REPLACE VIEW default.registry_events_analytic AS
SELECT w.*, s.suppressed_count
FROM default.windows_system_logs w
LEFT JOIN default.suppression_state s 
  ON w.idempotency_key = s.representative_event_key
WHERE ((w.target_object != '') OR (w.event_id IN (12, 13, 14)))
  AND (s.representative_event_key IS NOT NULL OR w.suppression_rule_id = 'bypassed');

-- Giữ nguyên bảng process_context_edges/network_context_edges cũ để tránh lỗi (nhưng không nạp dữ liệu nữa)
