ALTER TABLE default.admission_decisions
    ADD COLUMN IF NOT EXISTS loss_metrics_version UInt8 DEFAULT 0 AFTER message,
    ADD COLUMN IF NOT EXISTS collected_event_count UInt64 DEFAULT 0 AFTER loss_metrics_version,
    ADD COLUMN IF NOT EXISTS sent_event_count UInt64 DEFAULT 0 AFTER collected_event_count,
    ADD COLUMN IF NOT EXISTS pending_event_count UInt64 DEFAULT 0 AFTER sent_event_count,
    ADD COLUMN IF NOT EXISTS dropped_event_count UInt64 DEFAULT 0 AFTER pending_event_count,
    ADD COLUMN IF NOT EXISTS max_spool_bytes UInt64 DEFAULT 0 AFTER dropped_event_count,
    ADD COLUMN IF NOT EXISTS collected_events_by_source_json String DEFAULT '{}' AFTER max_spool_bytes,
    ADD COLUMN IF NOT EXISTS dropped_events_by_source_json String DEFAULT '{}' AFTER collected_events_by_source_json,
    ADD COLUMN IF NOT EXISTS unattributed_dropped_event_count UInt64 DEFAULT 0 AFTER dropped_events_by_source_json;
