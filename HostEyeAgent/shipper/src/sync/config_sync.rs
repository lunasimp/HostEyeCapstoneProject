// sync/config_sync.rs
// Port từ: Services/ConfigSynchronizer.cs

use crate::{
    config::{ShipperConfig, ShipperState},
    util::{
        crypto::{fixed_time_equals_hex, hmac_sha256_hex, sha256_hex},
        http::{
            derive_endpoint_uri, get_agent_id, get_endpoint_computer_name, get_host_id,
            get_json_i64, get_json_str, ms_to_seconds,
        },
        logger::FileLogger,
    },
};
use reqwest::Client;
use std::sync::Mutex;

pub struct ConfigSynchronizer<'a> {
    config: &'a Mutex<ShipperConfig>,
    http:   &'a Client,
    state:  &'a Mutex<ShipperState>,
    logger: &'a FileLogger,
}

impl<'a> ConfigSynchronizer<'a> {
    pub fn new(
        config: &'a Mutex<ShipperConfig>,
        http:   &'a Client,
        state:  &'a Mutex<ShipperState>,
        logger: &'a FileLogger,
    ) -> Self {
        Self { config, http, state, logger }
    }

    /// Đồng bộ agent config từ server — port từ TrySyncAgentConfigAsync()
    pub async fn try_sync_agent_config(&self) {
        let (enable, config_uri, gateway_uri, etag) = {
            let cfg = self.config.lock().unwrap();
            let st  = self.state.lock().unwrap();
            let enable = cfg.enable_config_sync;
            let uri = if cfg.config_uri.is_empty() {
                derive_endpoint_uri(&cfg.gateway_uri, "/api/v1/agent/config")
            } else {
                cfg.config_uri.clone()
            };
            let gateway = cfg.gateway_uri.clone();
            let etag = st.agent_config_etag.clone();
            (enable, uri, gateway, etag)
        };

        if !enable { return; }

        match self.do_sync(&config_uri, &etag).await {
            Ok(_) => {}
            Err(e) => self.logger.warn(&format!("Agent config sync skipped: {}", e)),
        }
    }

    async fn do_sync(&self, config_uri: &str, etag: &str) -> anyhow::Result<()> {
        let mut req = self.http.get(config_uri);
        req = self.add_agent_config_headers(req);
        if !etag.is_empty() {
            req = req.header("If-None-Match", etag);
        }

        let resp = req.send().await?;
        let status = resp.status();

        if status == reqwest::StatusCode::NOT_MODIFIED {
            self.logger.info(&format!("Agent config unchanged etag={}.", etag));
            return Ok(());
        }
        if !status.is_success() {
            self.logger.warn(&format!(
                "Agent config sync skipped: {} {}.",
                status.as_u16(),
                status.canonical_reason().unwrap_or("")
            ));
            return Ok(());
        }

        // Bắt ETag header trước khi consume body
        let new_etag = resp.headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let body_text = resp.text().await?;
        let root: serde_json::Value = serde_json::from_str(&body_text)?;

        let mut ack_status  = "applied".to_string();
        let mut ack_message = "legacy config applied".to_string();

        if let Some(signed_policy) = root.get("signed_policy") {
            // Verify chữ ký
            match self.verify_signed_policy(signed_policy) {
                Ok(()) => {
                    // Apply nested config first
                    if let Some(sc) = signed_policy.get("config") {
                        self.apply_server_config(sc);
                    }
                    self.apply_server_config(&root);

                    let mut st = self.state.lock().unwrap();
                    st.agent_config_policy_id      = get_json_str(signed_policy, "policy_id").to_string();
                    st.agent_config_policy_version = get_json_i64(signed_policy, "version") as i32;
                    st.agent_config_sha256         = get_json_str(signed_policy, "config_sha256").to_string();
                    st.agent_config_cached_json    = serde_json::to_string(signed_policy).unwrap_or_default();
                    ack_message = "signed policy verified and applied".to_string();
                }
                Err(msg) => {
                    self.logger.error(&format!("Agent config signature verification failed: {}", msg));
                    self.try_ack_agent_config(&root, "verify_failed", &msg).await;
                    return Ok(());
                }
            }
        } else {
            self.apply_server_config(&root);
            let mut st = self.state.lock().unwrap();
            st.agent_config_policy_id      = get_json_str(&root, "policy_id").to_string();
            st.agent_config_policy_version = get_json_i64(&root, "policy_version") as i32;
            st.agent_config_cached_json    = serde_json::to_string(&root).unwrap_or_default();
        }

        if let Some(tag) = new_etag {
            self.state.lock().unwrap().agent_config_etag = tag;
        }

        self.try_ack_agent_config(&root, &ack_status, &ack_message).await;

        let (max_events, max_bytes, normal_j, recovery_j, new_etag_st) = {
            let cfg = self.config.lock().unwrap();
            let st  = self.state.lock().unwrap();
            (cfg.max_events, cfg.max_bytes, cfg.normal_jitter_window_seconds,
             cfg.recovery_jitter_window_seconds, st.agent_config_etag.clone())
        };

        self.logger.info(&format!(
            "Agent config synced from {}; etag={}; MaxEvents={}; MaxBytes={}; NormalJitter={}s; RecoveryJitter={}s.",
            config_uri, new_etag_st, max_events, max_bytes, normal_j, recovery_j
        ));

        Ok(())
    }

    /// Apply fields từ server JSON vào runtime config.
    /// Port từ ApplyServerConfig()
    fn apply_server_config(&self, root: &serde_json::Value) {
        let mut cfg = self.config.lock().unwrap();

        if let Some(v) = root.get("max_events").and_then(|v| v.as_i64()).filter(|&v| v > 0) {
            cfg.max_events = v as i32;
        }
        if let Some(v) = root.get("max_bytes").and_then(|v| v.as_i64()).filter(|&v| v > 0) {
            cfg.max_bytes = v as i32;
        }
        if let Some(v) = root.get("normal_jitter_window_ms").and_then(|v| v.as_i64()) {
            cfg.normal_jitter_window_seconds = ms_to_seconds(v);
        }
        if let Some(v) = root.get("recovery_jitter_window_ms").and_then(|v| v.as_i64()) {
            cfg.recovery_jitter_window_seconds = ms_to_seconds(v);
        }

        if let Some(routing) = root.get("routing") {
            let telemetry = get_json_str(routing, "telemetry_url");
            let admission = get_json_str(routing, "admission_url");
            let config    = get_json_str(routing, "config_url");
            if reqwest::Url::parse(telemetry).is_ok() { cfg.gateway_uri   = telemetry.to_string(); }
            if reqwest::Url::parse(admission).is_ok() { cfg.admission_uri = admission.to_string(); }
            if reqwest::Url::parse(config).is_ok()    { cfg.config_uri    = config.to_string(); }
        }

        if let Some(limits) = root.get("limits") {
            if let Some(v) = limits.get("max_events").and_then(|v| v.as_i64()).filter(|&v| v > 0) {
                cfg.max_events = v as i32;
            }
            if let Some(v) = limits.get("max_bytes").and_then(|v| v.as_i64()).filter(|&v| v > 0) {
                cfg.max_bytes = v as i32;
            }
        }

        if let Some(jitter) = root.get("jitter") {
            if let Some(v) = jitter.get("normal_jitter_window_ms").and_then(|v| v.as_i64()) {
                cfg.normal_jitter_window_seconds = ms_to_seconds(v);
            }
            if let Some(v) = jitter.get("recovery_jitter_window_ms").and_then(|v| v.as_i64()) {
                cfg.recovery_jitter_window_seconds = ms_to_seconds(v);
            }
        }
    }

    /// Verify HMAC-SHA256 chữ ký của signed policy.
    /// Port từ VerifySignedPolicy()
    fn verify_signed_policy(&self, signed_policy: &serde_json::Value) -> Result<(), String> {
        let algorithm = get_json_str(signed_policy, "signature_algorithm");
        if !algorithm.eq_ignore_ascii_case("hmac-sha256") {
            return Err(format!("unsupported signature_algorithm={}", algorithm));
        }

        let policy_config = signed_policy.get("config")
            .ok_or_else(|| "signed policy missing config".to_string())?;

        let expected_hash = get_json_str(signed_policy, "config_sha256");
        let actual_hash   = sha256_hex(&serde_json::to_string(policy_config).unwrap_or_default());
        if !expected_hash.eq_ignore_ascii_case(&actual_hash) {
            return Err("config_sha256 mismatch".to_string());
        }

        let signing_key = self.config.lock().unwrap().agent_config_signing_key.clone();
        let sign_text   = self.signed_policy_text(signed_policy);
        let expected_sig = hmac_sha256_hex(&signing_key, &sign_text);
        let actual_sig   = get_json_str(signed_policy, "signature");

        if !fixed_time_equals_hex(&actual_sig, &expected_sig) {
            return Err("signature mismatch".to_string());
        }

        self.logger.info(&format!(
            "Verified signed policy id={} version={} key_id={}.",
            get_json_str(signed_policy, "policy_id"),
            get_json_i64(signed_policy, "version"),
            get_json_str(signed_policy, "key_id")
        ));
        Ok(())
    }

    fn signed_policy_text(&self, envelope: &serde_json::Value) -> String {
        [
            "HOSTEYE_DYNAMIC_CONFIG_V1",
            get_json_str(envelope, "signature_algorithm"),
            get_json_str(envelope, "key_id"),
            get_json_str(envelope, "policy_id"),
            &get_json_i64(envelope, "version").to_string(),
            get_json_str(envelope, "issued_at"),
            get_json_str(envelope, "expires_at"),
            get_json_str(envelope, "agent_id"),
            get_json_str(envelope, "host_id"),
            get_json_str(envelope, "group_id"),
            get_json_str(envelope, "config_sha256"),
        ]
        .join("\n")
    }

    /// Gửi ACK về server sau khi apply config.
    /// Port từ TryAckAgentConfigAsync()
    async fn try_ack_agent_config(&self, root: &serde_json::Value, status: &str, message: &str) {
        let result = (|| async {
            let (config_uri, gateway_uri, group_id) = {
                let cfg = self.config.lock().unwrap();
                (cfg.config_uri.clone(), cfg.gateway_uri.clone(), cfg.group_id.clone())
            };

            let base = if config_uri.is_empty() { &gateway_uri } else { &config_uri };
            let ack_uri = derive_endpoint_uri(base, "/api/v1/agent/config/ack");

            let policy = root.get("signed_policy").unwrap_or(root);

            let version = if get_json_i64(policy, "version") == 0 {
                get_json_i64(root, "policy_version")
            } else {
                get_json_i64(policy, "version")
            };

            let payload = serde_json::json!({
                "agent_id":       get_agent_id(),
                "host_id":        get_host_id(),
                "computer":       get_endpoint_computer_name(),
                "source_platform":"hosteye_windows_endpoint",
                "policy_id":      get_json_str(policy, "policy_id"),
                "version":        version,
                "status":         status,
                "message":        message,
                "applied_at":     chrono::Utc::now().to_rfc3339(),
            });

            let mut req = self.http.post(&ack_uri).json(&payload);
            req = self.add_agent_config_headers(req);
            let resp = req.send().await?;
            if !resp.status().is_success() {
                self.logger.warn(&format!(
                    "Agent config ACK returned {} {}.",
                    resp.status().as_u16(),
                    resp.status().canonical_reason().unwrap_or("")
                ));
            }
            Ok::<(), anyhow::Error>(())
        })().await;

        if let Err(e) = result {
            self.logger.warn(&format!("Agent config ACK skipped: {}", e));
        }
    }

    fn add_agent_config_headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let group_id = self.config.lock().unwrap().group_id.clone();
        req.header("x-hosteye-agent-id", get_agent_id())
           .header("x-hosteye-host-id",  get_host_id())
           .header("x-hosteye-group-id",  group_id)
    }
}
