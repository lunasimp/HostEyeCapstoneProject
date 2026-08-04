use crate::{
    config::{ShipperConfig, ShipperState},
    spool::{SpoolQuotaManager, SpoolStats},
    transport::{
        admission::AdmissionClient, ChunkAck, UploadLease,
    },
    util::{
        crypto::sha256_hex,
        error::ShipperError,
        http::{get_agent_id, get_endpoint_computer_name, get_host_id},
        jitter::JitterScheduler,
        logger::FileLogger,
    },
};
use chrono::Utc;
use flate2::{
    read::GzDecoder,
    write::GzEncoder,
    Compression,
};
use reqwest::Client;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

// transport/manager.rs
// Port từ: Services/TransportManager.cs

// ── Struct theo dõi lỗi chunk trong RAM ──────────────────────────────────

/// Một bản ghi lỗi chunk chưa được gửi lên Backend.
struct PendingErrorReport {
    chunk_id:       String,
    error_type:     String,  // "checksum_invalid" | "event_count_mismatch" | ...
    quarantined_at: String,  // ISO 8601
    /// Đường dẫn đến file spool cần xóa sau khi Backend xác nhận
    spool_path:     PathBuf,
}

pub struct TransportManager<'a> {
    config:              &'a Mutex<ShipperConfig>,
    state:               &'a Mutex<ShipperState>,
    http:                &'a Client,
    logger:              &'a FileLogger,
    admission:           AdmissionClient<'a>,
    spool_quota:         &'a SpoolQuotaManager,
    jitter:              &'a JitterScheduler,
    endpoint_seed:       &'a str,
    /// Danh sách lỗi chunk đang chờ gửi lên Control Plane (flush khi đủ 5).
    pending_errors:      Mutex<Vec<PendingErrorReport>>,
    /// URL Control Plane để gửi báo cáo lỗi chunk.
    control_plane_url:   String,
}

impl<'a> TransportManager<'a> {
    pub fn new(
        config:        &'a Mutex<ShipperConfig>,
        state:         &'a Mutex<ShipperState>,
        http:          &'a Client,
        logger:        &'a FileLogger,
        spool_quota:   &'a SpoolQuotaManager,
        jitter:        &'a JitterScheduler,
        endpoint_seed: &'a str,
    ) -> Self {
        let admission = AdmissionClient::new(config, http, logger, state);
        let control_plane_url = std::env::var("CONTROL_PLANE_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        Self {
            config, state, http, logger, admission, spool_quota, jitter, endpoint_seed,
            pending_errors: Mutex::new(Vec::new()),
            control_plane_url,
        }
    }

    /// Xử lý một vòng spool — trả về true nếu có dữ liệu đã gửi.
    /// Port từ ProcessSpoolOnceAsync()
    /// Xử lý một vòng spool — gửi trực tiếp các file chunk .gz từ Durable Spool.
    /// Xử lý một vòng spool — gửi trực tiếp các file chunk .gz từ Durable Spool (Zero-copy).
    pub async fn process_spool_once(&self, retry_attempt: u32) -> Result<bool, ShipperError> {
        let (spool_dir, normal_jitter, recovery_jitter) = {
            let cfg = self.config.lock().unwrap();
            (
                cfg.spool_directory.clone(),
                cfg.normal_jitter_window_seconds,
                cfg.recovery_jitter_window_seconds,
            )
        };

        let spool_stats = self.spool_quota.get_spool_stats(&spool_dir);

        // Thu thập danh sách file chunk_*.gz, sort theo thời gian tạo rồi tên
        let mut files: Vec<_> = fs::read_dir(&spool_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                let p = e.path();
                p.is_file()
                    && p.file_name()
                        .and_then(|x| x.to_str())
                        .map(|x| x.starts_with("chunk_") && x.ends_with(".gz"))
                        .unwrap_or(false)
            })
            .map(|e| e.path())
            .collect();

        files.sort_by(|a, b| {
            let ta = fs::metadata(a).and_then(|m| m.created()).ok();
            let tb = fs::metadata(b).and_then(|m| m.created()).ok();
            ta.cmp(&tb).then(a.file_name().cmp(&b.file_name()))
        });

        for file_path in &files {
            let file_str = file_path.to_string_lossy().to_string();
            let file_name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            // Bóc tách tên file để lấy ra 3 thông số: chunk_id, checksum, event_count
            // Định dạng: chunk_{chunk_id}_{checksum}_{event_count}.gz
            let file_name_without_ext = file_name.strip_suffix(".gz").unwrap_or(file_name);
            let parts: Vec<&str> = file_name_without_ext.split('_').collect();
            if parts.len() < 4 || parts[0] != "chunk" {
                self.logger.warn(&format!("Skipping invalid spool filename format: {}", file_name));
                continue;
            }
            let parsed_chunk_id = parts[1].to_string();
            let parsed_checksum = parts[2].to_string();
            let parsed_event_count = match parts[3].parse::<usize>() {
                Ok(c) => c,
                Err(_) => {
                    self.logger.warn(&format!("Skipping spool file with invalid event count: {}", file_name));
                    continue;
                }
            };

            // Đọc trực tiếp byte nén GZIP lên RAM (Zero-copy)
            let gz_bytes = match fs::read(file_path) {
                Ok(bytes) => bytes,
                Err(e) => {
                    self.logger.warn(&format!("Failed to read spool chunk {}: {}", file_name, e));
                    continue;
                }
            };

            if gz_bytes.is_empty() {
                let _ = fs::remove_file(file_path);
                continue;
            }

            // Periodic Jitter trước khi xin Lease mới
            let lease_jitter = self.jitter.get_periodic_jitter(0, 10);
            if !lease_jitter.is_zero() {
                self.logger.info(&format!(
                    "Applying periodic jitter delay of {:.0}s before requesting Upload Lease.",
                    lease_jitter.as_secs_f64()
                ));
                tokio::time::sleep(lease_jitter).await;
            }

            // Gọi Control Plane xin cấp Upload Lease
            let file_len = gz_bytes.len() as f64;
            let chunk_size_mb = file_len / 1_048_576.0;
            let current_lease = self.admission.try_request_admission(chunk_size_mb, &spool_stats, retry_attempt).await?;
            let lease_id = current_lease.lease_id.clone();
            
            let current_gateway = {
                self.config.lock().unwrap().gateway_uri.clone()
            };

            self.logger.info(&format!(
                "Sending spooled GZIP chunk file={} chunk_id={} size={} bytes (zero-copy, local_lease={}).",
                file_name, parsed_chunk_id, gz_bytes.len(), lease_id
            ));

            let mut inner_attempt = retry_attempt;
            
            loop {
                // Đẩy file lên Gateway (Zero-copy payload) - Không gửi lease_id lên Data Plane
                let resp = self.http
                    .post(&current_gateway)
                    .header("Content-Encoding", "gzip")
                    .header("Content-Type", "application/json")
                    .header("User-Agent", "HostEyeShipper/1.0")
                    .body(Self::rate_limit_body(gz_bytes.clone(), current_lease.max_upload_rate_kbps))
                    .send()
                    .await?;

                let status = resp.status();

                // ── Xử lý HTTP response theo chuẩn bảng mã ──────────────────────────

                // 200 ─ Gửi thành công → xóa file khỏi spool ngay
                if status == reqwest::StatusCode::OK {
                    if let Err(e) = fs::remove_file(file_path) {
                        self.logger.error(&format!("Failed to delete sent chunk {}: {}", file_name, e));
                    } else {
                        self.logger.info(&format!("Sent OK chunk={} deleted from spool.", parsed_chunk_id));
                    }
                    // Cập nhật checkpoint
                    {
                        let mut st = self.state.lock().unwrap();
                        st.last_success_time = Some(Utc::now());
                        st.sent_event_count = st.sent_event_count.saturating_add(parsed_event_count as u64);
                        st.save().ok();
                    }
                    return Ok(true);
                }

                // 400 Bad Request hoặc 409 Conflict → Gom lỗi, flush nếu đủ 5
                if status == reqwest::StatusCode::BAD_REQUEST
                    || status == reqwest::StatusCode::CONFLICT
                {
                    // Đọc body để lấy loại lỗi cụ thể
                    let body_text = resp.text().await.unwrap_or_default();
                    let error_type = serde_json::from_str::<Value>(&body_text)
                        .ok()
                        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(str::to_string))
                        .unwrap_or_else(|| {
                            if status == reqwest::StatusCode::CONFLICT {
                                "conflict_409".to_string()
                            } else {
                                "unknown_400".to_string()
                            }
                        });

                    self.logger.error(&format!(
                        "[ERROR] Server rejected chunk={} reason='{}'. Will report to Control Plane.",
                        parsed_chunk_id, error_type
                    ));

                    let record = PendingErrorReport {
                        chunk_id:       parsed_chunk_id.clone(),
                        error_type,
                        quarantined_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        spool_path:     file_path.clone(),
                    };

                    let should_flush = {
                        let mut pending = self.pending_errors.lock().unwrap();
                        pending.push(record);
                        pending.len() >= 5
                    };

                    if should_flush {
                        self.flush_errors().await;
                    }

                    // Tiếp tục file tiếp theo không abort
                    return Ok(true);
                }

                // 413 Payload Too Large → Cắt đôi file
                if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
                    self.logger.warn(&format!(
                        "Chunk {} too large (413). Splitting into 2 smaller chunks.",
                        file_name
                    ));
                    match self.split_chunk_file(file_path, &spool_dir) {
                        Ok(_) => self.logger.info("Split OK, original file deleted."),
                        Err(e) => self.logger.error(&format!("Split failed: {}", e)),
                    }
                    return Ok(true);
                }

                // 403 Forbidden → Log cảnh báo, giữ file, backoff
                if status == reqwest::StatusCode::FORBIDDEN {
                    self.logger.error(&format!(
                        "mTLS cert rejected (403) for chunk={}. Contact Control Plane to re-register.",
                        parsed_chunk_id
                    ));
                    return Err(ShipperError::Gateway {
                        message: "403 Forbidden: mTLS cert invalid".to_string(),
                    });
                }

                // 429 / 503 Backpressure → retry THEO LEASE, hết TTL mới return
                if status.as_u16() == 429 || status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                    let retry_after = resp.headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<f64>().ok())
                        .map(|s| s.ceil() as u32);
                        
                    let retry_secs = retry_after.unwrap_or(0);
                    let delay = if retry_secs > 0 {
                        let extra = self.jitter.random_u64(0, 30);
                        std::time::Duration::from_secs(retry_secs as u64 + extra)
                    } else {
                        self.jitter.get_recovery_jitter(recovery_jitter, inner_attempt)
                    };

                    let now = Utc::now();
                    let chrono_delay = chrono::Duration::from_std(delay).unwrap_or(chrono::Duration::seconds(0));
                    
                    if now + chrono_delay < current_lease.expires_at_utc {
                        self.logger.warn(&format!(
                            "Backpressure ({}). Retrying chunk={} in {:.0}s using current lease (expires in {}s).",
                            status.as_u16(), parsed_chunk_id, delay.as_secs_f64(), (current_lease.expires_at_utc - now).num_seconds()
                        ));
                        tokio::time::sleep(delay).await;
                        inner_attempt += 1;
                        continue;
                    } else {
                        self.logger.warn(&format!(
                            "Backpressure ({}). Lease expired or expiring soon. Returning to request new admission.",
                            status.as_u16()
                        ));
                        return Err(ShipperError::backpressure(status.as_u16(), retry_after));
                    }
                }

                // 500 / mọi lỗi khác → giữ file, retry sau
                return Err(ShipperError::Gateway {
                    message: format!("Gateway returned {} {}",
                        status.as_u16(), status.canonical_reason().unwrap_or("")),
                });
            }
        }

        Ok(false)
    }

    fn rate_limit_body(data: Vec<u8>, rate_kbps: i32) -> reqwest::Body {
        if rate_kbps <= 0 {
            return reqwest::Body::from(data);
        }

        let chunk_size = 1024 * 64; // 64KB per chunk
        let rate_bytes_per_sec = (rate_kbps as f64) * 1024.0;
        let sleep_duration_secs = (chunk_size as f64) / rate_bytes_per_sec;
        let sleep_duration = std::time::Duration::from_secs_f64(sleep_duration_secs);

        let stream = async_stream::stream! {
            for chunk in data.chunks(chunk_size) {
                let start = tokio::time::Instant::now();
                yield Ok::<bytes::Bytes, std::io::Error>(bytes::Bytes::copy_from_slice(chunk));
                let elapsed = start.elapsed();
                if elapsed < sleep_duration {
                    tokio::time::sleep(sleep_duration - elapsed).await;
                }
            }
        };

        reqwest::Body::wrap_stream(stream)
    }

    // ── flush_errors: gửi batch lỗi lên Control Plane ────────────────────────

    /// Flush toàn bộ pending_errors lên Control Plane.
    /// - 200 OK  → xóa các file spool tương ứng, clear Vec.
    /// - 429     → áp dụng Full-jitter Exponential Backoff và retry.
    /// - 500/err → giữ nguyên Vec, không retry ngay (chờ batch kế tiếp).
    async fn flush_errors(&self) {
        self.flush_errors_with_attempt(0).await;
    }

    async fn flush_errors_with_attempt(&self, mut attempt: u32) {
        loop {
        if self.control_plane_url.is_empty() {
            return; // Control Plane chưa cấu hình, bỏ qua
        }

        let (agent_id, items, paths) = {
            let pending = self.pending_errors.lock().unwrap();
            if pending.is_empty() {
                return;
            }
            let agent_id = std::env::var("AGENT_ID").unwrap_or_else(|_| "unknown".to_string());
            let items: Vec<serde_json::Value> = pending.iter().map(|r| serde_json::json!({
                "chunk_id":       r.chunk_id,
                "error_type":     r.error_type,
                "quarantined_at": r.quarantined_at,
            })).collect();
            let paths: Vec<PathBuf> = pending.iter().map(|r| r.spool_path.clone()).collect();
            (agent_id, items, paths)
        };

        let body = serde_json::json!({ "agent_id": agent_id, "errors": items });
        let url = format!("{}/api/v1/agent/telemetry/errors", self.control_plane_url);

        let result = self.http.post(&url).json(&body).send().await;

        match result {
            Ok(resp) if resp.status() == reqwest::StatusCode::OK => {
                // Xóa file spool tương ứng
                for path in &paths {
                    if let Err(e) = fs::remove_file(path) {
                        self.logger.warn(&format!("flush_errors: failed to delete {}: {}", path.display(), e));
                    }
                }
                // Clear Vec
                let mut pending = self.pending_errors.lock().unwrap();
                pending.clear();
                self.logger.info(&format!("flush_errors: reported {} errors to Control Plane.", paths.len()));
            }
            Ok(resp) if resp.status().as_u16() == 429 => {
                // Full-jitter Exponential Backoff tái dụng JitterScheduler có sẵn
                let delay = self.jitter.get_retry_jitter(30, 300, attempt);
                self.logger.warn(&format!(
                    "flush_errors: Control Plane 429, attempt={}, backoff={:.1}s",
                    attempt, delay.as_secs_f64()
                ));
                tokio::time::sleep(delay).await;
                attempt += 1;
                continue;
            }
            Ok(resp) => {
                self.logger.warn(&format!(
                    "flush_errors: Control Plane returned {}, will retry next batch.",
                    resp.status()
                ));
            }
            Err(e) => {
                self.logger.warn(&format!("flush_errors: network error: {}, will retry next batch.", e));
            }
        }
        return;
        }
    }

    // ── split_chunk_file: cắt đôi chunk quá 25MB ─────────────────────────────

    /// Giải nén file .gz, cắt mảng events[] làm đôi, tạo 2 file .gz mới,
    /// rồi xóa file gốc. 2 file mới sẽ được gửi lại trong vòng lặp spool kế tiếp.
    fn split_chunk_file(&self, file_path: &Path, spool_dir: &str) -> Result<(), ShipperError> {
        // 1. Đọc và giải nén
        let gz_bytes = fs::read(file_path)?;
        let mut decoder = GzDecoder::new(gz_bytes.as_slice());
        let mut json_str = String::new();
        decoder.read_to_string(&mut json_str).map_err(|e| ShipperError::Io(e))?;

        // 2. Parse JSON để lấy mảng events và metadata
        let payload: Value = serde_json::from_str(&json_str)?;
        let events = match payload.get("events").and_then(|e| e.as_array()) {
            Some(arr) if arr.len() >= 2 => arr.clone(),
            _ => {
                self.logger.warn("split_chunk_file: chunk has < 2 events, cannot split. Deleting.");
                fs::remove_file(file_path)?;
                return Ok(());
            }
        };

        let mid = events.len() / 2;
        let halves: [&[Value]; 2] = [&events[..mid], &events[mid..]];

        for (half_index, half_events) in halves.iter().enumerate() {
            let new_chunk_id = sha256_hex(&format!(
                "{}|{}|{}",
                payload.get("chunk_id").and_then(|value| value.as_str()).unwrap_or("split"),
                half_index,
                Utc::now().timestamp_nanos_opt().unwrap_or(0),
            ));
            let events_json = serde_json::to_string(&serde_json::Value::Array(half_events.to_vec()))?;
            let checksum = sha256_hex(&events_json);
            let event_count = half_events.len();

            // Tạo payload mới
            let mut new_payload = payload.clone();
            if let Some(obj) = new_payload.as_object_mut() {
                obj.insert("chunk_id".to_string(), serde_json::json!(new_chunk_id));
                obj.insert("events".to_string(), serde_json::Value::Array(half_events.to_vec()));
                obj.insert("event_count".to_string(), serde_json::json!(event_count));
                obj.insert("checksum".to_string(), serde_json::json!(checksum));
            }

            // Nén lại thành .gz
            let new_json = serde_json::to_string(&new_payload)?;
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(new_json.as_bytes()).map_err(|e| ShipperError::Io(e))?;
            let gz_data = encoder.finish().map_err(|e| ShipperError::Io(e))?;

            // Ghi file mới vào spool
            let new_filename = format!("chunk_{}_{}_{}.gz", new_chunk_id, checksum, event_count);
            let new_path = Path::new(spool_dir).join(&new_filename);
            fs::write(&new_path, &gz_data)?;
            self.logger.info(&format!("split_chunk_file: created {} ({} events)", new_filename, event_count));
        }

        // Xóa file gốc
        fs::remove_file(file_path)?;
        Ok(())
    }

}
