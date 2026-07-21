use clickhouse::Row;
use serde::Serialize;
use serde_json::Value;
use crate::data_plane::raw_storage::RawChunkMeta;

/// Row insert vào `default.ingest_chunks` (ReplacingMergeTree by last_seen).
///
/// Schema (003_ingest_chunks.sql):
///   ORDER BY (agent_id, chunk_id)
///   → status tracking cho toàn bộ pipeline từ raw_stored → index_queued
#[derive(Debug, Row, Serialize)]
pub struct ChunkRow {
    pub kafka_timestamp: String,  // DateTime64(3) — dùng for partition
    pub first_seen: String,
    pub last_seen: String,
    pub agent_id: String,
    pub host_id: String,
    pub computer: String,
    pub chunk_id: String,
    pub sequence_number: u64,
    pub checksum: String,
    pub event_count: u32,
    pub lease_id: String,
    pub lease_expires_at: String,
    pub max_batch_mb: f64,
    pub max_upload_rate_kbps: u32,
    pub status: String,
    pub duplicate: u8,   // 0 hoặc 1
    pub attempts: u32,
    pub message: String,
}

/// Row insert vào `default.raw_chunk_vault`.
///
/// Schema (006_raw_chunk_vault_and_transport_offsets.sql):
///   ORDER BY (agent_id, chunk_id)
///   → audit log cho raw chunks đã được lưu disk
#[derive(Debug, Row, Serialize)]
pub struct RawChunkRow {
    pub kafka_timestamp: String,  // DateTime64(3)
    pub agent_id: String,
    pub host_id: String,
    pub computer: String,
    pub chunk_id: String,
    pub checksum: String,
    pub event_count: u32,
    pub sequence_number: u64,
    pub schema_version: String,
    pub raw_path: String,
    pub raw_size_bytes: u64,
    pub compressed_size_bytes: u64,
    pub compression: String,
    pub raw_sha256: String,
    pub status: String,
    pub message: String,
}

/// Build ChunkRow để track trạng thái pipeline.
/// Port từ buildChunkRow() trong Node.js dataplane/index.js.
pub fn build_chunk_row(
    payload: &Value,
    status: &str,
    duplicate: bool,
    message: &str,
) -> ChunkRow {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    ChunkRow {
        kafka_timestamp: now.clone(),
        first_seen: now.clone(),
        last_seen: now,
        agent_id: str_field(payload, "agent_id"),
        host_id: str_field(payload, "host_id"),
        computer: str_field(payload, "computer"),
        chunk_id: str_field(payload, "chunk_id"),
        sequence_number: payload.get("sequence_number")
            .and_then(|v| v.as_u64()).unwrap_or(0),
        checksum: str_field(payload, "checksum"),
        event_count: payload.get("event_count")
            .and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        lease_id: str_field(payload, "lease_id"),
        lease_expires_at: iso_date_or_now(payload.get("lease_expires_at")),
        max_batch_mb: payload.get("max_batch_mb")
            .and_then(|v| v.as_f64()).unwrap_or(0.0),
        max_upload_rate_kbps: payload.get("max_upload_rate_kbps")
            .and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        status: status.to_string(),
        duplicate: if duplicate { 1 } else { 0 },
        attempts: 1,
        message: message.to_string(),
    }
}

/// Build RawChunkRow để ghi vào raw_chunk_vault (audit log raw chunks trên disk).
/// Port từ buildRawChunkRow() trong Node.js dataplane/index.js.
pub fn build_raw_chunk_row(
    payload: &Value,
    meta: &RawChunkMeta,
    status: &str,
    message: &str,
) -> RawChunkRow {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    RawChunkRow {
        kafka_timestamp: now,
        agent_id: str_field(payload, "agent_id"),
        host_id: str_field(payload, "host_id"),
        computer: str_field(payload, "computer"),
        chunk_id: str_field(payload, "chunk_id"),
        checksum: str_field(payload, "checksum"),
        event_count: payload.get("event_count")
            .and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        sequence_number: payload.get("sequence_number")
            .and_then(|v| v.as_u64()).unwrap_or(0),
        schema_version: str_field(payload, "schema_version"),
        raw_path: meta.raw_path.clone(),
        raw_size_bytes: meta.raw_size_bytes as u64,
        compressed_size_bytes: meta.compressed_size_bytes as u64,
        compression: meta.compression.clone(),
        raw_sha256: meta.raw_sha256.clone(),
        status: status.to_string(),
        message: message.to_string(),
    }
}

fn str_field(payload: &Value, field: &str) -> String {
    payload.get(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Parse ISO date string, fallback sang now() nếu invalid/empty.
fn iso_date_or_now(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) if !s.is_empty() => {
            if chrono::DateTime::parse_from_rfc3339(s).is_ok() {
                s.clone()
            } else {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            }
        }
        _ => chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}
