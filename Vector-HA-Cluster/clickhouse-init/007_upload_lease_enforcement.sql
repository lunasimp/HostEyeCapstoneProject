ALTER TABLE default.admission_decisions
    ADD COLUMN IF NOT EXISTS max_batch_mb Float64 DEFAULT 0 AFTER max_active_uploads,
    ADD COLUMN IF NOT EXISTS max_upload_rate_kbps UInt32 DEFAULT 0 AFTER max_batch_mb,
    ADD COLUMN IF NOT EXISTS lease_expires_at DateTime64(3) DEFAULT decided_at AFTER lease_ttl_seconds;

ALTER TABLE default.ingest_chunks
    ADD COLUMN IF NOT EXISTS lease_id String DEFAULT '' AFTER event_count,
    ADD COLUMN IF NOT EXISTS lease_expires_at DateTime64(3) DEFAULT last_seen AFTER lease_id,
    ADD COLUMN IF NOT EXISTS max_batch_mb Float64 DEFAULT 0 AFTER lease_expires_at,
    ADD COLUMN IF NOT EXISTS max_upload_rate_kbps UInt32 DEFAULT 0 AFTER max_batch_mb;

ALTER TABLE default.raw_chunk_vault
    ADD COLUMN IF NOT EXISTS lease_id String DEFAULT '' AFTER schema_version,
    ADD COLUMN IF NOT EXISTS lease_expires_at DateTime64(3) DEFAULT kafka_timestamp AFTER lease_id,
    ADD COLUMN IF NOT EXISTS max_batch_mb Float64 DEFAULT 0 AFTER lease_expires_at,
    ADD COLUMN IF NOT EXISTS max_upload_rate_kbps UInt32 DEFAULT 0 AFTER max_batch_mb;

ALTER TABLE default.shipper_runtime_metrics
    ADD COLUMN IF NOT EXISTS lease_id String DEFAULT '' AFTER ack_status,
    ADD COLUMN IF NOT EXISTS lease_issued_at DateTime64(3) DEFAULT metric_timestamp AFTER lease_id,
    ADD COLUMN IF NOT EXISTS lease_expires_at DateTime64(3) DEFAULT metric_timestamp AFTER lease_issued_at,
    ADD COLUMN IF NOT EXISTS lease_ttl_seconds UInt32 DEFAULT 0 AFTER lease_expires_at,
    ADD COLUMN IF NOT EXISTS max_batch_mb Float64 DEFAULT 0 AFTER lease_ttl_seconds,
    ADD COLUMN IF NOT EXISTS max_upload_rate_kbps UInt32 DEFAULT 0 AFTER max_batch_mb;
