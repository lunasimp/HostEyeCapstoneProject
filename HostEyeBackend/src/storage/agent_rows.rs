use clickhouse::Row;
use serde::Serialize;
use serde_json::Value;
use crate::data_plane::receiver::IngestContext;

/// Cấu hình agent mặc định (từ env hoặc hardcode defaults).
/// Các giá trị này được ghi vào registered_agents khi agent checkin lần đầu.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub normal_jitter_window_ms: u32,
    pub recovery_jitter_window_ms: u32,
    pub max_events: u32,
    pub max_bytes: u64,
    pub enabled: bool,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            normal_jitter_window_ms: 30_000,
            recovery_jitter_window_ms: 300_000,
            max_events: 500,
            max_bytes: 524_288,
            enabled: true,
        }
    }
}

impl AgentConfig {
    pub fn from_env() -> Self {
        Self {
            normal_jitter_window_ms: std::env::var("AGENT_NORMAL_JITTER_WINDOW_MS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(30_000),
            recovery_jitter_window_ms: std::env::var("AGENT_RECOVERY_JITTER_WINDOW_MS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(300_000),
            max_events: std::env::var("AGENT_MAX_EVENTS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(500),
            max_bytes: std::env::var("AGENT_MAX_BYTES")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(524_288),
            enabled: std::env::var("AGENT_ENABLED")
                .map(|v| v.to_lowercase() != "false").unwrap_or(true),
        }
    }
}

/// Row được insert vào `default.registered_agents` (ReplacingMergeTree by last_seen).
///
/// Schema (005_registered_agents_and_jitter_timing.sql):
///   ORDER BY (agent_id, host_id, computer)
///   → mỗi agent được identify bởi 3 fields này
///   → ReplacingMergeTree merge các row trùng key, giữ lại row có last_seen lớn nhất
#[derive(Debug, Row, Serialize)]
pub struct RegisteredAgentRow {
    pub first_seen: String,                // DateTime64(3) as ISO string
    pub last_seen: String,
    pub agent_id: String,
    pub host_id: String,
    pub ci_id: String,
    pub computer: String,
    pub cert_serial: String,               // ← từ IngestContext (X-Client-Cert-Serial)
    pub schema_version: String,
    pub source_platform: String,
    pub shipper_version: String,
    pub status: String,                    // "active" | "disabled"
    pub enrollment_status: String,         // "auto_registered" | "revoked"
    pub last_chunk_id: String,
    pub last_ack_status: String,
    pub last_event_count: u32,
    pub normal_jitter_window_ms: u32,
    pub recovery_jitter_window_ms: u32,
    pub max_events: u32,
    pub max_bytes: u64,
    pub message: String,
}

/// Build RegisteredAgentRow từ chunk payload + IngestContext.
///
/// Port từ buildRegisteredAgentRow() trong Node.js dataplane/index.js.
/// cert_serial đến từ IngestContext (X-Client-Cert-Serial header của Nginx).
pub fn build_registered_agent_row(
    payload: &Value,
    context: &IngestContext,
    status: &str,
    message: &str,
    config: &AgentConfig,
) -> RegisteredAgentRow {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    RegisteredAgentRow {
        first_seen: now.clone(),
        last_seen: now,
        agent_id: str_field(payload, "agent_id"),
        host_id: str_field(payload, "host_id"),
        ci_id: str_field(payload, "ci_id"),
        computer: str_field(payload, "computer"),
        cert_serial: context.cert_serial.clone(),
        schema_version: str_field(payload, "schema_version"),
        source_platform: {
            let sp = str_field(payload, "source_platform");
            if sp.is_empty() { "hosteye_windows_endpoint".to_string() } else { sp }
        },
        shipper_version: str_field(payload, "shipper_version"),
        status: if config.enabled { "active" } else { "disabled" }.to_string(),
        enrollment_status: if str_field(payload, "ci_id").is_empty() { "auto_registered" } else { "enrolled" }.to_string(),
        last_chunk_id: str_field(payload, "chunk_id"),
        last_ack_status: {
            let ack = str_field(payload, "ack_status");
            if ack.is_empty() { status.to_string() } else { ack }
        },
        last_event_count: payload.get("event_count")
            .or_else(|| payload.get("batch_size"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        normal_jitter_window_ms: payload.get("normal_jitter_window_ms")
            .or_else(|| payload.get("jitter_window_ms"))
            .and_then(|v| v.as_u64())
            .unwrap_or(config.normal_jitter_window_ms as u64) as u32,
        recovery_jitter_window_ms: payload.get("recovery_jitter_window_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(config.recovery_jitter_window_ms as u64) as u32,
        max_events: payload.get("max_events")
            .and_then(|v| v.as_u64())
            .unwrap_or(config.max_events as u64) as u32,
        max_bytes: payload.get("max_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(config.max_bytes),
        message: message.to_string(),
    }
}

fn str_field(payload: &Value, field: &str) -> String {
    payload.get(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}
