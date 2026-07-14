// transport/manager.rs
// Port từ: Services/TransportManager.cs

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
use flate2::{write::GzEncoder, Compression};
use reqwest::Client;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    sync::Mutex,
    time::Instant,
};

pub struct TransportManager<'a> {
    config:              &'a Mutex<ShipperConfig>,
    state:               &'a Mutex<ShipperState>,
    http:                &'a Client,
    logger:              &'a FileLogger,
    admission:           AdmissionClient<'a>,
    spool_quota:         &'a SpoolQuotaManager,
    jitter:              &'a JitterScheduler,
    endpoint_seed:       &'a str,
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
        Self { config, state, http, logger, admission, spool_quota, jitter, endpoint_seed }
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
            let lease = self.admission.try_request_admission(chunk_size_mb, &spool_stats, retry_attempt).await?;
            let lease_id = lease.lease_id.clone();

            let current_gateway = {
                self.config.lock().unwrap().gateway_uri.clone()
            };

            self.logger.info(&format!(
                "Sending spooled GZIP chunk file={} chunk_id={} size={} bytes (zero-copy, local_lease={}).",
                file_name, parsed_chunk_id, gz_bytes.len(), lease_id
            ));

            // Đẩy file lên Gateway (Zero-copy payload) - Không gửi lease_id lên Data Plane
            let resp = self.http
                .post(&current_gateway)
                .header("Content-Encoding", "gzip")
                .header("Content-Type", "application/json")
                .header("User-Agent", "HostEyeShipper/1.0")
                .body(Self::rate_limit_body(gz_bytes.clone(), lease.max_upload_rate_kbps))
                .send()
                .await?;

            let status = resp.status();

            if status == reqwest::StatusCode::CONFLICT {
                self.logger.error(&format!(
                    "Chunk Data Conflict (409) for {}. Deleting file from spool to prevent Infinite Loop and skipping retry.",
                    file_name
                ));
                if let Err(e) = fs::remove_file(file_path) {
                    self.logger.error(&format!("Failed to delete conflict chunk file {}: {}", file_name, e));
                }
                return Ok(true);
            }

            if status.as_u16() == 429 || status == reqwest::StatusCode::SERVICE_UNAVAILABLE {
                let retry_after = resp.headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<f64>().ok())
                    .map(|s| s.ceil() as u32);
                return Err(ShipperError::backpressure(status.as_u16(), retry_after));
            }

            if !status.is_success() {
                return Err(ShipperError::Gateway {
                    message: format!("Gateway returned {} {}", status.as_u16(), status.canonical_reason().unwrap_or("")),
                });
            }

            // Đọc và validate ACK từ gateway
            let body = resp.text().await?;
            let ack: crate::transport::ChunkAck = serde_json::from_str(&body).map_err(|e| ShipperError::AckValidation {
                message: format!("Gateway ACK was not valid JSON for chunk={}: {}", parsed_chunk_id, e),
            })?;

            // Bóc tách tên file để đối chiếu với ACK (không gỡ nén file, không dùng GzDecoder)
            let ack_checksum = ack.checksum.to_lowercase();
            let file_checksum = parsed_checksum.to_lowercase();

            let matches = ack.ack 
                && ack.chunk_id.eq_ignore_ascii_case(&parsed_chunk_id)
                && ack_checksum == file_checksum
                && ack.event_count == parsed_event_count;

            if !matches {
                self.logger.error(&format!(
                    "Gateway ACK validation failed for {}. Expected chunk_id={}, checksum={}, event_count={}. Got ack={}, chunk_id={}, checksum={}, event_count={}. Deleting file to prevent infinite loop.",
                    file_name, parsed_chunk_id, file_checksum, parsed_event_count,
                    ack.ack, ack.chunk_id, ack_checksum, ack.event_count
                ));
                if let Err(e) = fs::remove_file(file_path) {
                    self.logger.error(&format!("Failed to delete invalid chunk file {}: {}", file_name, e));
                }
                return Ok(true);
            }

            // Gửi thành công và đối chiếu thành công -> Xóa file .gz khỏi spool đĩa
            if let Err(e) = fs::remove_file(file_path) {
                self.logger.error(&format!("Failed to delete sent chunk file {}: {}", file_name, e));
            } else {
                self.logger.info(&format!(
                    "Sent OK chunk={} and deleted from spool. ack_status={} index_status={}.",
                    parsed_chunk_id, ack.status, ack.index_status
                ));
            }

            // Cập nhật checkpoint thành công
            {
                let mut st = self.state.lock().unwrap();
                st.last_success_time = Some(Utc::now());
                st.save().ok();
            }

            return Ok(true);
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


}
