use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorState {
    pub collector_id: String,
    pub url: String,
    pub health: String,
    pub ready: bool,
    pub active_uploads: i64,
    pub max_uploads: i64,
    pub upload_slot_ms: i64,
    pub heartbeat_next_available_at: String,
    #[serde(default)]
    pub control_reserved_until: String,
    pub next_available_at: String,
    pub write_latency_ms: i64,
    pub storage_lag: i64,
    #[serde(default)]
    pub storage_tag: String,
    pub capacity_score: i64,
    pub last_seen: String,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub reserved_until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_next_available_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_control_reserved_until: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueueState {
    pub next_chunk_size_mb: Option<f64>,
    pub queue_used_mb: Option<f64>,
    pub retry_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapPayload {
    pub agent_id: Option<String>,
    pub host_id: Option<String>,
    pub computer: Option<String>,
    pub next_chunk_size_mb: Option<f64>,
    pub queue_state: Option<QueueState>,
    pub config_etag: Option<String>,
    pub queue_used_mb: Option<f64>,
    pub retry_count: Option<i64>,
    pub loss_metrics_version: Option<u8>,
    pub collected_event_count: Option<u64>,
    pub sent_event_count: Option<u64>,
    pub pending_event_count: Option<u64>,
    pub dropped_event_count: Option<u64>,
    pub collected_events_by_source: Option<HashMap<String, u64>>,
    pub dropped_events_by_source: Option<HashMap<String, u64>>,
    pub unattributed_dropped_event_count: Option<u64>,
    pub max_spool_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorHeartbeatPayload {
    pub collector_id: Option<String>,
    pub url: Option<String>,
    pub health: Option<String>,
    pub ready: Option<bool>,
    pub active_uploads: Option<i64>,
    pub max_uploads: Option<i64>,
    pub write_latency_ms: Option<i64>,
    pub storage_lag: Option<i64>,
    pub upload_slot_ms: Option<i64>,
    pub next_available_at: Option<String>,
    pub storage_tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingInfo {
    pub control_url: String,
    pub admission_url: String,
    pub telemetry_url: String,
    pub config_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmissionResponse {
    pub admission: String,
    pub config_status: String,
    pub config_etag: String,
    pub agent_config: serde_json::Value,
    pub collector_id: String,
    pub collector_url: String,
    pub routing: RoutingInfo,
    pub server_time: String,
    pub send_after: String,
    pub send_not_before: String,
    pub send_delay_ms: i64,
    pub schedule_reason: String,
    pub collector_ready_at: String,
    pub collector_reserved_until: String,
    pub collector_upload_slot_ms: i64,
    pub lease_id: String,
    pub lease_ttl_seconds: i64,
    pub lease_expires_at: String,
    pub max_batch_mb: i64,
    pub max_upload_rate_kbps: i64,
    pub retry_after_seconds: i64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ControlPlaneSettings {
    pub public_base_url: String,
    pub default_collector_id: String,
    pub default_collector_url: String,
    pub max_active_uploads: i64,
    pub lease_ttl_seconds: i64,
    pub max_batch_mb: f64,
    pub max_upload_rate_kbps: i64,
    pub send_after_ms: i64,
    pub default_collector_slot_ms: i64,
    pub collector_stale_ms: i64,
    pub allow_default_collector_fallback: bool,
}

impl Default for ControlPlaneSettings {
    fn default() -> Self {
        let public_base_url = std::env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| "https://hosteye.iahn.hanoi.vn".to_string());
        Self {
            public_base_url: public_base_url.clone(),
            default_collector_id: std::env::var("DEFAULT_COLLECTOR_ID").unwrap_or_else(|_| "collector-a".to_string()),
            default_collector_url: std::env::var("DEFAULT_COLLECTOR_URL").unwrap_or_else(|_| format!("{}/api/v1/telemetry", public_base_url)),
            max_active_uploads: std::env::var("ADMISSION_MAX_ACTIVE_UPLOADS").unwrap_or_else(|_| "64".to_string()).parse().unwrap_or(64),
            lease_ttl_seconds: std::env::var("ADMISSION_LEASE_TTL_SECONDS").unwrap_or_else(|_| "30".to_string()).parse().unwrap_or(30),
            max_batch_mb: std::env::var("ADMISSION_MAX_BATCH_MB").unwrap_or_else(|_| "5".to_string()).parse().unwrap_or(5.0),
            max_upload_rate_kbps: std::env::var("ADMISSION_MAX_UPLOAD_RATE_KBPS").unwrap_or_else(|_| "1024".to_string()).parse().unwrap_or(1024),
            send_after_ms: std::env::var("CONTROL_SEND_AFTER_MS").unwrap_or_else(|_| "0".to_string()).parse().unwrap_or(0),
            default_collector_slot_ms: std::env::var("CONTROL_COLLECTOR_SLOT_MS").unwrap_or_else(|_| "1000".to_string()).parse().unwrap_or(1000),
            collector_stale_ms: std::env::var("COLLECTOR_STALE_MS").unwrap_or_else(|_| "30000".to_string()).parse().unwrap_or(30000),
            allow_default_collector_fallback: std::env::var("ALLOW_DEFAULT_COLLECTOR_FALLBACK").unwrap_or_else(|_| "false".to_string()).to_lowercase() == "true",
        }
    }
}

pub struct SendSchedule {
    pub server_time: String,
    pub send_after: String,
    pub send_delay_ms: i64,
    pub reason: String,
    pub collector_ready_at: String,
    pub collector_reserved_until: String,
    pub collector_upload_slot_ms: i64,
}

pub struct ControlPlane {
    pub settings: ControlPlaneSettings,
    pub collectors: Arc<RwLock<HashMap<String, CollectorState>>>,
    pub scheduler_lock: Arc<Mutex<()>>,
}

impl ControlPlane {
    pub fn new() -> Self {
        Self {
            settings: ControlPlaneSettings::default(),
            collectors: Arc::new(RwLock::new(HashMap::new())),
            scheduler_lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn list_collectors(&self) -> Vec<CollectorState> {
        let collectors = self.collectors.read().await;
        collectors.values().cloned().collect()
    }

    pub async fn heartbeat(&self, payload: CollectorHeartbeatPayload, seen_at: DateTime<Utc>) -> CollectorState {
        let incoming = normalize_collector(&payload, seen_at);
        let mut collectors = self.collectors.write().await;
        
        let existing = collectors.get(&incoming.collector_id);
        let merged = merge_collector_heartbeat(existing, incoming);
        
        collectors.insert(merged.collector_id.clone(), merged.clone());
        merged
    }

    pub async fn bootstrap(&self, payload: BootstrapPayload, _if_none_match: Option<String>) -> Result<(u16, AdmissionResponse), String> {
        let decided_at = Utc::now();
        let next_chunk_size_mb = payload.next_chunk_size_mb.unwrap_or_else(|| {
            payload.queue_state.as_ref().and_then(|qs| qs.next_chunk_size_mb).unwrap_or(0.0)
        });

        let mut decision = "ok".to_string();
        let mut message = "upload lease granted".to_string();
        let mut retry_after_seconds = 0;
        let mut schedule;
        let mut final_collector: Option<CollectorState> = None;
        let lease_id = uuid::Uuid::new_v4().to_string(); // Mock lease
        let mut lease_expires_at = decided_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut lease_ttl_seconds = 0;

        if next_chunk_size_mb > self.settings.max_batch_mb {
            decision = "ng".to_string();
            message = "next chunk is larger than max allowed batch".to_string();
            retry_after_seconds = 60;
            schedule = build_send_schedule(&self.settings, decided_at, &decision, None);
        } else {
            let _lock = self.scheduler_lock.lock().await;
            
            let selected_collector = {
                let collectors = self.collectors.read().await;
                select_collector(&self.settings, &collectors, decided_at)
            };

            if let Some(mut col) = selected_collector {
                schedule = build_send_schedule(&self.settings, decided_at, "ok", Some(&col));
                
                // Reserve collector slot
                col.previous_next_available_at = Some(col.next_available_at.clone());
                col.previous_control_reserved_until = Some(col.control_reserved_until.clone());
                col.control_reserved_until = max_iso_date(&col.control_reserved_until, &schedule.collector_reserved_until);
                col.next_available_at = max_iso_date(&col.heartbeat_next_available_at, &col.control_reserved_until);
                col.ready = false;
                col.reserved_until = Some(schedule.collector_reserved_until.clone());

                lease_ttl_seconds = lease_ttl_for_schedule(&self.settings, decided_at, &schedule);
                lease_expires_at = (decided_at + chrono::Duration::seconds(lease_ttl_seconds)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

                // Save back to map
                {
                    let mut collectors = self.collectors.write().await;
                    collectors.insert(col.collector_id.clone(), col.clone());
                }

                final_collector = Some(col);
            } else {
                schedule = build_send_schedule(&self.settings, decided_at, "ng", None);
                decision = "ng".to_string();
                message = "no healthy collector available".to_string();
                retry_after_seconds = 15;
            }
        }

        // Mock Agent Config
        let agent_config = serde_json::json!({
            "version": "1.0",
            "global": {
                "data_dir": "C:\\ProgramData\\HostEye\\data"
            }
        });
        let config_etag = "\"mock-etag\"".to_string();
        let config_status = "changed".to_string();

        let response = AdmissionResponse {
            admission: decision.clone(),
            config_status,
            config_etag,
            agent_config,
            collector_id: final_collector.as_ref().map(|c| c.collector_id.clone()).unwrap_or_default(),
            collector_url: final_collector.as_ref().map(|c| c.url.clone()).unwrap_or_default(),
            routing: RoutingInfo {
                control_url: format!("{}/api/v1/control/bootstrap", self.settings.public_base_url),
                admission_url: format!("{}/api/v1/control/bootstrap", self.settings.public_base_url),
                telemetry_url: final_collector.as_ref().map(|c| c.url.clone()).unwrap_or_else(|| format!("{}/api/v1/telemetry", self.settings.public_base_url)),
                config_url: format!("{}/api/v1/agent/config", self.settings.public_base_url),
            },
            server_time: schedule.server_time,
            send_after: schedule.send_after.clone(),
            send_not_before: schedule.send_after,
            send_delay_ms: schedule.send_delay_ms,
            schedule_reason: schedule.reason,
            collector_ready_at: schedule.collector_ready_at,
            collector_reserved_until: schedule.collector_reserved_until,
            collector_upload_slot_ms: schedule.collector_upload_slot_ms,
            lease_id: if decision == "ok" { lease_id } else { "".to_string() },
            lease_ttl_seconds: if decision == "ok" { lease_ttl_seconds } else { 0 },
            lease_expires_at,
            max_batch_mb: self.settings.max_batch_mb as i64,
            max_upload_rate_kbps: self.settings.max_upload_rate_kbps,
            retry_after_seconds,
            message,
        };

        let status_code = if decision == "ok" { 200 } else { 429 };
        Ok((status_code, response))
    }
}

fn normalize_collector(payload: &CollectorHeartbeatPayload, seen_at: DateTime<Utc>) -> CollectorState {
    let active_uploads = payload.active_uploads.unwrap_or(0);
    let max_uploads = payload.max_uploads.unwrap_or(64);
    let write_latency_ms = payload.write_latency_ms.unwrap_or(0);
    let storage_lag = payload.storage_lag.unwrap_or(0);
    let upload_slot_ms = std::cmp::max(1, payload.upload_slot_ms.unwrap_or(1000));
    
    let next_available_ms = parse_date_ms(payload.next_available_at.as_deref(), seen_at.timestamp_millis());
    let next_available_ms = std::cmp::max(seen_at.timestamp_millis(), next_available_ms);
    let next_available_iso = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::milliseconds(next_available_ms - chrono::Utc::now().timestamp_millis()))
        .unwrap_or(seen_at)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let free_slots = std::cmp::max(0, max_uploads - active_uploads);
    let capacity_score = free_slots * 1000 - write_latency_ms - storage_lag * 10;

    let ready = payload.ready.unwrap_or_else(|| {
        active_uploads < max_uploads && next_available_ms <= seen_at.timestamp_millis()
    });

    CollectorState {
        collector_id: payload.collector_id.clone().unwrap_or_else(|| "collector-unknown".to_string()),
        url: payload.url.clone().unwrap_or_default(),
        health: payload.health.clone().unwrap_or_else(|| "healthy".to_string()),
        ready,
        active_uploads,
        max_uploads,
        upload_slot_ms,
        heartbeat_next_available_at: next_available_iso.clone(),
        control_reserved_until: "".to_string(),
        next_available_at: next_available_iso,
        write_latency_ms,
        storage_lag,
        storage_tag: payload.storage_tag.clone().unwrap_or_default(),
        capacity_score,
        last_seen: seen_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        reserved_until: None,
        previous_next_available_at: None,
        previous_control_reserved_until: None,
    }
}

fn merge_collector_heartbeat(existing: Option<&CollectorState>, incoming: CollectorState) -> CollectorState {
    if let Some(ext) = existing {
        let control_reserved_until = max_iso_date(&ext.control_reserved_until, ext.reserved_until.as_deref().unwrap_or(""));
        let effective_next_available_at = max_iso_date(&incoming.heartbeat_next_available_at, &control_reserved_until);
        
        let is_ready = incoming.ready && parse_date_ms(Some(&effective_next_available_at), Utc::now().timestamp_millis()) <= Utc::now().timestamp_millis();

        let mut result = incoming;
        result.control_reserved_until = control_reserved_until.clone();
        result.reserved_until = Some(control_reserved_until);
        result.next_available_at = effective_next_available_at;
        result.ready = is_ready;
        result
    } else {
        incoming
    }
}

fn build_send_schedule(settings: &ControlPlaneSettings, decided_at: DateTime<Utc>, decision: &str, collector: Option<&CollectorState>) -> SendSchedule {
    let configured_delay_ms = if decision == "ok" { std::cmp::max(0, settings.send_after_ms) } else { 0 };
    let base_send_after_ms = decided_at.timestamp_millis() + configured_delay_ms;
    
    let collector_ready_ms = if let Some(col) = collector {
        parse_date_ms(Some(&col.next_available_at), decided_at.timestamp_millis())
    } else {
        decided_at.timestamp_millis()
    };

    let send_after_ms = if decision == "ok" {
        std::cmp::max(base_send_after_ms, collector_ready_ms)
    } else {
        decided_at.timestamp_millis()
    };

    let slot_ms = std::cmp::max(1, collector.map(|c| c.upload_slot_ms).unwrap_or(settings.default_collector_slot_ms));
    let reserved_until_ms = send_after_ms + slot_ms;
    let total_delay_ms = std::cmp::max(0, send_after_ms - decided_at.timestamp_millis());

    let reason = schedule_reason(configured_delay_ms, collector_ready_ms, base_send_after_ms, decided_at.timestamp_millis(), decision);

    SendSchedule {
        server_time: decided_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        send_after: timestamp_to_iso(send_after_ms),
        send_delay_ms: total_delay_ms,
        reason: reason.to_string(),
        collector_ready_at: timestamp_to_iso(collector_ready_ms),
        collector_reserved_until: timestamp_to_iso(reserved_until_ms),
        collector_upload_slot_ms: slot_ms,
    }
}

fn select_collector(settings: &ControlPlaneSettings, collectors: &HashMap<String, CollectorState>, decided_at: DateTime<Utc>) -> Option<CollectorState> {
    let cutoff = decided_at.timestamp_millis() - settings.collector_stale_ms;
    
    let mut healthy: Vec<&CollectorState> = collectors.values()
        .filter(|c| c.health == "healthy" && parse_date_ms(Some(&c.last_seen), 0) >= cutoff)
        .collect();

    healthy.sort_by(|a, b| {
        let left_ready = parse_date_ms(Some(&a.next_available_at), decided_at.timestamp_millis());
        let right_ready = parse_date_ms(Some(&b.next_available_at), decided_at.timestamp_millis());
        
        if left_ready != right_ready {
            left_ready.cmp(&right_ready)
        } else {
            b.capacity_score.cmp(&a.capacity_score)
        }
    });

    if let Some(&first) = healthy.first() {
        return Some(first.clone());
    }

    if !settings.allow_default_collector_fallback {
        return None;
    }

    Some(CollectorState {
        collector_id: settings.default_collector_id.clone(),
        url: settings.default_collector_url.clone(),
        health: "healthy".to_string(),
        ready: true,
        active_uploads: 0,
        max_uploads: settings.max_active_uploads,
        upload_slot_ms: settings.default_collector_slot_ms,
        heartbeat_next_available_at: decided_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        control_reserved_until: "".to_string(),
        next_available_at: decided_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        write_latency_ms: 0,
        storage_lag: 0,
        storage_tag: "".to_string(),
        capacity_score: settings.max_active_uploads * 1000,
        last_seen: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        reserved_until: None,
        previous_next_available_at: None,
        previous_control_reserved_until: None,
    })
}

fn schedule_reason(configured_delay_ms: i64, collector_ready_ms: i64, base_send_after_ms: i64, decided_at_ms: i64, decision: &str) -> &'static str {
    if decision != "ok" { return "not_admitted"; }
    if collector_ready_ms > base_send_after_ms { return "collector_next_available_at"; }
    if configured_delay_ms > 0 { return "configured_control_delay"; }
    if base_send_after_ms > decided_at_ms { return "scheduled"; }
    "collector_ready_now"
}

fn lease_ttl_for_schedule(settings: &ControlPlaneSettings, decided_at: DateTime<Utc>, schedule: &SendSchedule) -> i64 {
    let send_after_ms = parse_date_ms(Some(&schedule.send_after), decided_at.timestamp_millis());
    let send_delay_seconds = ((std::cmp::max(0, send_after_ms - decided_at.timestamp_millis()) as f64) / 1000.0).ceil() as i64;
    let slot_seconds = ((std::cmp::max(0, schedule.collector_upload_slot_ms) as f64) / 1000.0).ceil() as i64;
    
    std::cmp::max(settings.lease_ttl_seconds, send_delay_seconds + slot_seconds + 5)
}

fn parse_date_ms(val: Option<&str>, fallback_ms: i64) -> i64 {
    match val {
        Some(s) if !s.is_empty() => {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
                dt.timestamp_millis()
            } else {
                fallback_ms
            }
        }
        _ => fallback_ms,
    }
}

fn max_iso_date(a: &str, b: &str) -> String {
    let a_ms = parse_date_ms(Some(a), 0);
    let b_ms = parse_date_ms(Some(b), 0);
    let max = std::cmp::max(a_ms, b_ms);
    if max > 0 {
        timestamp_to_iso(max)
    } else {
        "".to_string()
    }
}

fn timestamp_to_iso(ms: i64) -> String {
    let now = chrono::Utc::now();
    let diff = ms - now.timestamp_millis();
    now.checked_add_signed(chrono::Duration::milliseconds(diff))
        .unwrap_or(now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
