use serde_json::Value;
use std::io::Read;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use hex;
use crate::data_plane::index::forward_to_vector;
use crate::data_plane::normalizer::normalize_event;
use crate::data_plane::suppressor::suppress_event;
use crate::data_plane::context_builder::build_context;
use clickhouse::Row;
use serde::Deserialize;
use anyhow::Context;

/// Metadata của một raw chunk job nhận từ Redpanda.
/// Được publish bởi data_server sau khi ghi raw chunk xuống disk.
#[derive(Debug)]
pub struct RawChunkJob {
    pub protocol: String,
    pub event_type: String,
    pub collector_id: String,
    pub agent_id: String,
    pub host_id: String,
    pub computer: String,
    pub chunk_id: String,
    pub checksum: String,
    pub event_count: u64,
    pub sequence_number: u64,
    pub lease_id: String,
    pub raw_path: String,
    pub raw_sha256: String,
    pub raw_size_bytes: u64,
    pub compressed_size_bytes: u64,
}

impl RawChunkJob {
    pub fn from_value(v: &Value) -> Option<Self> {
        Some(RawChunkJob {
            protocol: str_field(v, "protocol"),
            event_type: str_field(v, "event_type"),
            collector_id: str_field(v, "collector_id"),
            agent_id: str_field(v, "agent_id"),
            host_id: str_field(v, "host_id"),
            computer: str_field(v, "computer"),
            chunk_id: str_field(v, "chunk_id"),
            checksum: str_field(v, "checksum"),
            event_count: v.get("event_count").and_then(|x| x.as_u64()).unwrap_or(0),
            sequence_number: v.get("sequence_number").and_then(|x| x.as_u64()).unwrap_or(0),
            lease_id: str_field(v, "lease_id"),
            raw_path: str_field(v, "raw_path"),
            raw_sha256: str_field(v, "raw_sha256"),
            raw_size_bytes: v.get("raw_size_bytes").and_then(|x| x.as_u64()).unwrap_or(0),
            compressed_size_bytes: v.get("compressed_size_bytes").and_then(|x| x.as_u64()).unwrap_or(0),
        })
    }
}

/// Config của worker.
pub struct WorkerConfig {
    pub vector_url: String,
    pub clickhouse_url: String,
}

#[derive(Row, Deserialize)]
struct ProcessedChunkCount {
    count: u64,
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        Self {
            vector_url: std::env::var("VECTOR_URL")
                .unwrap_or_else(|_| "http://vector-gateway-1:8686/".to_string()),
            clickhouse_url: std::env::var("CLICKHOUSE_URL")
                .unwrap_or_else(|_| "http://clickhouse:8123".to_string()),
        }
    }
}

/// Xử lý một raw chunk job từ Redpanda:
/// 1. Đọc file .gz từ disk
/// 2. Verify sha256 + chunk_id + event_count
/// 3. Enrich events (validate, add metadata)
/// 4. Forward đến Vector gateway
/// 5. Log kết quả vào ingest_chunks
///
/// Port từ processRecord() + readRawPayload() + verifyRawPayload() trong raw-chunk-worker.js
pub async fn process_job(
    job: &RawChunkJob,
    config: &WorkerConfig,
    ch: &clickhouse::Client,
) -> anyhow::Result<()> {
    use crate::storage::chunk_rows::build_chunk_row;

    let started_at = chrono::Utc::now();

    // Kiểm tra job type
    if job.protocol != "hosteye.raw_chunk.v1" || job.event_type != "raw_chunk_stored" {
        tracing::warn!("skip non raw_chunk job type={} protocol={}", job.event_type, job.protocol);
        return Ok(());
    }

    if job.raw_path.is_empty() {
        anyhow::bail!("raw chunk job missing raw_path");
    }

    // Đọc và gunzip file
    match chunk_already_processed(ch, &job.agent_id, &job.chunk_id).await {
        Ok(true) => {
            tracing::info!(
                chunk_id = job.chunk_id.as_str(),
                "skip replayed chunk that was already forwarded"
            );
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!(
                chunk_id = job.chunk_id.as_str(),
                "processed-chunk lookup failed; continuing with at-least-once processing: {}",
                e
            );
        }
    }

    let payload = read_raw_payload(job).await?;
    verify_raw_payload(job, &payload)?;

    // Enrich events
    let enriched = crate::data_plane::validator::enrich_events(&payload);
    
    // Normalization & Suppression
    let mut final_events = Vec::new();
    let mut suppression_rows = Vec::new();
    
    for event in enriched {
        let normalized = normalize_event(event);
        let (suppressed_event, maybe_suppression_row) = suppress_event(normalized, ch).await;
        final_events.push(suppressed_event);
        if let Some(row) = maybe_suppression_row {
            suppression_rows.push(row);
        }
    }
    
    // Batch insert suppression rows
    for row in suppression_rows {
        ch_insert(ch, "default.suppression_state", row).await;
    }

    let enriched_count = final_events.len();

    // Forward đến Vector
    forward_to_vector(&config.vector_url, &final_events).await?;

    // Log thành công vào ingest_chunks
    let msg = format!("raw worker forwarded {} events from {}", enriched_count, job.chunk_id);
    let row = build_chunk_row(&payload, "worker_index_queued", false, &msg);
    ch_insert(ch, "default.ingest_chunks", row).await;

    // Chạy Context Builder trong background (không block Worker nhận job mới)
    for event in final_events {
        let ch_clone = ch.clone();
        tokio::spawn(async move {
            build_context(event, ch_clone).await;
        });
    }

    let elapsed = chrono::Utc::now().signed_duration_since(started_at).num_milliseconds();
    tracing::info!(
        chunk_id = job.chunk_id.as_str(),
        events = enriched_count,
        elapsed_ms = elapsed,
        "worker processed chunk"
    );

    Ok(())
}

/// Build fallback payload từ job metadata (dùng khi không đọc được file).
async fn chunk_already_processed(
    ch: &clickhouse::Client,
    agent_id: &str,
    chunk_id: &str,
) -> anyhow::Result<bool> {
    let row = ch
        .query(
            "SELECT count() AS count FROM default.ingest_chunks \
             WHERE agent_id = ? AND chunk_id = ? AND status = 'worker_index_queued'",
        )
        .bind(agent_id)
        .bind(chunk_id)
        .fetch_one::<ProcessedChunkCount>()
        .await?;

    Ok(row.count > 0)
}

pub fn payload_from_job(job: &RawChunkJob) -> serde_json::Value {
    serde_json::json!({
        "agent_id": job.agent_id,
        "host_id": job.host_id,
        "computer": job.computer,
        "chunk_id": job.chunk_id,
        "sequence_number": job.sequence_number,
        "checksum": job.checksum,
        "event_count": job.event_count,
        "lease_id": job.lease_id,
    })
}

/// Đọc và gunzip raw chunk từ disk.
async fn read_raw_payload(job: &RawChunkJob) -> anyhow::Result<Value> {
    let compressed = tokio::fs::read(&job.raw_path)
        .await
        .with_context(|| format!("read raw chunk {}", job.raw_path))?;

    // Gunzip
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut raw_json = String::new();
    decoder.read_to_string(&mut raw_json)
        .map_err(|e| anyhow::anyhow!("gunzip {}: {}", job.raw_path, e))?;

    // Verify sha256 nếu có
    if !job.raw_sha256.is_empty() {
        let actual_sha = sha256_hex(&raw_json);
        if actual_sha != job.raw_sha256.to_lowercase() {
            anyhow::bail!("raw_sha256 mismatch for chunk {}", job.chunk_id);
        }
    }

    let payload: Value = serde_json::from_str(&raw_json)
        .map_err(|e| anyhow::anyhow!("parse raw chunk JSON {}: {}", job.chunk_id, e))?;

    Ok(payload)
}

/// Verify payload đọc từ disk khớp với metadata trong job.
fn verify_raw_payload(job: &RawChunkJob, payload: &Value) -> anyhow::Result<()> {
    let payload_chunk_id = payload.get("chunk_id").and_then(|v| v.as_str()).unwrap_or("");
    if payload_chunk_id != job.chunk_id {
        anyhow::bail!("chunk_id mismatch: job={} payload={}", job.chunk_id, payload_chunk_id);
    }

    let payload_checksum = payload.get("checksum").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
    if payload_checksum != job.checksum.to_lowercase() {
        anyhow::bail!("checksum mismatch for {}", job.chunk_id);
    }

    let payload_count = payload.get("event_count").and_then(|v| v.as_u64()).unwrap_or(0);
    if payload_count != job.event_count {
        anyhow::bail!("event_count mismatch for {}: job={} payload={}", job.chunk_id, job.event_count, payload_count);
    }

    Ok(())
}

async fn ch_insert<T: serde::Serialize>(
    _ch: &clickhouse::Client,
    table: &str,
    row: T,
) {
    if let Err(e) = crate::storage::json_rows::insert_json(table, &row).await {
        tracing::warn!("worker ClickHouse JSONEachRow insert ({}): {}", table, e);
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn str_field(v: &Value, field: &str) -> String {
    v.get(field).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
