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
    pub control_plane_url: String,
    pub registration_url: Option<String>,
    pub registration_admin_token: String,
    pub require_enrolled_identity: bool,
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
            control_plane_url: std::env::var("CONTROL_PLANE_URL")
                .unwrap_or_else(|_| "http://control-plane:8080".to_string())
                .trim_end_matches('/')
                .to_string(),
            registration_url: std::env::var("REGISTRATION_URL")
                .ok().filter(|value| !value.trim().is_empty())
                .map(|value| value.trim_end_matches('/').to_string()),
            registration_admin_token: std::env::var("REGISTRATION_ADMIN_TOKEN").unwrap_or_default(),
            require_enrolled_identity: std::env::var("REQUIRE_ENROLLED_IDENTITY")
                .map(|value| value.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
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
    mut payload: Value,
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
    if let Err(result) = validate_enrolled_identity(&payload, context, config).await {
        return result;
    }

    // Durable chunks may have been created before the endpoint completed C_i
    // enrollment. Their event checksum remains valid, so attach the identity
    // carried by the current authenticated transport before lease validation
    // and lineage storage. A non-empty payload identity is never overwritten;
    // the normal payload/header mismatch check still rejects impersonation.
    apply_transport_ci_identity(&mut payload, context);

    if let Err(result) = validate_upload_lease(&payload, context, config).await {
        return result;
    }

    upsert_registered_agent(ch, &payload, context, "checkin",
        "chunk validated", &config.agent_config).await;

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
async fn validate_enrolled_identity(
    payload: &Value,
    context: &IngestContext,
    config: &DataPlaneConfig,
) -> Result<(), TelemetryResult> {
    let ci_id = payload.get("ci_id").and_then(Value::as_str).unwrap_or("");
    if ci_id.is_empty() && !config.require_enrolled_identity {
        return Ok(());
    }
    if ci_id.is_empty() {
        return Err(identity_error(403, "identity_missing", "C_i enrollment is required"));
    }
    if config.require_enrolled_identity && !context.cert_verified {
        return Err(identity_error(403, "client_certificate_unverified", "A verified client certificate is required"));
    }
    if config.require_enrolled_identity && context.cert_serial.trim().is_empty() {
        return Err(identity_error(403, "client_certificate_serial_missing", "Verified client certificate serial is required"));
    }
    if !context.ci_id.is_empty() && context.ci_id != ci_id {
        return Err(identity_error(403, "identity_header_mismatch", "C_i payload/header mismatch"));
    }
    let Some(base_url) = config.registration_url.as_ref() else {
        return if config.require_enrolled_identity {
            Err(identity_error(503, "identity_validation_unavailable", "Registration service is not configured"))
        } else {
            Ok(())
        };
    };
    let response = reqwest::Client::new()
        .post(format!("{}/api/v1/identity/validate", base_url))
        .header("x-hosteye-admin-token", &config.registration_admin_token)
        .json(&json!({
            "ciId": ci_id,
            "agentId": payload.get("agent_id").and_then(Value::as_str).unwrap_or(""),
            "hostId": payload.get("host_id").and_then(Value::as_str).unwrap_or(""),
            "certificateSerial": context.cert_serial,
        }))
        .send().await
        .map_err(|error| identity_error(503, "identity_validation_unavailable", &error.to_string()))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if status.is_success() && body.get("valid").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(identity_error(
        403,
        body.get("status").and_then(Value::as_str).unwrap_or("identity_rejected"),
        body.get("message").and_then(Value::as_str).unwrap_or("C_i identity was rejected"),
    ))
}

fn identity_error(status_code: u16, status: &str, message: &str) -> TelemetryResult {
    TelemetryResult {
        status_code,
        body: json!({ "ack": false, "commit": false, "status": status, "message": message }),
    }
}

async fn validate_upload_lease(
    payload: &Value,
    context: &IngestContext,
    config: &DataPlaneConfig,
) -> Result<(), TelemetryResult> {
    let request = json!({
        "lease_id": payload.get("lease_id").and_then(Value::as_str).unwrap_or(""),
        "ci_id": payload.get("ci_id").and_then(Value::as_str).unwrap_or(""),
        "agent_id": payload.get("agent_id").and_then(Value::as_str).unwrap_or(""),
        "host_id": payload.get("host_id").and_then(Value::as_str).unwrap_or(""),
        "computer": payload.get("computer").and_then(Value::as_str).unwrap_or(""),
        "collector_id": context.collector_id.as_str(),
        "chunk_id": payload.get("chunk_id").and_then(Value::as_str).unwrap_or(""),
    });

    if request.get("lease_id").and_then(Value::as_str).unwrap_or("").is_empty() {
        return Err(TelemetryResult {
            status_code: 409,
            body: json!({"ack": false, "commit": false, "status": "lease_missing", "message": "upload lease is required"}),
        });
    }

    let url = format!("{}/api/v1/control/lease/validate", config.control_plane_url);
    let response = reqwest::Client::new().post(url).json(&request).send().await
        .map_err(|e| TelemetryResult {
            status_code: 503,
            body: json!({"ack": false, "commit": false, "status": "lease_validation_unavailable", "message": e.to_string()}),
        })?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({
        "valid": false,
        "status": "lease_validation_invalid_response",
        "message": "control plane returned an invalid lease response"
    }));

    if status.is_success() && body.get("valid").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }

    Err(TelemetryResult {
        status_code: if status.is_server_error() { 503 } else { 409 },
        body: json!({
            "ack": false,
            "commit": false,
            "status": body.get("status").and_then(Value::as_str).unwrap_or("lease_invalid"),
            "message": body.get("message").and_then(Value::as_str).unwrap_or("upload lease rejected"),
        }),
    })
}

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
async fn ch_insert<T: serde::Serialize>(
    _ch: &clickhouse::Client,
    table: &str,
    row: T,
) {
    if let Err(e) = crate::storage::json_rows::insert_json(table, &row).await {
        tracing::warn!("ClickHouse JSONEachRow insert failed (table={}): {}", table, e);
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

    let status = resp.status();
    let response_body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        anyhow::bail!("Redpanda {} {}: {}", topic, status, response_body);
    }
    if let Some(offsets) = response_body.get("offsets").and_then(Value::as_array) {
        if let Some(failed) = offsets.iter().find(|offset| {
            offset.get("error_code").is_some_and(|code| !code.is_null() && code.as_i64() != Some(0))
                || offset.get("error").is_some_and(|error| !error.is_null())
        }) {
            anyhow::bail!("Redpanda {} record rejected: {}", topic, failed);
        }
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

fn apply_transport_ci_identity(payload: &mut Value, context: &IngestContext) {
    if context.ci_id.trim().is_empty() || !is_blank(payload.get("ci_id")) {
        return;
    }
    if let Some(object) = payload.as_object_mut() {
        object.insert("ci_id".to_string(), Value::String(context.ci_id.clone()));
    }
}

#[cfg(test)]
mod enrollment_identity_tests {
    use super::*;

    fn config() -> DataPlaneConfig {
        DataPlaneConfig {
            required_schema_version: "1.0.0".into(),
            raw_chunk_dir: String::new(),
            direct_vector_forward: false,
            vector_url: String::new(),
            redpanda_proxy_url: None,
            raw_chunk_topic: String::new(),
            control_plane_url: String::new(),
            registration_url: None,
            registration_admin_token: String::new(),
            require_enrolled_identity: true,
            agent_config: AgentConfig::default(),
        }
    }

    fn context(verified: bool, serial: &str) -> IngestContext {
        IngestContext {
            collector_id: "collector-a".into(),
            ci_id: "ci-test".into(),
            cert_serial: serial.into(),
            cert_subject: String::new(),
            cert_verified: verified,
            client_ip: "127.0.0.1".into(),
        }
    }

    #[tokio::test]
    async fn enforced_enrollment_rejects_unverified_client_certificate() {
        let error = validate_enrolled_identity(
            &json!({ "ci_id": "ci-test", "agent_id": "agent-test", "host_id": "host-test" }),
            &context(false, "01AB"),
            &config(),
        ).await.expect_err("unverified client certificate must be rejected");
        assert_eq!(error.status_code, 403);
        assert_eq!(error.body.get("status").and_then(Value::as_str), Some("client_certificate_unverified"));
    }

    #[tokio::test]
    async fn enforced_enrollment_rejects_missing_certificate_serial() {
        let error = validate_enrolled_identity(
            &json!({ "ci_id": "ci-test", "agent_id": "agent-test", "host_id": "host-test" }),
            &context(true, ""),
            &config(),
        ).await.expect_err("missing certificate serial must be rejected");
        assert_eq!(error.status_code, 403);
        assert_eq!(error.body.get("status").and_then(Value::as_str), Some("client_certificate_serial_missing"));
    }

    #[test]
    fn transport_identity_labels_pre_enrollment_backlog() {
        let mut payload = json!({ "ci_id": "", "agent_id": "agent-test", "host_id": "host-test" });
        apply_transport_ci_identity(&mut payload, &context(true, "01AB"));
        assert_eq!(payload.get("ci_id").and_then(Value::as_str), Some("ci-test"));
    }

    #[test]
    fn transport_identity_does_not_overwrite_existing_identity() {
        let mut payload = json!({ "ci_id": "ci-other", "agent_id": "agent-test", "host_id": "host-test" });
        apply_transport_ci_identity(&mut payload, &context(true, "01AB"));
        assert_eq!(payload.get("ci_id").and_then(Value::as_str), Some("ci-other"));
    }
}
