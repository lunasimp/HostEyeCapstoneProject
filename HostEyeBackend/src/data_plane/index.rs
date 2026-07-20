use serde_json::{json, Value};
use crate::data_plane::receiver::IngestContext;
use crate::data_plane::validator::{validate_chunk_envelope, enrich_events};
use crate::data_plane::idempotency::{get_existing_chunk, index_status_from_chunk_status};
use crate::data_plane::raw_storage::write_raw_chunk;
use crate::storage::agent_rows::{build_registered_agent_row, AgentConfig};
use crate::storage::chunk_rows::{build_chunk_row, build_raw_chunk_row};

/// Toàn bộ config của data plane, load từ environment variables.
#[derive(Debug, Clone)]
pub struct DataPlaneConfig {
    /// Schema version bắt buộc, default "1.0.0" (env REQUIRED_SCHEMA_VERSION)
    pub required_schema_version: String,
    /// Thư mục ghi raw chunk gzip (env RAW_CHUNK_DIR)
    pub raw_chunk_dir: String,
    /// Nếu true: forward events thẳng đến Vector sau khi ghi disk (env DIRECT_VECTOR_FORWARD)
    /// Prod dùng false: worker đọc từ Redpanda để forward
    pub direct_vector_forward: bool,
    /// URL của Vector gateway (env VECTOR_URL)
    pub vector_url: String,
    /// URL Redpanda REST Proxy, None nếu broker bị tắt (env REDPANDA_PROXY_URL)
    pub redpanda_proxy_url: Option<String>,
    /// Tên Kafka topic để publish raw chunk jobs (env RAW_CHUNK_TOPIC)
    pub raw_chunk_topic: String,
    /// Config agent mặc định (jitter, max_events, max_bytes)
    pub agent_config: AgentConfig,
}

impl DataPlaneConfig {
    pub fn from_env() -> Self {
        let redpanda_url = std::env::var("REDPANDA_PROXY_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_end_matches('/').to_string());

        Self {
            required_schema_version: std::env::var("REQUIRED_SCHEMA_VERSION")
                .unwrap_or_else(|_| "1.0.0".to_string()),
            raw_chunk_dir: std::env::var("RAW_CHUNK_DIR")
                .unwrap_or_else(|_| "/var/lib/hosteye/raw_chunks".to_string()),
            direct_vector_forward: std::env::var("DIRECT_VECTOR_FORWARD")
                .map(|v| v.to_lowercase() != "false")
                .unwrap_or(true),
            vector_url: std::env::var("VECTOR_URL")
                .unwrap_or_else(|_| "http://vector-gateway-1:8686/".to_string()),
            redpanda_proxy_url: redpanda_url,
            raw_chunk_topic: std::env::var("RAW_CHUNK_TOPIC")
                .unwrap_or_else(|_| "raw-chunk-jobs".to_string()),
            agent_config: AgentConfig::from_env(),
        }
    }
}

/// Kết quả từ handle_telemetry để data_server trả về HTTP response.
pub struct TelemetryResult {
    pub status_code: u16,
    pub body: Value,
}

/// Điều phối chính: nhận payload từ Axum handler, xử lý theo protocol.
///
/// Port từ handleTelemetry() trong Node.js dataplane/index.js:
/// - Array JSON → legacy array (forward thẳng Vector)
/// - protocol == "hosteye.telemetry.v1" → handle_chunk (full pipeline)
/// - Else → treat as legacy single event
pub async fn handle_telemetry(
    payload: Value,
    context: IngestContext,
    config: &DataPlaneConfig,
    ch: &clickhouse::Client,
) -> TelemetryResult {
    if payload.is_array() {
        let events = payload.as_array().unwrap().clone();
        return handle_legacy_array(&events, &context, config, ch).await;
    }

    if payload.get("protocol").and_then(|v| v.as_str()) == Some("hosteye.telemetry.v1") {
        return handle_chunk(payload, &context, config, ch).await;
    }

    // Single event không có protocol → wrap thành legacy array
    handle_legacy_array(&[payload], &context, config, ch).await
}

// ─── Legacy Array ───────────────────────────────────────────────────────────

async fn handle_legacy_array(
    events: &[Value],
    context: &IngestContext,
    config: &DataPlaneConfig,
    ch: &clickhouse::Client,
) -> TelemetryResult {
    // Enrich legacy events với metadata
    let legacy_payload: Vec<Value> = events.iter().enumerate().map(|(index, event)| {
        let mut e = event.clone();
        if let Some(obj) = e.as_object_mut() {
            let sv = obj.get("schema_version")
                .and_then(|v| v.as_str()).unwrap_or("legacy").to_string();
            obj.insert("schema_version".to_string(), json!(sv));
            obj.insert("parser_status".to_string(), json!("legacy_unvalidated"));
            obj.insert("parser_error".to_string(), json!(""));
            obj.insert("validation_errors".to_string(), json!("legacy_payload_without_chunk_envelope"));
            obj.insert("processing_version".to_string(), json!("server-processing-1.0.0"));
            obj.insert("chunk_event_index".to_string(), json!(index));
        }
        e
    }).collect();

    // Upsert registered agent cho mỗi event có đủ thông tin
    for event in &legacy_payload {
        if !is_blank(event.get("agent_id")) || !is_blank(event.get("host_id")) {
            upsert_registered_agent(ch, event, context, "legacy_checkin",
                "legacy payload check-in", &config.agent_config).await;
        }
    }

    // Forward thẳng đến Vector
    if let Err(e) = forward_to_vector(&config.vector_url, &legacy_payload).await {
        tracing::warn!("legacy array vector forward failed: {}", e);
    }

    TelemetryResult {
        status_code: 200,
        body: json!({
            "ack": true,
            "commit": true,
            "status": "forwarded_legacy_array",
            "event_count": events.len()
        }),
    }
}

// ─── Chunk Pipeline ──────────────────────────────────────────────────────────

async fn handle_chunk(
    payload: Value,
    context: &IngestContext,
    config: &DataPlaneConfig,
    ch: &clickhouse::Client,
) -> TelemetryResult {
    // 1. Validate chunk envelope
    let validation = validate_chunk_envelope(&payload, &config.required_schema_version);
    if !validation.ok {
        return TelemetryResult {
            status_code: validation.status_code,
            body: validation.body.unwrap_or(json!({"ack": false, "commit": false, "status": "invalid"})),
        };
    }

    // 2. Upsert registered agent (log checkin kèm cert_serial)
    upsert_registered_agent(ch, &payload, context, "checkin",
        "chunk validated", &config.agent_config).await;

    // 3. Idempotency check — nếu chunk đã tồn tại
    match get_existing_chunk(ch, &validation.agent_id, &validation.chunk_id).await {
        Ok(Some(existing)) => {
            return handle_existing_chunk(&payload, &validation, &existing);
        }
        Ok(None) => {} // chunk mới, tiếp tục
        Err(e) => {
            // Non-blocking: log warning nhưng vẫn tiếp tục xử lý
            tracing::warn!("idempotency check failed (continuing): {}", e);
        }
    }

    // 4. Ghi raw chunk xuống disk (gzip)
    let raw_meta = match write_raw_chunk(
        &config.raw_chunk_dir,
        &payload,
        &validation.agent_id,
        &validation.chunk_id,
    ).await {
        Ok(meta) => meta,
        Err(e) => {
            tracing::error!("raw chunk disk write failed: {}", e);
            return TelemetryResult {
                status_code: 500,
                body: json!({
                    "ack": false, "commit": false, "status": "error",
                    "message": format!("storage error: {}", e)
                }),
            };
        }
    };

    // 5. Insert raw_chunk_vault (audit log)
    ch_insert(ch, "default.raw_chunk_vault",
        build_raw_chunk_row(&payload, &raw_meta, "stored", "raw chunk stored before ACK")).await;

    // 6. Insert ingest_chunks (status: raw_stored)
    ch_insert(ch, "default.ingest_chunks",
        build_chunk_row(&payload, "raw_stored", false, "raw chunk stored before ACK")).await;

    // 7. Publish job đến Redpanda (nếu được cấu hình)
    let (broker_status, broker_message) = match &config.redpanda_proxy_url {
        Some(proxy_url) => {
            let job = build_broker_job(&payload, &raw_meta, &validation, context);
            match publish_to_broker(proxy_url, &config.raw_chunk_topic, &job).await {
                Ok(_) => {
                    let msg = format!("published raw chunk job to {}", config.raw_chunk_topic);
                    ch_insert(ch, "default.ingest_chunks",
                        build_chunk_row(&payload, "broker_queued", false, &msg)).await;
                    ("broker_queued".to_string(), msg)
                }
                Err(e) => {
                    let msg = format!("broker publish failed: {}", e);
                    ch_insert(ch, "default.ingest_chunks",
                        build_chunk_row(&payload, "broker_failed", false, &msg)).await;
                    ("broker_failed".to_string(), msg)
                }
            }
        }
        None => ("disabled".to_string(), "broker publish disabled".to_string()),
    };

    // 8. Direct Vector forward (nếu DIRECT_VECTOR_FORWARD=true, không dùng trong prod)
    if config.direct_vector_forward {
        let enriched = enrich_events(&payload);
        match forward_to_vector(&config.vector_url, &enriched).await {
            Ok(_) => {
                ch_insert(ch, "default.ingest_chunks",
                    build_chunk_row(&payload, "index_queued", false, "forwarded to vector gateway")).await;
            }
            Err(e) => {
                ch_insert(ch, "default.ingest_chunks",
                    build_chunk_row(&payload, "index_failed", false,
                        &format!("vector forward failed: {}", e))).await;
            }
        }
    } else {
        ch_insert(ch, "default.ingest_chunks",
            build_chunk_row(&payload, "index_deferred", false,
                "indexing delegated to raw-chunk-worker")).await;
    }

    TelemetryResult {
        status_code: 200,
        body: json!({
            "ack": true,
            "commit": true,
            "status": "raw_stored",
            "broker_status": broker_status,
            "broker_message": broker_message,
            "chunk_id": validation.chunk_id,
            "checksum": validation.checksum,
            "event_count": validation.event_count,
            "invalid_event_count": 0,  // worker sẽ tính sau khi enrich
            "sequence_number": payload.get("sequence_number").and_then(|v| v.as_i64()).unwrap_or(0),
            "lease_id": payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or(""),
        }),
    }
}

// ─── Existing Chunk (Duplicate) ──────────────────────────────────────────────

fn handle_existing_chunk(
    payload: &Value,
    validation: &crate::data_plane::validator::ValidationResult,
    existing: &crate::data_plane::idempotency::ExistingChunk,
) -> TelemetryResult {
    // Conflict: cùng chunk_id nhưng khác checksum hoặc event_count
    let same_checksum = existing.checksum.to_lowercase() == validation.checksum;
    let same_count = existing.event_count as usize == validation.event_count;

    if !same_checksum || !same_count {
        return TelemetryResult {
            status_code: 409,
            body: json!({
                "ack": false, "commit": false, "status": "conflict",
                "chunk_id": validation.chunk_id,
                "message": "chunk_id exists with different checksum or count"
            }),
        };
    }

    // True duplicate: ACK thành công (idempotent)
    TelemetryResult {
        status_code: 200,
        body: json!({
            "ack": true,
            "commit": true,
            "status": "duplicate",
            "index_status": index_status_from_chunk_status(&existing.status),
            "chunk_id": validation.chunk_id,
            "checksum": validation.checksum,
            "event_count": validation.event_count,
            "sequence_number": payload.get("sequence_number").and_then(|v| v.as_i64()).unwrap_or(0),
            "lease_id": payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or(""),
        }),
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Upsert registered agent vào ClickHouse (log checkin kèm cert_serial từ mTLS).
async fn upsert_registered_agent(
    ch: &clickhouse::Client,
    payload: &Value,
    context: &IngestContext,
    status: &str,
    message: &str,
    agent_config: &AgentConfig,
) {
    // Bỏ qua nếu không có đủ thông tin nhận dạng agent
    let agent_id = payload.get("agent_id").and_then(|v| v.as_str()).unwrap_or("");
    let host_id = payload.get("host_id").and_then(|v| v.as_str()).unwrap_or("");
    let computer = payload.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    if agent_id.is_empty() && host_id.is_empty() && computer.is_empty() {
        return;
    }

    let row = build_registered_agent_row(payload, context, status, message, agent_config);
    ch_insert(ch, "default.registered_agents", row).await;
}

/// Insert một row vào ClickHouse. Log warning nếu lỗi, không panic.
async fn ch_insert<T: clickhouse::Row + serde::Serialize>(
    ch: &clickhouse::Client,
    table: &str,
    row: T,
) {
    match ch.insert(table) {
        Ok(mut inserter) => {
            if let Err(e) = inserter.write(&row).await {
                tracing::warn!("ClickHouse insert write failed (table={}): {}", table, e);
                return;
            }
            if let Err(e) = inserter.end().await {
                tracing::warn!("ClickHouse insert end failed (table={}): {}", table, e);
            }
        }
        Err(e) => {
            tracing::warn!("ClickHouse insert init failed (table={}): {}", table, e);
        }
    }
}

/// Build broker job để publish lên Redpanda.
/// Port từ buildRawChunkBrokerJob() trong Node.js.
fn build_broker_job(
    payload: &Value,
    meta: &crate::data_plane::raw_storage::RawChunkMeta,
    validation: &crate::data_plane::validator::ValidationResult,
    context: &IngestContext,
) -> Value {
    json!({
        "protocol": "hosteye.raw_chunk.v1",
        "event_type": "raw_chunk_stored",
        "queued_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "collector_id": context.collector_id,
        "agent_id": validation.agent_id,
        "host_id": payload.get("host_id").and_then(|v| v.as_str()).unwrap_or(""),
        "computer": payload.get("computer").and_then(|v| v.as_str()).unwrap_or(""),
        "chunk_id": validation.chunk_id,
        "checksum": validation.checksum,
        "event_count": validation.event_count,
        "sequence_number": payload.get("sequence_number").and_then(|v| v.as_i64()).unwrap_or(0),
        "lease_id": payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or(""),
        "lease_expires_at": payload.get("lease_expires_at").and_then(|v| v.as_str()).unwrap_or(""),
        "raw_path": meta.raw_path,
        "raw_sha256": meta.raw_sha256,
        "raw_size_bytes": meta.raw_size_bytes,
        "compressed_size_bytes": meta.compressed_size_bytes,
        "compression": meta.compression,
        "next_step": "process_raw_chunk"
    })
}

/// Publish job lên Redpanda qua REST Proxy API.
/// Dùng Kafka REST format: application/vnd.kafka.json.v2+json
pub async fn publish_to_broker(
    proxy_url: &str,
    topic: &str,
    job: &Value,
) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let url = format!("{}/topics/{}", proxy_url, urlencoding::encode(topic));
    let body = json!({
        "records": [{ "key": job.get("chunk_id").and_then(|v| v.as_str()).unwrap_or(""), "value": job }]
    });

    let resp = client
        .post(&url)
        .header("content-type", "application/vnd.kafka.json.v2+json")
        .header("accept", "application/vnd.kafka.v2+json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Redpanda {} {}: {}", topic, status, text);
    }

    Ok(())
}

/// Forward enriched events đến Vector gateway.
pub async fn forward_to_vector(vector_url: &str, events: &[Value]) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post(vector_url)
        .header("content-type", "application/json")
        .json(events)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("Vector {}: {}", status, text);
    }

    Ok(())
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        _ => false,
    }
}

// Module urlencoding đơn giản (tránh thêm dependency)
mod urlencoding {
    pub fn encode(s: &str) -> String {
        s.chars().map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        }).collect()
    }
}
