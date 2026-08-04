// transport/ingest.rs

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
    Router,
};
use tower_http::limit::RequestBodyLimitLayer;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use crate::config::{ShipperConfig, ShipperState};
use crate::spool::SpoolQuotaManager;
use crate::util::logger::FileLogger;
use crate::util::http::{get_agent_id, get_host_id, get_endpoint_computer_name};
use crate::util::crypto::sha256_hex;
use chrono::Utc;
use flate2::{write::GzEncoder, Compression};
use std::io::Write;
use std::fs::File;
use std::path::Path;

#[derive(Clone)]
pub struct IngestState {
    pub config: Arc<Mutex<ShipperConfig>>,
    pub state: Arc<Mutex<ShipperState>>,
    pub http: reqwest::Client,
    pub logger: Arc<FileLogger>,
    pub spool_quota: SpoolQuotaManager,
    pub sequence_counter: Arc<AtomicU64>,
}

pub async fn start_ingestion_server(
    config: Arc<Mutex<ShipperConfig>>,
    state: Arc<Mutex<ShipperState>>,
    http: reqwest::Client,
    logger: Arc<FileLogger>,
) -> anyhow::Result<()> {
    let host_and_port = "127.0.0.1:50000";
    
    let initial_seq = Utc::now().timestamp() as u64;
    let shared_state = IngestState {
        config,
        state,
        http,
        logger: logger.clone(),
        spool_quota: SpoolQuotaManager::new(),
        sequence_counter: Arc::new(AtomicU64::new(initial_seq)),
    };

    let app = Router::new()
        .route("/ingest", post(handle_ingest))
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024))
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind(host_and_port).await?;
    logger.info(&format!("HTTP Ingestion server listening on http://{}", host_and_port));

    axum::serve(listener, app).await?;
    Ok(())
}

async fn handle_ingest(
    State(state): State<IngestState>,
    body: String,
) -> impl IntoResponse {
    // 1. Phân tách NDJSON và trích xuất events
    let mut events = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            match serde_json::from_str::<serde_json::Value>(trimmed) {
                Ok(val) => events.push(val),
                Err(e) => {
                    state.logger.warn(&format!("Ingest: Failed to parse NDJSON line: {}", e));
                    return (StatusCode::BAD_REQUEST, "Invalid NDJSON format").into_response();
                }
            }
        }
    }

    let event_count = events.len();
    if event_count == 0 {
        return (StatusCode::BAD_REQUEST, "No events found in batch").into_response();
    }

    let spool_dir = {
        let cfg = state.config.lock().unwrap();
        cfg.spool_directory.clone()
    };

    // 2. Sinh sequence number
    let sequence_number = state.sequence_counter.fetch_add(1, Ordering::SeqCst);

    // 3. Sinh Idempotency Key (Chunk ID)
    let agent_id = get_agent_id();
    let host_id = get_host_id();
    let timestamp_nano = Utc::now().timestamp_nanos_opt().unwrap_or(0);
    let chunk_id_seed = format!("{}|{}|{}", agent_id, host_id, timestamp_nano);
    let chunk_id = sha256_hex(&chunk_id_seed);

    // 4. Bọc log thô vào Schema JSON chuẩn (BẮT BUỘC không chứa trường lease_id)
    let events_json = serde_json::to_string(&events).unwrap_or_default();
    // checksum của events để gateway xác thực tính toàn vẹn
    let checksum = sha256_hex(&events_json);
    let computer = get_endpoint_computer_name();

    let (normal_jitter, recovery_jitter, max_events_cfg, max_bytes_cfg) = {
        let cfg = state.config.lock().unwrap();
        (cfg.normal_jitter_window_seconds, cfg.recovery_jitter_window_seconds,
         cfg.max_events, cfg.max_bytes)
    };

    let mut obj = serde_json::Map::new();
    obj.insert("protocol".into(),              serde_json::json!("hosteye.telemetry.v1"));
    obj.insert("schema_version".into(),        serde_json::json!("1.0.0"));
    obj.insert("chunk_id".into(),              serde_json::json!(&chunk_id));
    obj.insert("agent_id".into(),              serde_json::json!(&agent_id));
    obj.insert("host_id".into(),               serde_json::json!(&host_id));
    obj.insert("computer".into(),              serde_json::json!(&computer));
    obj.insert("source_platform".into(),       serde_json::json!("hosteye_windows_endpoint"));
    obj.insert("shipper_version".into(),       serde_json::json!(env!("CARGO_PKG_VERSION")));
    obj.insert("spool_file".into(),            serde_json::json!("ingest_batch"));
    obj.insert("line_offset".into(),           serde_json::json!(0));
    obj.insert("next_line_offset".into(),      serde_json::json!(0));
    obj.insert("byte_offset".into(),           serde_json::json!(0));
    obj.insert("next_byte_offset".into(),      serde_json::json!(0));
    obj.insert("sequence_number".into(),       serde_json::json!(sequence_number));
    obj.insert("event_count".into(),           serde_json::json!(event_count));
    obj.insert("normal_jitter_window_ms".into(),   serde_json::json!(normal_jitter.max(0) * 1000));
    obj.insert("recovery_jitter_window_ms".into(), serde_json::json!(recovery_jitter.max(0) * 1000));
    obj.insert("max_events".into(),            serde_json::json!(max_events_cfg.max(0)));
    obj.insert("max_bytes".into(),             serde_json::json!(max_bytes_cfg.max(0)));
    obj.insert("batch_bytes".into(),           serde_json::json!(body.len()));
    obj.insert("checksum".into(),              serde_json::json!(&checksum));
    obj.insert("checksum_algorithm".into(),    serde_json::json!("sha256"));
    obj.insert("created_at".into(),            serde_json::json!(Utc::now().to_rfc3339()));
    obj.insert("events".into(),                serde_json::Value::Array(events));

    let chunk_payload = serde_json::to_string(&serde_json::Value::Object(obj)).unwrap_or_default();

    // 5. Nén sử dụng GZIP
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    if let Err(e) = encoder.write_all(chunk_payload.as_bytes()) {
        state.logger.error(&format!("Ingest: GZIP compression failed: {}", e));
        return (StatusCode::INTERNAL_SERVER_ERROR, "Compression failed").into_response();
    }
    let compressed_bytes = match encoder.finish() {
        Ok(bytes) => bytes,
        Err(e) => {
            state.logger.error(&format!("Ingest: GZIP finish failed: {}", e));
            return (StatusCode::INTERNAL_SERVER_ERROR, "Compression finish failed").into_response();
        }
    };

    // 6. Ghi xuống Durable Spool và đồng bộ đĩa cứng an toàn bằng sync_all
    // Tên file theo định dạng: chunk_{chunk_id}_{checksum}_{event_count}.gz
    let filename = format!("chunk_{}_{}_{}.gz", chunk_id, checksum, event_count);
    let chunk_path = Path::new(&spool_dir).join(&filename);

    let write_result = (|| -> std::io::Result<()> {
        let mut file = File::create(&chunk_path)?;
        file.write_all(&compressed_bytes)?;
        file.sync_all()?; // Bắt buộc lưu bền vững xuống đĩa cứng
        Ok(())
    })();

    if let Err(e) = write_result {
        state.logger.error(&format!("Ingest: Failed to write chunk to disk ({}): {}", chunk_path.to_string_lossy(), e));
        return (StatusCode::INTERNAL_SERVER_ERROR, "Durable write failed").into_response();
    }

    state.logger.info(&format!(
        "Ingest: Chunk {} successfully written to disk (events={}, size={} bytes). Returning ACK.",
        chunk_id, event_count, compressed_bytes.len()
    ));

    {
        let mut shipper_state = state.state.lock().unwrap();
        shipper_state.collected_event_count = shipper_state.collected_event_count
            .saturating_add(event_count as u64);
        if let Err(e) = shipper_state.save() {
            state.logger.warn(&format!("Ingest: Failed to persist collection counters: {}", e));
        }
    }

    StatusCode::OK.into_response()
}
