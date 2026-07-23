// transport/admission.rs
// Port từ: Services/AdmissionClient.cs

use crate::{
    config::{ShipperConfig, ShipperState},
    spool::SpoolStats,
    transport::{UploadLease},
    util::{
        error::ShipperError,
        http::{derive_endpoint_uri, get_agent_id, get_endpoint_computer_name, get_host_id,
               get_json_datetime, get_json_f64, get_json_i64, get_json_str},
        logger::FileLogger,
    },
};
use chrono::Utc;
use reqwest::{Client, StatusCode};
use std::collections::HashMap;
use std::sync::Mutex;

pub struct AdmissionClient<'a> {
    config: &'a Mutex<ShipperConfig>,
    http:   &'a Client,
    logger: &'a FileLogger,
    state:  &'a Mutex<ShipperState>,
}

impl<'a> AdmissionClient<'a> {
    pub fn new(
        config: &'a Mutex<ShipperConfig>,
        http:   &'a Client,
        logger: &'a FileLogger,
        state:  &'a Mutex<ShipperState>,
    ) -> Self {
        Self { config, http, logger, state }
    }

    /// Gửi admission request và trả về UploadLease.
    /// Port từ TryRequestAdmissionAsync()
    pub async fn try_request_admission(
        &self,
        next_chunk_size_mb: f64,
        spool_stats: &SpoolStats,
        retry_attempt: u32,
    ) -> Result<UploadLease, ShipperError> {
        let (enable, admission_uri, gateway_uri, require_lease, last_success) = {
            let cfg = self.config.lock().unwrap();
            let state = self.state.lock().unwrap();
            let enable = cfg.enable_admission_control;
            let uri = if cfg.admission_uri.is_empty() {
                derive_endpoint_uri(&cfg.gateway_uri, "/api/v1/admission/request")
            } else {
                cfg.admission_uri.clone()
            };
            let gateway = cfg.gateway_uri.clone();
            let require = cfg.require_upload_lease;
            let last = state.last_success_time.map(|t| t.to_rfc3339());
            (enable, uri, gateway, require, last)
        };

        if !enable {
            return Ok(UploadLease::disabled());
        }

        let mut body: HashMap<&str, serde_json::Value> = HashMap::new();
        body.insert("agent_id",          serde_json::json!(get_agent_id()));
        body.insert("host_id",           serde_json::json!(get_host_id()));
        body.insert("computer",          serde_json::json!(get_endpoint_computer_name()));
        body.insert("queue_used_mb",     serde_json::json!((spool_stats.bytes as f64 / 1_048_576.0 * 1000.0).round() / 1000.0));
        body.insert("next_chunk_size_mb",serde_json::json!((next_chunk_size_mb * 1000.0).round() / 1000.0));
        body.insert("retry_count",       serde_json::json!(retry_attempt));
        body.insert("rank",              serde_json::json!(retry_attempt));
        body.insert("last_success_time", serde_json::json!(last_success));

        match self.http.post(&admission_uri).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status();

                if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
                    if require_lease {
                        return Err(ShipperError::backpressure(503, 30u32));
                    }
                    self.logger.warn(&format!("Admission endpoint unavailable at {}; continuing without enforced lease.", admission_uri));
                    return Ok(UploadLease::disabled());
                }

                if status.as_u16() == 429 || status == StatusCode::SERVICE_UNAVAILABLE {
                    let retry = self.parse_retry_after(&resp);
                    return Err(ShipperError::backpressure(status.as_u16(), retry));
                }

                if !status.is_success() {
                    let body_text = resp.text().await.unwrap_or_default();
                    if require_lease {
                        return Err(ShipperError::Gateway {
                            message: format!("Admission request failed: {} body={}", status, body_text),
                        });
                    }
                    self.logger.warn(&format!("Admission request returned {}; continuing without enforced lease. Body={}", status, body_text));
                    return Ok(UploadLease::disabled());
                }

                let body_text = resp.text().await?;
                let json: serde_json::Value = serde_json::from_str(&body_text)?;

                // Check admission=ng
                if json.get("admission").and_then(|v| v.as_str()).map(|s| s.eq_ignore_ascii_case("ng")).unwrap_or(false) {
                    let retry = json.get("retry_after_seconds").and_then(|v| v.as_u64()).unwrap_or(15) as u32;
                    return Err(ShipperError::backpressure(429, retry));
                }

                let issued_at = Utc::now();
                let ttl_secs  = get_json_i64(&json, "lease_ttl_seconds") as i32;
                let expires_at = get_json_datetime(&json, "lease_expires_at")
                    .unwrap_or_else(|| issued_at + chrono::Duration::seconds(ttl_secs.max(1) as i64));

                let lease = UploadLease {
                    lease_id:             get_json_str(&json, "lease_id").to_string(),
                    issued_at_utc:        issued_at,
                    expires_at_utc:       expires_at,
                    lease_ttl_seconds:    ttl_secs,
                    max_batch_mb:         get_json_f64(&json, "max_batch_mb"),
                    max_upload_rate_kbps: get_json_i64(&json, "max_upload_rate_kbps") as i32,
                    required:             require_lease,
                };

                // Dynamic routing update
                let collector_url = get_json_str(&json, "collector_url").to_string();
                let telemetry_url = json.get("routing")
                    .and_then(|r| r.get("telemetry_url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let final_url = if !collector_url.is_empty() { collector_url }
                               else { telemetry_url };

                if reqwest::Url::parse(&final_url).is_ok() {
                    let mut cfg = self.config.lock().unwrap();
                    cfg.gateway_uri = final_url;
                }

                if require_lease && lease.lease_id.is_empty() {
                    return Err(ShipperError::Gateway {
                        message: "Admission response did not include lease_id.".into(),
                    });
                }

                self.ensure_upload_lease_usable(&lease)?;

                // Handle send_after delay
                if let Some(send_after) = get_json_datetime(&json, "send_after") {
                    let now = Utc::now();
                    if send_after > now {
                        let delay = (send_after - now).to_std().unwrap_or_default();
                        self.logger.info(&format!(
                            "Admission send_after={}; delaying {:.0}s before upload.",
                            send_after.to_rfc3339(),
                            delay.as_secs_f64()
                        ));
                        tokio::time::sleep(delay).await;
                        self.ensure_upload_lease_usable(&lease)?;
                    }
                }

                self.logger.info(&format!(
                    "Admission OK lease={} collector_url={} ttl={}s max_batch_mb={:.3} max_upload_rate_kbps={}.",
                    lease.lease_id, gateway_uri, lease.lease_ttl_seconds,
                    lease.max_batch_mb, lease.max_upload_rate_kbps
                ));

                Ok(lease)
            }
            Err(e) => {
                if require_lease {
                    return Err(ShipperError::Http(e));
                }
                self.logger.warn(&format!("Admission request skipped: {}", e));
                Ok(UploadLease::disabled())
            }
        }
    }

    /// Validate lease còn hợp lệ — throw nếu hết hạn.
    pub fn ensure_upload_lease_usable(&self, lease: &UploadLease) -> Result<(), ShipperError> {
        if !lease.required { return Ok(()); }
        if lease.lease_id.is_empty() {
            return Err(ShipperError::LeaseInvalid {
                message: "Upload lease is required but lease_id is empty.".into(),
            });
        }
        if lease.expires_at_utc <= Utc::now() {
            return Err(ShipperError::backpressure(429, 5u32));
        }
        Ok(())
    }

    fn parse_retry_after(&self, resp: &reqwest::Response) -> Option<u32> {
        resp.headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<f64>().ok())
            .map(|s| s.ceil() as u32)
    }
}
