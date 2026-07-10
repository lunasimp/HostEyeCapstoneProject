ALTER TABLE default.shipper_runtime_metrics
    ADD COLUMN IF NOT EXISTS control_request_planned_at DateTime64(3) DEFAULT metric_timestamp AFTER next_retry_at,
    ADD COLUMN IF NOT EXISTS control_request_actual_at DateTime64(3) DEFAULT metric_timestamp AFTER control_request_planned_at,
    ADD COLUMN IF NOT EXISTS send_after DateTime64(3) DEFAULT metric_timestamp AFTER control_request_actual_at,
    ADD COLUMN IF NOT EXISTS control_send_delay_ms UInt32 DEFAULT 0 AFTER send_after,
    ADD COLUMN IF NOT EXISTS collector_id String DEFAULT '' AFTER control_send_delay_ms,
    ADD COLUMN IF NOT EXISTS collector_url String DEFAULT '' AFTER collector_id;
