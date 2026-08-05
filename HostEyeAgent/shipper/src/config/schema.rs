// config/schema.rs
// Port từ: Models/ShipperConfig.cs + Models/ShipperState.cs + Models/Exceptions.cs

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};

// ──────────────────────────────────────────────
// ShipperConfig  (= ShipperConfig.cs)
// ──────────────────────────────────────────────

fn default_gateway_uri()       -> String { "https://hosteye.iahn.hanoi.vn/api/v1/telemetry".into() }
fn default_group_id()          -> String { "default".into() }
fn default_signing_key()       -> String { "hosteye-dynamic-config-demo-key".into() }
fn default_spool_dir()         -> String { r"C:\ProgramData\HostEye\spool".into() }
fn default_state_dir()         -> String { r"C:\ProgramData\HostEye\shipper_state".into() }
fn default_log_dir()           -> String { r"C:\ProgramData\HostEye\logs".into() }
fn default_client_cert()       -> String { r"C:\Program Files\HostEye\certs\client.crt".into() }
fn default_client_key()        -> String { r"C:\Program Files\HostEye\certs\client.key".into() }
fn default_ca_cert()           -> String { r"C:\Program Files\HostEye\certs\company_ca.crt".into() }
fn default_max_events()        -> i32    { 1000 }
fn default_max_bytes()         -> i32    { 1048576 }
fn default_startup_jitter()    -> i32    { 300 }
fn default_normal_jitter()     -> i32    { 120 }
fn default_recovery_jitter()   -> i32    { 900 }
fn default_base_backoff()      -> i32    { 2 }
fn default_max_backoff()       -> i32    { 300 }
fn default_max_spool_mb()      -> i64    { 8192 }
fn default_low_watermark()     -> i32    { 85 }
fn default_spool_check()       -> i32    { 30 }
fn default_config_sync_int()   -> i32    { 1800 }
fn default_config_sync_jit()   -> i32    { 300 }
fn default_heartbeat_int()     -> i32    { 300 }
fn default_heartbeat_jit()     -> i32    { 60 }
fn default_true()              -> bool   { true }
fn default_sent_retention()    -> i32    { 2 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ShipperConfig {
    #[serde(default = "default_gateway_uri")]
    pub gateway_uri: String,

    #[serde(default)]
    pub config_uri: String,

    #[serde(default)]
    pub admission_uri: String,

    #[serde(default = "default_group_id")]
    pub group_id: String,

    #[serde(default = "default_signing_key")]
    pub agent_config_signing_key: String,

    #[serde(default = "default_spool_dir")]
    pub spool_directory: String,

    #[serde(default = "default_state_dir")]
    pub state_directory: String,

    #[serde(default = "default_log_dir")]
    pub log_directory: String,

    #[serde(default = "default_client_cert")]
    pub client_certificate_file: String,

    #[serde(default = "default_client_key")]
    pub client_key_file: String,

    #[serde(default = "default_ca_cert")]
    pub ca_certificate_file: String,

    #[serde(default = "default_true")]
    pub allow_system_server_certificate_trust: bool,

    #[serde(default = "default_max_events")]
    pub max_events: i32,

    #[serde(default = "default_max_bytes")]
    pub max_bytes: i32,

    #[serde(default = "default_startup_jitter")]
    pub startup_jitter_window_seconds: i32,

    #[serde(default = "default_normal_jitter")]
    pub normal_jitter_window_seconds: i32,

    #[serde(default = "default_recovery_jitter")]
    pub recovery_jitter_window_seconds: i32,

    #[serde(default = "default_base_backoff")]
    pub base_backoff_seconds: i32,

    #[serde(default = "default_max_backoff")]
    pub max_backoff_seconds: i32,

    #[serde(default = "default_max_spool_mb")]
    pub max_spool_size_mb: i64,

    #[serde(default = "default_low_watermark")]
    pub low_watermark_percent: i32,

    #[serde(default = "default_spool_check")]
    pub spool_check_interval_seconds: i32,

    #[serde(default = "default_config_sync_int")]
    pub config_sync_interval_seconds: i32,

    #[serde(default = "default_config_sync_jit")]
    pub config_sync_jitter_seconds: i32,

    #[serde(default = "default_heartbeat_int")]
    pub heartbeat_interval_seconds: i32,

    #[serde(default = "default_heartbeat_jit")]
    pub heartbeat_jitter_seconds: i32,

    #[serde(default = "default_true")]
    pub prefer_deleting_sent_first: bool,

    #[serde(default = "default_sent_retention")]
    pub sent_retention_days: i32,

    #[serde(default = "default_true")]
    pub enable_config_sync: bool,

    #[serde(default = "default_true")]
    pub enable_admission_control: bool,

    #[serde(default = "default_true")]
    pub require_upload_lease: bool,

    #[serde(default)]
    pub run_once: bool,
}

impl Default for ShipperConfig {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

impl ShipperConfig {
    /// Load từ JSON file; nếu file không tồn tại thì dùng default.
    pub fn load(path: &str) -> anyhow::Result<Self> {
        if !Path::new(path).exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(path)?;
        // case-insensitive: serde_json không hỗ trợ natively nên dùng PascalCase
        // nhưng đồng thời chấp nhận lowercase bằng alias ở từng field nếu cần.
        let cfg = serde_json::from_str::<Self>(&text)
            .unwrap_or_else(|_| Self::default());
        Ok(cfg)
    }
}

// ──────────────────────────────────────────────
// FileCheckpoint  (= FileCheckpoint.cs)
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileCheckpoint {
    #[serde(rename = "LineOffset", default)]
    pub line_offset: i32,

    #[serde(rename = "ByteOffset", default)]
    pub byte_offset: u64,

    #[serde(rename = "UpdatedAtUtc")]
    pub updated_at_utc: DateTime<Utc>,
}

impl Default for FileCheckpoint {
    fn default() -> Self {
        Self {
            line_offset:    0,
            byte_offset:    0,
            updated_at_utc: Utc::now(),
        }
    }
}

// ──────────────────────────────────────────────
// ShipperState  (= ShipperState.cs)
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ShipperState {
    #[serde(rename = "Files", default)]
    pub files: HashMap<String, FileCheckpoint>,

    #[serde(rename = "AgentConfigEtag", default)]
    pub agent_config_etag: String,

    #[serde(rename = "AgentConfigPolicyId", default)]
    pub agent_config_policy_id: String,

    #[serde(rename = "AgentConfigPolicyVersion", default)]
    pub agent_config_policy_version: i32,

    #[serde(rename = "AgentConfigSha256", default)]
    pub agent_config_sha256: String,

    #[serde(rename = "AgentConfigCachedJson", default)]
    pub agent_config_cached_json: String,

    #[serde(rename = "LastSuccessTime")]
    pub last_success_time: Option<DateTime<Utc>>,

    #[serde(rename = "CollectedEventCount", default)]
    pub collected_event_count: u64,

    #[serde(rename = "SentEventCount", default)]
    pub sent_event_count: u64,

    #[serde(rename = "DroppedEventCount", default)]
    pub dropped_event_count: u64,
    #[serde(rename = "CollectedEventsBySource", default)]
    pub collected_events_by_source: HashMap<String, u64>,

    #[serde(rename = "DroppedEventsBySource", default)]
    pub dropped_events_by_source: HashMap<String, u64>,

    #[serde(rename = "UnattributedDroppedEventCount", default)]
    pub unattributed_dropped_event_count: u64,

    /// Path file state trên disk — không serialize.
    #[serde(skip)]
    pub path_on_disk: String,
}

impl ShipperState {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !Path::new(path).exists() {
            return Ok(Self { path_on_disk: path.to_string(), ..Default::default() });
        }
        let text = std::fs::read_to_string(path)?;
        let mut state: Self = serde_json::from_str(&text).unwrap_or_default();
        state.path_on_disk = path.to_string();
        Ok(state)
    }

    pub fn get_checkpoint(&mut self, file: &str) -> &FileCheckpoint {
        let key = canonicalize_key(file);
        self.files.entry(key).or_insert_with(FileCheckpoint::default)
    }

    pub fn set_checkpoint(&mut self, file: &str, line_offset: i32, byte_offset: u64) {
        let key = canonicalize_key(file);
        self.files.insert(key, FileCheckpoint {
            line_offset,
            byte_offset,
            updated_at_utc: Utc::now(),
        });
    }

    pub fn save(&self) -> anyhow::Result<()> {
        if self.path_on_disk.is_empty() {
            return Ok(());
        }
        let json = serde_json::to_string_pretty(self)?;
        // Atomic write: ghi ra file tmp rồi rename
        let tmp = format!("{}.tmp", self.path_on_disk);
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.path_on_disk)?;
        Ok(())
    }
}

fn canonicalize_key(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_else(|_| path.to_lowercase())
}
