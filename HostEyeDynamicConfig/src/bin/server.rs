use anyhow::Result;
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use hosteye_dynamic_config::{
    agent_identity_proof, demo_ed25519_private_key_seed_hex, select_policy, sign_envelope,
    sign_envelope_ed25519, AgentConfigRequest, AgentState, AuditEvent, ConfigAck, ControlPlaneState,
    DynamicPolicy, SignedConfigEnvelope, DEFAULT_ED25519_KEY_ID, ED25519_ALGORITHM, HMAC_SHA256_ALGORITHM,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tokio::fs;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

const SCOPE_POLICY_READ: &str = "policy:read";
const SCOPE_POLICY_WRITE: &str = "policy:write";
const SCOPE_AGENT_READ: &str = "agent:read";
const SCOPE_AUDIT_READ: &str = "audit:read";

#[derive(Clone)]
struct AppState {
    store_path: PathBuf,
    signing_key: String,
    signature_algorithm: String,
    ed25519_key_id: String,
    ed25519_private_key_seed_hex: String,
    admin_tokens: Arc<BTreeMap<String, AdminToken>>,
    require_agent_identity: bool,
    agent_identity_secret: String,
    state: Arc<RwLock<ControlPlaneState>>,
}

#[derive(Debug, Clone)]
struct AdminToken {
    actor: String,
    scopes: Vec<String>,
}

#[derive(Debug, Clone)]
struct AdminPrincipal {
    actor: String,
}

#[derive(Debug, Deserialize)]
struct ConfigQuery {
    host_id: String,
    group_id: String,
    current_policy_id: Option<String>,
    current_version: Option<u64>,
    agent_version: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let port: u16 = env("HOSTEYE_DYNAMIC_CONFIG_PORT", "5063").parse()?;
    let store_path = PathBuf::from(env("HOSTEYE_DYNAMIC_CONFIG_STORE", "./data/dynamic-config-state.json"));
    let signing_key = env("HOSTEYE_DYNAMIC_CONFIG_SIGNING_KEY", "hosteye-dynamic-config-demo-key");
    let signature_algorithm = env("HOSTEYE_DYNAMIC_CONFIG_SIGNATURE_ALGORITHM", ED25519_ALGORITHM);
    let ed25519_key_id = env("HOSTEYE_DYNAMIC_CONFIG_ED25519_KEY_ID", DEFAULT_ED25519_KEY_ID);
    let ed25519_private_key_seed_hex = env(
        "HOSTEYE_DYNAMIC_CONFIG_ED25519_PRIVATE_KEY_SEED_HEX",
        &demo_ed25519_private_key_seed_hex(),
    );
    let admin_tokens = Arc::new(parse_admin_tokens(&env(
        "HOSTEYE_DYNAMIC_CONFIG_ADMIN_TOKENS",
        "hosteye-admin-demo=policy:read,policy:write,agent:read,audit:read",
    )));
    let require_agent_identity = env("HOSTEYE_DYNAMIC_CONFIG_REQUIRE_AGENT_IDENTITY", "true")
        .eq_ignore_ascii_case("true");
    let agent_identity_secret = env("HOSTEYE_DYNAMIC_CONFIG_AGENT_IDENTITY_SECRET", "hosteye-agent-identity-demo-secret");

    let loaded = load_state(&store_path).await.unwrap_or_default();
    let app_state = AppState {
        store_path,
        signing_key,
        signature_algorithm,
        ed25519_key_id,
        ed25519_private_key_seed_hex,
        admin_tokens,
        require_agent_identity,
        agent_identity_secret,
        state: Arc::new(RwLock::new(loaded)),
    };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/dynamic-config/policies", get(list_policies).post(upsert_policy))
        .route("/api/v1/dynamic-config/agents", get(list_agents))
        .route("/api/v1/dynamic-config/audit", get(list_audit))
        .route("/api/v1/dynamic-config/agents/:agent_id/config", get(get_agent_config))
        .route("/api/v1/dynamic-config/agents/:agent_id/ack", post(ack_config))
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("HostEye Dynamic Config server listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "hosteye-dynamic-config" }))
}

async fn list_policies(State(app): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<DynamicPolicy>>, ApiError> {
    require_admin_scope(&app, &headers, SCOPE_POLICY_READ)?;
    let guard = app.state.read().map_err(|_| ApiError::internal("state lock poisoned"))?;
    Ok(Json(guard.policies.clone()))
}

async fn list_agents(State(app): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<AgentState>>, ApiError> {
    require_admin_scope(&app, &headers, SCOPE_AGENT_READ)?;
    let guard = app.state.read().map_err(|_| ApiError::internal("state lock poisoned"))?;
    Ok(Json(guard.agents.values().cloned().collect()))
}

async fn list_audit(State(app): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<AuditEvent>>, ApiError> {
    require_admin_scope(&app, &headers, SCOPE_AUDIT_READ)?;
    let guard = app.state.read().map_err(|_| ApiError::internal("state lock poisoned"))?;
    Ok(Json(guard.audit_events.iter().rev().take(200).cloned().collect()))
}

async fn upsert_policy(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(mut policy): Json<DynamicPolicy>,
) -> Result<Json<DynamicPolicy>, ApiError> {
    let principal = require_admin_scope(&app, &headers, SCOPE_POLICY_WRITE)?;
    policy.updated_at = Utc::now();

    let event = AuditEvent {
        event_id: Uuid::new_v4().to_string(),
        event_type: "policy_upsert".to_string(),
        actor: principal.actor,
        target: policy.policy_id.clone(),
        message: format!("policy version {} upserted", policy.version),
        created_at: Utc::now(),
    };

    let snapshot = {
        let mut guard = app.state.write().map_err(|_| ApiError::internal("state lock poisoned"))?;
        if let Some(existing) = guard.policies.iter_mut().find(|item| item.policy_id == policy.policy_id) {
            *existing = policy.clone();
        } else {
            guard.policies.push(policy.clone());
        }
        guard.audit_events.push(event);
        trim_audit(&mut guard.audit_events);
        guard.clone()
    };

    save_state(&app.store_path, &snapshot).await?;
    Ok(Json(policy))
}

async fn get_agent_config(
    State(app): State<AppState>,
    Path(agent_id): Path<String>,
    Query(query): Query<ConfigQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    require_agent_identity(&app, &headers, &agent_id, &query.host_id, &query.group_id)?;

    let request = AgentConfigRequest {
        agent_id: agent_id.clone(),
        host_id: query.host_id,
        group_id: query.group_id,
        current_policy_id: query.current_policy_id,
        current_version: query.current_version,
        agent_version: query.agent_version.unwrap_or_else(|| "0.1.0".to_string()),
    };

    let policy = {
        let guard = app.state.read().map_err(|_| ApiError::internal("state lock poisoned"))?;
        select_policy(&guard, &request)
            .cloned()
            .ok_or_else(|| ApiError::not_found("no enabled policy matched this agent"))?
    };

    let is_current = request.current_policy_id.as_deref() == Some(policy.policy_id.as_str())
        && request.current_version == Some(policy.version);
    let now = Utc::now();
    let snapshot = {
        let mut guard = app.state.write().map_err(|_| ApiError::internal("state lock poisoned"))?;
        let agent = guard.agents.entry(agent_id.clone()).or_insert_with(|| AgentState {
            agent_id: agent_id.clone(),
            host_id: request.host_id.clone(),
            group_id: request.group_id.clone(),
            agent_version: request.agent_version.clone(),
            reported_policy_id: request.current_policy_id.clone(),
            reported_version: request.current_version,
            desired_policy_id: policy.policy_id.clone(),
            desired_version: policy.version,
            delivery_status: if is_current { "up_to_date" } else { "sent_waiting_ack" }.to_string(),
            last_poll_at: Some(now),
            last_delivery_at: if is_current { None } else { Some(now) },
            last_ack_at: None,
            last_policy_id: String::new(),
            last_version: 0,
            last_seen_at: now,
            last_ack_status: "not_acknowledged".to_string(),
            last_ack_message: String::new(),
        });
        agent.host_id = request.host_id.clone();
        agent.group_id = request.group_id.clone();
        agent.agent_version = request.agent_version.clone();
        agent.reported_policy_id = request.current_policy_id.clone();
        agent.reported_version = request.current_version;
        agent.desired_policy_id = policy.policy_id.clone();
        agent.desired_version = policy.version;
        agent.delivery_status = if is_current { "up_to_date" } else { "sent_waiting_ack" }.to_string();
        agent.last_poll_at = Some(now);
        if !is_current {
            agent.last_delivery_at = Some(now);
        }
        agent.last_seen_at = now;
        guard.clone()
    };
    save_state(&app.store_path, &snapshot).await?;

    if is_current {
        return Ok((StatusCode::NOT_MODIFIED, "").into_response());
    }

    let unsigned = SignedConfigEnvelope {
        envelope_version: 1,
        policy_id: policy.policy_id,
        version: policy.version,
        issued_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(30),
        agent_id: request.agent_id,
        host_id: request.host_id,
        group_id: request.group_id,
        config_sha256: String::new(),
        config: policy.config,
        signature_algorithm: app.signature_algorithm.clone(),
        key_id: String::new(),
        signature: String::new(),
    };

    let signed = match app.signature_algorithm.as_str() {
        ED25519_ALGORITHM => sign_envelope_ed25519(
            unsigned,
            &app.ed25519_key_id,
            &app.ed25519_private_key_seed_hex,
        )?,
        HMAC_SHA256_ALGORITHM => sign_envelope(unsigned, &app.signing_key)?,
        other => return Err(ApiError::bad_request(&format!("unsupported signature algorithm: {other}"))),
    };

    Ok(Json(signed).into_response())
}

async fn ack_config(
    State(app): State<AppState>,
    Path(agent_id): Path<String>,
    headers: HeaderMap,
    Json(ack): Json<ConfigAck>,
) -> Result<Json<AgentState>, ApiError> {
    if ack.agent_id != agent_id {
        return Err(ApiError::bad_request("ack agent_id does not match path"));
    }
    require_agent_identity(&app, &headers, &ack.agent_id, &ack.host_id, &ack.group_id)?;

    let agent = AgentState {
        agent_id: ack.agent_id.clone(),
        host_id: ack.host_id.clone(),
        group_id: ack.group_id.clone(),
        agent_version: String::new(),
        reported_policy_id: successful_ack(&ack.status).then(|| ack.policy_id.clone()),
        reported_version: successful_ack(&ack.status).then_some(ack.version),
        desired_policy_id: ack.policy_id.clone(),
        desired_version: ack.version,
        delivery_status: ack_delivery_status(&ack.status).to_string(),
        last_poll_at: None,
        last_delivery_at: None,
        last_ack_at: Some(ack.applied_at),
        last_policy_id: ack.policy_id.clone(),
        last_version: ack.version,
        last_seen_at: ack.applied_at,
        last_ack_status: ack.status.clone(),
        last_ack_message: ack.message.clone(),
    };

    let snapshot = {
        let mut guard = app.state.write().map_err(|_| ApiError::internal("state lock poisoned"))?;
        let current = guard.agents.entry(ack.agent_id.clone()).or_insert(agent.clone());
        current.host_id = ack.host_id;
        current.group_id = ack.group_id;
        if successful_ack(&ack.status) {
            current.reported_policy_id = Some(ack.policy_id.clone());
            current.reported_version = Some(ack.version);
        }
        current.desired_policy_id = ack.policy_id.clone();
        current.desired_version = ack.version;
        current.delivery_status = ack_delivery_status(&ack.status).to_string();
        current.last_ack_at = Some(ack.applied_at);
        current.last_policy_id = ack.policy_id;
        current.last_version = ack.version;
        current.last_seen_at = ack.applied_at;
        current.last_ack_status = ack.status;
        current.last_ack_message = ack.message;
        guard.clone()
    };

    save_state(&app.store_path, &snapshot).await?;
    let guard = app.state.read().map_err(|_| ApiError::internal("state lock poisoned"))?;
    Ok(Json(guard.agents.get(&agent_id).cloned().unwrap_or(agent)))
}

fn successful_ack(status: &str) -> bool {
    matches!(status, "applied" | "rendered")
}

fn ack_delivery_status(status: &str) -> &str {
    match status {
        "applied" => "applied",
        "rendered" => "rendered",
        "apply_failed" => "apply_failed",
        _ => "acknowledged",
    }
}

async fn load_state(path: &PathBuf) -> Result<ControlPlaneState> {
    let bytes = fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn save_state(path: &PathBuf, state: &ControlPlaneState) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(state)?;
    fs::write(path, bytes).await?;
    Ok(())
}

fn require_admin_scope(app: &AppState, headers: &HeaderMap, required_scope: &str) -> Result<AdminPrincipal, ApiError> {
    let token = headers
        .get("x-hosteye-admin-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let admin = app
        .admin_tokens
        .get(token)
        .ok_or_else(|| ApiError::unauthorized("invalid admin token"))?;
    if !admin.scopes.iter().any(|scope| scope == "*" || scope == required_scope) {
        return Err(ApiError::forbidden(&format!("admin token missing scope {required_scope}")));
    }
    Ok(AdminPrincipal {
        actor: admin.actor.clone(),
    })
}

fn require_agent_identity(
    app: &AppState,
    headers: &HeaderMap,
    agent_id: &str,
    host_id: &str,
    group_id: &str,
) -> Result<(), ApiError> {
    if !app.require_agent_identity {
        return Ok(());
    }

    let header_agent_id = header(headers, "x-hosteye-agent-id");
    let header_host_id = header(headers, "x-hosteye-host-id");
    let header_group_id = header(headers, "x-hosteye-group-id");
    let proof = header(headers, "x-hosteye-agent-proof");

    if header_agent_id != agent_id || header_host_id != host_id || header_group_id != group_id {
        return Err(ApiError::unauthorized("agent identity headers do not match request identity"));
    }

    let expected = agent_identity_proof(&app.agent_identity_secret, agent_id, host_id, group_id)?;
    if !constant_time_eq(expected.as_bytes(), proof.as_bytes()) {
        return Err(ApiError::unauthorized("invalid agent identity proof"));
    }
    Ok(())
}

fn parse_admin_tokens(value: &str) -> BTreeMap<String, AdminToken> {
    let mut tokens = BTreeMap::new();
    for entry in value.split(';').map(str::trim).filter(|item| !item.is_empty()) {
        let Some((token, scopes)) = entry.split_once('=') else { continue };
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let scopes = scopes
            .split(',')
            .map(str::trim)
            .filter(|scope| !scope.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        tokens.insert(
            token.to_string(),
            AdminToken {
                actor: format!("admin:{}", token_fingerprint(token)),
                scopes,
            },
        );
    }
    tokens
}

fn trim_audit(events: &mut Vec<AuditEvent>) {
    const MAX_AUDIT_EVENTS: usize = 5000;
    if events.len() > MAX_AUDIT_EVENTS {
        let drain_count = events.len() - MAX_AUDIT_EVENTS;
        events.drain(0..drain_count);
    }
}

fn token_fingerprint(token: &str) -> String {
    let digest = hosteye_dynamic_config::sha256_json(&token).unwrap_or_else(|_| "unknown".to_string());
    digest.chars().take(12).collect()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or("")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: &str) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: message.to_string() }
    }

    fn unauthorized(message: &str) -> Self {
        Self { status: StatusCode::UNAUTHORIZED, message: message.to_string() }
    }

    fn forbidden(message: &str) -> Self {
        Self { status: StatusCode::FORBIDDEN, message: message.to_string() }
    }

    fn not_found(message: &str) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: message.to_string() }
    }

    fn internal(message: &str) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: message.to_string() }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": self.status.as_u16(),
                "message": self.message,
            })),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self::internal(&value.to_string())
    }
}


