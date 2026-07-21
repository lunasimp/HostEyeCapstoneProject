use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use tokio::net::TcpListener;

// Import the ControlPlane from our library code
#[path = "../control_plane/index.rs"]
mod control_plane;

#[path = "../storage/mod.rs"]
mod storage;

use control_plane::{BootstrapPayload, CollectorHeartbeatPayload, ControlPlane};
use storage::agent_error_rows::{AgentErrorReport, AgentChunkErrorRow};

#[derive(Clone)]
struct AppState {
    control_plane: Arc<ControlPlane>,
    ch: clickhouse::Client,
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    let port = std::env::var("CONTROL_PORT")
        .or_else(|_| std::env::var("PORT"))
        .unwrap_or_else(|_| "8080".to_string());
    
    let clickhouse_url = std::env::var("CLICKHOUSE_URL")
        .unwrap_or_else(|_| "http://clickhouse:8123".to_string());
    let ch = clickhouse::Client::default().with_url(&clickhouse_url);

    let state = AppState {
        control_plane: Arc::new(ControlPlane::new()),
        ch,
    };

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/v1/control/collectors", get(list_collectors_handler))
        .route("/api/v1/control/collector/heartbeat", post(heartbeat_handler))
        .route("/api/v1/control/bootstrap", post(bootstrap_handler))
        .route("/api/v1/admission/request", post(legacy_admission_handler))
        .route("/api/v1/agent/config", get(agent_config_handler))
        .route("/api/v1/agent/config/", get(agent_config_handler))
        // Agent Telemetry — báo cáo lỗi chunk từ Agent
        .route("/api/v1/agent/telemetry/errors", post(report_agent_errors_handler))
        .route("/api/v1/agent/telemetry/errors", get(list_agent_errors_handler))
        .route("/api/v1/agent/telemetry/errors/summary", get(summary_agent_errors_handler))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    println!("HostEye Control Plane listening on {}", addr);
    
    let listener = TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "ok": true, "service": "hosteye-control-plane" })))
}

async fn list_collectors_handler(State(state): State<AppState>) -> impl IntoResponse {
    let collectors = state.control_plane.list_collectors().await;
    (StatusCode::OK, Json(json!({ "collectors": collectors })))
}

async fn heartbeat_handler(
    State(state): State<AppState>,
    Json(payload): Json<CollectorHeartbeatPayload>,
) -> impl IntoResponse {
    let now = chrono::Utc::now();
    let result = state.control_plane.heartbeat(payload, now).await;
    
    (StatusCode::OK, Json(json!({
        "ok": true,
        "collector_id": result.collector_id,
        "last_seen": result.last_seen,
        "capacity_score": result.capacity_score,
        "ready": result.ready,
        "next_available_at": result.next_available_at,
        "upload_slot_ms": result.upload_slot_ms,
    })))
}

async fn bootstrap_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BootstrapPayload>,
) -> impl IntoResponse {
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    match state.control_plane.bootstrap(payload, if_none_match).await {
        Ok((status_code, response)) => {
            let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
            (status, Json(serde_json::to_value(response).unwrap())).into_response()
        }
        Err(err) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "message": err })),
            ).into_response()
        }
    }
}

async fn legacy_admission_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BootstrapPayload>,
) -> impl IntoResponse {
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|h| h.to_str().ok())
        .map(|s| s.to_string());

    match state.control_plane.bootstrap(payload, if_none_match).await {
        Ok((status_code, response)) => {
            let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);
            let legacy_response = json!({
                "admission": response.admission,
                "lease_id": response.lease_id,
                "lease_ttl_seconds": response.lease_ttl_seconds,
                "lease_expires_at": response.lease_expires_at,
                "max_batch_mb": response.max_batch_mb,
                "max_upload_rate_kbps": response.max_upload_rate_kbps,
                "retry_after_seconds": response.retry_after_seconds,
                "message": response.message,
            });
            (status, Json(legacy_response)).into_response()
        }
        Err(err) => {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": "error", "message": err })),
            ).into_response()
        }
    }
}

async fn agent_config_handler() -> impl IntoResponse {
    let mock_config = json!({
        "version": "1.0",
        "global": {
            "data_dir": "C:\\ProgramData\\HostEye\\data"
        }
    });
    (StatusCode::OK, Json(mock_config))
}

// ── Agent Telemetry Handlers ──────────────────────────────────────────────────

/// Query params dùng chung cho 2 GET endpoint.
#[derive(Debug, Deserialize, Default)]
struct ErrorQueryParams {
    agent_id: Option<String>,
    since: Option<String>,      // ISO 8601, default: 24h trước
    error_type: Option<String>,
}

/// POST /api/v1/agent/telemetry/errors
/// Agent gửi batch báo cáo lỗi chunk (tối đa 5 items/request).
/// Không validate thêm, INSERT thẳng vào ClickHouse, trả 200.
async fn report_agent_errors_handler(
    State(state): State<AppState>,
    Json(payload): Json<AgentErrorReport>,
) -> impl IntoResponse {
    let now = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let rows = payload.into_rows(&now);
    if rows.is_empty() {
        return (StatusCode::OK, Json(json!({ "ok": true, "inserted": 0 }))).into_response();
    }

    let mut insert = match state.ch.insert("agent_chunk_errors") {
        Ok(ins) => ins,
        Err(e) => {
            tracing::error!("Failed to create CH insert for agent_chunk_errors: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "db_error" }))).into_response();
        }
    };

    let count = rows.len();
    for row in rows {
        if let Err(e) = insert.write(&row).await {
            tracing::error!("Failed to write agent_chunk_error row: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "write_error" }))).into_response();
        }
    }

    if let Err(e) = insert.end().await {
        tracing::error!("Failed to commit agent_chunk_errors batch: {}", e);
        return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "commit_error" }))).into_response();
    }

    (StatusCode::OK, Json(json!({ "ok": true, "inserted": count }))).into_response()
}

/// GET /api/v1/agent/telemetry/errors
/// Dashboard lấy danh sách chi tiết từng chunk_id bị lỗi.
/// Query params: agent_id, since (ISO), error_type
async fn list_agent_errors_handler(
    State(state): State<AppState>,
    Query(params): Query<ErrorQueryParams>,
) -> impl IntoResponse {
    let since = params.since.unwrap_or_else(|| {
        (chrono::Utc::now() - chrono::Duration::hours(24))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });

    let mut sql = String::from(
        "SELECT reported_at, agent_id, chunk_id, error_type, quarantined_at \
         FROM agent_chunk_errors WHERE reported_at >= ?"
    );
    let mut args: Vec<String> = vec![since];

    if let Some(ref aid) = params.agent_id {
        sql.push_str(" AND agent_id = ?");
        args.push(aid.clone());
    }
    if let Some(ref et) = params.error_type {
        sql.push_str(" AND error_type = ?");
        args.push(et.clone());
    }
    sql.push_str(" ORDER BY quarantined_at DESC LIMIT 200");

    // Build query với positional args
    let mut q = clickhouse::query::Query::new(&state.ch, &sql);
    for arg in &args {
        q = q.bind(arg.as_str());
    }

    match q.fetch_all::<AgentChunkErrorRow>().await {
        Ok(rows) => {
            let data: Vec<_> = rows.iter().map(|r| json!({
                "reported_at":    r.reported_at,
                "agent_id":       r.agent_id,
                "chunk_id":       r.chunk_id,
                "error_type":     r.error_type,
                "quarantined_at": r.quarantined_at,
            })).collect();
            (StatusCode::OK, Json(json!({ "total": data.len(), "errors": data }))).into_response()
        }
        Err(e) => {
            tracing::error!("list_agent_errors query failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "query_error" }))).into_response()
        }
    }
}

/// GET /api/v1/agent/telemetry/errors/summary
/// Dashboard lấy bảng tổng hợp: mỗi Agent có bao nhiêu lỗi theo từng loại.
async fn summary_agent_errors_handler(
    State(state): State<AppState>,
    Query(params): Query<ErrorQueryParams>,
) -> impl IntoResponse {
    let since = params.since.unwrap_or_else(|| {
        (chrono::Utc::now() - chrono::Duration::hours(24))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    });

    let sql = "
        SELECT
            agent_id,
            countIf(error_type = 'checksum_invalid')      AS checksum_invalid,
            countIf(error_type = 'event_count_mismatch')  AS event_count_mismatch,
            countIf(error_type = 'missing_fields')        AS missing_fields,
            countIf(error_type = 'schema_invalid')        AS schema_invalid,
            countIf(error_type = 'conflict_409')          AS conflict_409,
            count()                                        AS total
        FROM agent_chunk_errors
        WHERE reported_at >= ?
        GROUP BY agent_id
        ORDER BY total DESC
    ";

    match clickhouse::query::Query::new(&state.ch, sql)
        .bind(since.as_str())
        .fetch_all::<(String, u64, u64, u64, u64, u64, u64)>()
        .await
    {
        Ok(rows) => {
            let agents: Vec<_> = rows.iter().map(|(aid, ci, ecm, mf, si, c409, tot)| json!({
                "agent_id":              aid,
                "checksum_invalid":      ci,
                "event_count_mismatch":  ecm,
                "missing_fields":        mf,
                "schema_invalid":        si,
                "conflict_409":          c409,
                "total":                 tot,
            })).collect();
            (StatusCode::OK, Json(json!({ "agents": agents }))).into_response()
        }
        Err(e) => {
            tracing::error!("summary_agent_errors query failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "query_error" }))).into_response()
        }
    }
}
