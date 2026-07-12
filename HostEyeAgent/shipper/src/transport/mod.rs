// transport/mod.rs
pub mod admission;
pub mod manager;
pub mod ingest;

pub use admission::AdmissionClient;
pub use manager::TransportManager;
pub use ingest::start_ingestion_server;

use chrono::{DateTime, Utc};
use serde::Deserialize;

// ──────────────────────────────────────────────
// Transport data models (= TransportModels.cs)
// ──────────────────────────────────────────────

/// Một batch đọc từ spool file.
#[derive(Debug, Clone)]
pub struct Batch {
    pub lines:             Vec<String>,
    pub bytes:             usize,
    pub start_byte_offset: u64,
    pub next_byte_offset:  u64,
    pub start_line_offset: i32,
    pub next_line_offset:  i32,
}

/// Metadata gắn kèm mỗi chunk upload.
#[derive(Debug, Clone)]
pub struct ChunkMetadata {
    pub chunk_id:          String,
    pub agent_id:          String,
    pub host_id:           String,
    pub computer:          String,
    pub spool_file:        String,
    pub line_offset:       i32,
    pub next_line_offset:  i32,
    pub byte_offset:       u64,
    pub next_byte_offset:  u64,
    pub sequence_number:   i32,
    pub event_count:       usize,
    pub checksum:          String,
    pub lease_id:          String,
    pub lease_issued_at:   DateTime<Utc>,
    pub lease_expires_at:  DateTime<Utc>,
    pub lease_ttl_seconds: i32,
    pub max_batch_mb:      f64,
    pub max_upload_rate_kbps: i32,
}

/// Upload lease trả về từ admission endpoint.
#[derive(Debug, Clone)]
pub struct UploadLease {
    pub lease_id:          String,
    pub issued_at_utc:     DateTime<Utc>,
    pub expires_at_utc:    DateTime<Utc>,
    pub lease_ttl_seconds: i32,
    pub max_batch_mb:      f64,
    pub max_upload_rate_kbps: i32,
    pub required:          bool,
}

impl UploadLease {
    /// Lease bị vô hiệu hoá (admission control tắt).
    pub fn disabled() -> Self {
        Self {
            lease_id:             String::new(),
            issued_at_utc:        Utc::now(),
            expires_at_utc:       DateTime::<Utc>::MAX_UTC,
            lease_ttl_seconds:    0,
            max_batch_mb:         0.0,
            max_upload_rate_kbps: 0,
            required:             false,
        }
    }
}

/// ACK response từ gateway.
#[derive(Debug, Deserialize)]
pub struct ChunkAck {
    #[serde(default)]
    pub ack:             bool,
    #[serde(default)]
    pub commit:          bool,
    #[serde(default)]
    pub status:          String,
    #[serde(default)]
    pub index_status:    String,
    #[serde(default)]
    pub chunk_id:        String,
    #[serde(default)]
    pub checksum:        String,
    #[serde(default)]
    pub event_count:     usize,
    #[serde(default)]
    pub sequence_number: i32,
    #[serde(default)]
    pub lease_id:        String,
}

/// Thời điểm send lifecycle dùng cho runtime metric.
#[derive(Debug, Clone)]
pub struct SendTiming {
    pub jitter_planned_at:  DateTime<Utc>,
    pub scheduled_send_at:  DateTime<Utc>,
    pub actual_send_at:     DateTime<Utc>,
    pub send_started_at:    DateTime<Utc>,
    pub send_completed_at:  DateTime<Utc>,
}
