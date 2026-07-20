use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use std::sync::Arc;
use tokio::net::TcpListener;

// Import the ControlPlane from our library code
#[path = "../control_plane/index.rs"]
mod control_plane;

use control_plane::{BootstrapPayload, CollectorHeartbeatPayload, ControlPlane};

#[derive(Clone)]
struct AppState {
    control_plane: Arc<ControlPlane>,
}

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::fmt::init();

    let port = std::env::var("CONTROL_PORT")
        .or_else(|_| std::env::var("PORT"))
        .unwrap_or_else(|_| "8080".to_string());
    
    let state = AppState {
        control_plane: Arc::new(ControlPlane::new()),
    };

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/v1/control/collectors", get(list_collectors_handler))
        .route("/api/v1/control/collector/heartbeat", post(heartbeat_handler))
        .route("/api/v1/control/bootstrap", post(bootstrap_handler))
        .route("/api/v1/admission/request", post(legacy_admission_handler))
        .route("/api/v1/agent/config", get(agent_config_handler))
        .route("/api/v1/agent/config/", get(agent_config_handler))
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
