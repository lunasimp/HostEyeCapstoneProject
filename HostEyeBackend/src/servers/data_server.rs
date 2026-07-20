// data_server.rs — HostEye Data Plane Collector
// Mỗi instance của binary này là một collector (collector-a .. collector-h).
// Chạy sau Nginx reverse proxy (mTLS terminated tại Nginx).

// ── Module includes (dùng #[path] vì binary không có lib.rs) ─────────────
#[path = "../data_plane/mod.rs"]
mod data_plane;

#[path = "../storage/mod.rs"]
mod storage;

// ── Imports ──────────────────────────────────────────────────────────────────
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
use tokio::net::TcpListener;
use tower_http::limit::RequestBodyLimitLayer;

use data_plane::index::{DataPlaneConfig, handle_telemetry};
use data_plane::receiver::extract_context;

// ── App State ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AppState {
    collector_id: String,
    config: Arc<DataPlaneConfig>,
    ch: clickhouse::Client,
    /// Số lượng upload đang xử lý hiện tại
    active_uploads: Arc<AtomicI64>,
    /// Timestamp (ms) khi collector sẽ sẵn sàng cho upload tiếp theo
    collector_busy_until_ms: Arc<AtomicI64>,
    /// Thời gian tối thiểu cần thiết để xử lý một upload (ms)
    upload_slot_ms: i64,
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let collector_id = std::env::var("COLLECTOR_ID")
        .unwrap_or_else(|_| "collector-a".to_string());
    let port = std::env::var("PORT")
        .or_else(|_| std::env::var("DATA_PORT"))
        .unwrap_or_else(|_| "8088".to_string());
    let max_body_bytes = std::env::var("MAX_BODY_BYTES")
        .ok().and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(25 * 1024 * 1024); // 25MB default
    let upload_slot_ms = std::env::var("COLLECTOR_UPLOAD_SLOT_MS")
        .ok().and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1000).max(1);
    let clickhouse_url = std::env::var("CLICKHOUSE_URL")
        .unwrap_or_else(|_| "http://clickhouse:8123".to_string());
    let control_plane_url = std::env::var("CONTROL_PLANE_URL").ok();
    let collector_public_url = std::env::var("COLLECTOR_PUBLIC_URL")
        .unwrap_or_else(|_| format!("/api/v1/telemetry/{}", collector_id));
    let admission_max_uploads = std::env::var("ADMISSION_MAX_ACTIVE_UPLOADS")
        .ok().and_then(|v| v.parse::<i64>().ok()).unwrap_or(64);

    let ch = clickhouse::Client::default().with_url(&clickhouse_url);
    let config = Arc::new(DataPlaneConfig::from_env());
    let active_uploads = Arc::new(AtomicI64::new(0));
    let collector_busy_until_ms = Arc::new(AtomicI64::new(0));

    let state = AppState {
        collector_id: collector_id.clone(),
        config,
        ch,
        active_uploads: active_uploads.clone(),
        collector_busy_until_ms: collector_busy_until_ms.clone(),
        upload_slot_ms,
    };

    // Spawn heartbeat task nếu CONTROL_PLANE_URL được cấu hình
    if let Some(cp_url) = control_plane_url {
        let heartbeat_ms = std::env::var("COLLECTOR_HEARTBEAT_MS")
            .ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(5000);
        let cid = collector_id.clone();
        let cpu = collector_public_url.clone();
        let au = active_uploads.clone();
        let cbu = collector_busy_until_ms.clone();
        tokio::spawn(async move {
            heartbeat_loop(cp_url, cid, cpu, admission_max_uploads, upload_slot_ms, au, cbu, heartbeat_ms).await;
        });
    }

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/v1/telemetry", post(telemetry_handler_no_id))
        .route("/api/v1/telemetry/:collector_id", post(telemetry_handler))
        .route("/", post(telemetry_handler_no_id))
        .layer(RequestBodyLimitLayer::new(max_body_bytes))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    tracing::info!("HostEye data plane {} listening on {}", collector_id, addr);
    let listener = TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async fn health_handler(State(state): State<AppState>) -> impl IntoResponse {
    let active = state.active_uploads.load(Ordering::Relaxed);
    let busy_until = state.collector_busy_until_ms.load(Ordering::Relaxed);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let ready = active == 0 && busy_until <= now_ms;
    let next_available = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::milliseconds((busy_until - now_ms).max(0)))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    (StatusCode::OK, Json(json!({
        "ok": true,
        "service": "hosteye-data-plane",
        "collector_id": state.collector_id,
        "active_leases": 0,
        "active_uploads": active,
        "ready": ready,
        "next_available_at": next_available,
        "upload_slot_ms": state.upload_slot_ms,
    })))
}

/// Handler cho route /api/v1/telemetry (không có collector_id trong path)
async fn telemetry_handler_no_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let collector_id = state.collector_id.clone();
    process_telemetry(state, headers, body, collector_id).await
}

/// Handler cho route /api/v1/telemetry/:collector_id
async fn telemetry_handler(
    State(state): State<AppState>,
    Path(collector_id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    process_telemetry(state, headers, body, collector_id).await
}

async fn process_telemetry(
    state: AppState,
    headers: HeaderMap,
    body: axum::body::Bytes,
    collector_id: String,
) -> impl IntoResponse {
    // Parse JSON body
    let payload = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"ack": false, "commit": false, "status": "error", "message": format!("invalid JSON: {}", e)})),
            );
        }
    };

    // Extract cert context từ Nginx headers
    let context = extract_context(&headers, &collector_id);

    // Track active uploads + reserve upload slot
    state.active_uploads.fetch_add(1, Ordering::Relaxed);
    reserve_upload_slot(&state);

    let result = handle_telemetry(payload, context, &state.config, &state.ch).await;

    state.active_uploads.fetch_sub(1, Ordering::Relaxed);
    // Đảm bảo không âm
    state.active_uploads.fetch_max(0, Ordering::Relaxed);
    reserve_upload_slot(&state);

    let status = StatusCode::from_u16(result.status_code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(result.body))
}

// ── Upload Slot Tracking (tương đương Node.js) ────────────────────────────────

/// Cập nhật collector_busy_until_ms dựa trên số uploads hiện tại.
/// Giúp Control Plane biết khi nào collector sẵn sàng nhận upload tiếp theo.
fn reserve_upload_slot(state: &AppState) {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let queued = state.active_uploads.load(Ordering::Relaxed).max(0);
    let queued_ms = queued * state.upload_slot_ms;
    let new_busy_until = now_ms + queued_ms;

    // Chỉ update nếu new_busy_until > current (không lùi lại)
    state.collector_busy_until_ms.fetch_max(new_busy_until, Ordering::Relaxed);
}

// ── Heartbeat Task ────────────────────────────────────────────────────────────

async fn heartbeat_loop(
    control_plane_url: String,
    collector_id: String,
    collector_public_url: String,
    max_uploads: i64,
    upload_slot_ms: i64,
    active_uploads: Arc<AtomicI64>,
    collector_busy_until_ms: Arc<AtomicI64>,
    interval_ms: u64,
) {
    let url = format!(
        "{}/api/v1/control/collector/heartbeat",
        control_plane_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();

    // Gửi heartbeat ngay lập tức lần đầu
    send_heartbeat(&client, &url, &collector_id, &collector_public_url,
        max_uploads, upload_slot_ms, &active_uploads, &collector_busy_until_ms).await;

    let mut interval = tokio::time::interval(
        tokio::time::Duration::from_millis(interval_ms)
    );
    interval.tick().await; // consume first tick ngay
    loop {
        interval.tick().await;
        send_heartbeat(&client, &url, &collector_id, &collector_public_url,
            max_uploads, upload_slot_ms, &active_uploads, &collector_busy_until_ms).await;
    }
}

async fn send_heartbeat(
    client: &reqwest::Client,
    url: &str,
    collector_id: &str,
    public_url: &str,
    max_uploads: i64,
    upload_slot_ms: i64,
    active_uploads: &AtomicI64,
    collector_busy_until_ms: &AtomicI64,
) {
    let active = active_uploads.load(Ordering::Relaxed);
    let busy_until_ms = collector_busy_until_ms.load(Ordering::Relaxed);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let ready = active == 0 && busy_until_ms <= now_ms;
    let next_available = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::milliseconds((busy_until_ms - now_ms).max(0)))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let body = json!({
        "collector_id": collector_id,
        "url": public_url,
        "health": "healthy",
        "ready": ready,
        "active_uploads": active,
        "active_leases": 0,
        "max_uploads": max_uploads,
        "next_available_at": next_available,
        "upload_slot_ms": upload_slot_ms,
        "write_latency_ms": 0,
        "storage_lag": 0,
    });

    if let Err(e) = client.post(url).json(&body).send().await {
        tracing::warn!("collector heartbeat failed: {}", e);
    }
}
