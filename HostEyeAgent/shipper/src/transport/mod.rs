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

