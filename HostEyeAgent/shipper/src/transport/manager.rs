// transport/manager.rs
// Port từ: Services/TransportManager.cs

use crate::{
    config::{ShipperConfig, ShipperState},
    spool::{SpoolQuotaManager, SpoolStats},
    transport::{
        admission::AdmissionClient, Batch, ChunkAck, ChunkMetadata, SendTiming, UploadLease,
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

    fn gzip_decompress(data: &[u8]) -> Result<Vec<u8>, ShipperError> {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut decoder = GzDecoder::new(data);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).map_err(ShipperError::Io)?;
        Ok(decompressed)
    }

    // ── Build chunk payload ──────────────────────────────────────────────────

    fn build_chunk_payload(&self, spool_file: &str, batch: &Batch, lease: &UploadLease) -> (String, ChunkMetadata) {
        let events_json = format!("[{}]", batch.lines.join(","));
        // Canonical re-serialize
        let parsed: serde_json::Value = serde_json::from_str(&events_json).unwrap_or(serde_json::json!([]));
        let canonical = serde_json::to_string(&parsed).unwrap_or(events_json.clone());
        let checksum = sha256_hex(&canonical);

        let agent_id = get_agent_id();
        let host_id  = get_host_id();
        let computer = get_endpoint_computer_name();
        let spool_filename = Path::new(spool_file)
            .file_name().and_then(|n| n.to_str()).unwrap_or(spool_file).to_string();

        let sequence_number = batch.start_line_offset.max(0);
        let chunk_id = sha256_hex(&format!(
            "{}|{}|{}|{}|{}|{}|{}",
            agent_id, host_id, computer, spool_filename,
            batch.start_byte_offset, batch.next_byte_offset, checksum
        ));

        let (normal_jitter, recovery_jitter, max_events_cfg, max_bytes_cfg) = {
            let cfg = self.config.lock().unwrap();
            (cfg.normal_jitter_window_seconds, cfg.recovery_jitter_window_seconds,
             cfg.max_events, cfg.max_bytes)
        };

        let chunk = ChunkMetadata {
            chunk_id:          chunk_id.clone(),
            agent_id:          agent_id.clone(),
            host_id:           host_id.clone(),
            computer:          computer.clone(),
            spool_file:        spool_filename.clone(),
            line_offset:       batch.start_line_offset,
            next_line_offset:  batch.next_line_offset,
            byte_offset:       batch.start_byte_offset,
            next_byte_offset:  batch.next_byte_offset,
            sequence_number,
            event_count:       batch.lines.len(),
            checksum:          checksum.clone(),
            lease_id:          lease.lease_id.clone(),
            lease_issued_at:   lease.issued_at_utc,
            lease_expires_at:  lease.expires_at_utc,
            lease_ttl_seconds: lease.lease_ttl_seconds,
            max_batch_mb:      lease.max_batch_mb,
            max_upload_rate_kbps: lease.max_upload_rate_kbps,
        };

        let mut obj = serde_json::Map::new();
        obj.insert("protocol".into(),              serde_json::json!("hosteye.telemetry.v1"));
        obj.insert("schema_version".into(),        serde_json::json!("1.0.0"));
        obj.insert("chunk_id".into(),              serde_json::json!(&chunk.chunk_id));
        obj.insert("agent_id".into(),              serde_json::json!(&chunk.agent_id));
        obj.insert("host_id".into(),               serde_json::json!(&chunk.host_id));
        obj.insert("computer".into(),              serde_json::json!(&chunk.computer));
        obj.insert("source_platform".into(),       serde_json::json!("hosteye_windows_endpoint"));
        obj.insert("shipper_version".into(),       serde_json::json!(env!("CARGO_PKG_VERSION")));
        obj.insert("spool_file".into(),            serde_json::json!(&chunk.spool_file));
        obj.insert("line_offset".into(),           serde_json::json!(chunk.line_offset));
        obj.insert("next_line_offset".into(),      serde_json::json!(chunk.next_line_offset));
        obj.insert("byte_offset".into(),           serde_json::json!(chunk.byte_offset));
        obj.insert("next_byte_offset".into(),      serde_json::json!(chunk.next_byte_offset));
        obj.insert("sequence_number".into(),       serde_json::json!(chunk.sequence_number));
        obj.insert("event_count".into(),           serde_json::json!(chunk.event_count));
        obj.insert("normal_jitter_window_ms".into(),   serde_json::json!(normal_jitter.max(0) * 1000));
        obj.insert("recovery_jitter_window_ms".into(), serde_json::json!(recovery_jitter.max(0) * 1000));
        obj.insert("max_events".into(),            serde_json::json!(max_events_cfg.max(0)));
        obj.insert("max_bytes".into(),             serde_json::json!(max_bytes_cfg.max(0)));
        obj.insert("batch_bytes".into(),           serde_json::json!(batch.bytes));
        obj.insert("lease_id".into(),              serde_json::json!(&chunk.lease_id));
        obj.insert("lease_issued_at".into(),       serde_json::json!(chunk.lease_issued_at.to_rfc3339()));
        obj.insert("lease_expires_at".into(),      serde_json::json!(chunk.lease_expires_at.to_rfc3339()));
        obj.insert("lease_ttl_seconds".into(),     serde_json::json!(chunk.lease_ttl_seconds));
        obj.insert("max_batch_mb".into(),          serde_json::json!(chunk.max_batch_mb));
        obj.insert("max_upload_rate_kbps".into(),  serde_json::json!(chunk.max_upload_rate_kbps));
        obj.insert("checksum".into(),              serde_json::json!(&chunk.checksum));
        obj.insert("checksum_algorithm".into(),    serde_json::json!("sha256"));
        obj.insert("created_at".into(),            serde_json::json!(Utc::now().to_rfc3339()));
        // events là raw JSON array
        obj.insert("events".into(), parsed);

        let payload = serde_json::to_string(&serde_json::Value::Object(obj))
            .unwrap_or_default();
        (payload, chunk)
    }

    // ── Read + validate ACK ──────────────────────────────────────────────────

    async fn read_and_validate_ack(
        resp: reqwest::Response,
        chunk: &ChunkMetadata,
    ) -> Result<ChunkAck, ShipperError> {
        let body = resp.text().await?;
        if body.trim().is_empty() {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway returned success without ACK body for chunk={}", chunk.chunk_id),
            });
        }
        let ack: ChunkAck = serde_json::from_str(&body).map_err(|e| ShipperError::AckValidation {
            message: format!("Gateway ACK was not valid JSON for chunk={}: {}", chunk.chunk_id, e),
        })?;

        if !ack.ack || !ack.commit {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway did not commit chunk={}; ack_body={}", chunk.chunk_id, body),
            });
        }
        if !ack.chunk_id.eq_ignore_ascii_case(&chunk.chunk_id) {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway ACK chunk_id mismatch. expected={} actual={}", chunk.chunk_id, ack.chunk_id),
            });
        }
        if !ack.checksum.eq_ignore_ascii_case(&chunk.checksum) {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway ACK checksum mismatch for chunk={}.", chunk.chunk_id),
            });
        }
        if ack.event_count != chunk.event_count {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway ACK event_count mismatch for chunk={}. expected={} actual={}", chunk.chunk_id, chunk.event_count, ack.event_count),
            });
        }
        if !chunk.lease_id.is_empty() && !ack.lease_id.eq_ignore_ascii_case(&chunk.lease_id) {
            return Err(ShipperError::AckValidation {
                message: format!("Gateway ACK lease_id mismatch for chunk={}. expected={} actual={}", chunk.chunk_id, chunk.lease_id, ack.lease_id),
            });
        }
        Ok(ack)
    }

    // ── Read batch từ spool file ─────────────────────────────────────────────

    fn read_batch(
        &self,
        file: &str,
        start_line_offset: i32,
        start_byte_offset: u64,
        max_events: i32,
        max_bytes: i32,
    ) -> Batch {
        let mut lines: Vec<String> = Vec::new();
        let mut bytes: usize = 2; // JSON array brackets []
        let mut next_byte  = start_byte_offset.max(0);
        let mut next_line  = start_line_offset.max(0);

        let file_obj = match File::open(file) {
            Ok(f) => f,
            Err(_) => {
                return Batch {
                    lines, bytes, start_byte_offset, next_byte_offset: 0,
                    start_line_offset, next_line_offset: start_line_offset,
                }
            }
        };

        let file_len = file_obj.metadata().map(|m| m.len()).unwrap_or(0);

        if next_byte > file_len {
            return Batch {
                lines, bytes, start_byte_offset,
                next_byte_offset: file_len,
                start_line_offset, next_line_offset: start_line_offset,
            };
        }

        let mut reader = BufReader::new(file_obj);
        reader.seek(SeekFrom::Start(next_byte)).ok();

        let mut raw_line = Vec::new();
        loop {
            raw_line.clear();
            let n = reader.read_until(b'\n', &mut raw_line).unwrap_or(0);
            if n == 0 { break; }

            // Cập nhật next_byte_offset (vị trí sau khi đọc dòng này)
            let line_end = next_byte + n as u64;

            // Strip \r\n
            while raw_line.last() == Some(&b'\n') || raw_line.last() == Some(&b'\r') {
                raw_line.pop();
            }

            // Strip UTF-8 BOM ở đầu file
            if next_byte == 0 && raw_line.len() >= 3
                && raw_line[0] == 0xEF && raw_line[1] == 0xBB && raw_line[2] == 0xBF
            {
                raw_line = raw_line[3..].to_vec();
            }

            next_byte = line_end;

            let line_str = match std::str::from_utf8(&raw_line) {
                Ok(s) => s.trim().to_string(),
                Err(_) => { next_line += 1; continue; }
            };

            if line_str.is_empty() {
                next_line += 1;
                continue;
            }

            // Validate JSON
            if serde_json::from_str::<serde_json::Value>(&line_str).is_err() {
                next_line += 1;
                continue;
            }

            let line_bytes = line_str.len() + if !lines.is_empty() { 1 } else { 0 };

            if !lines.is_empty() && (lines.len() >= max_events as usize || bytes + line_bytes > max_bytes as usize) {
                break;
            }

            lines.push(line_str);
            bytes += line_bytes;
            next_line += 1;

            if lines.len() >= max_events as usize || bytes >= max_bytes as usize {
                break;
            }
        }

        Batch {
            lines,
            bytes,
            start_byte_offset,
            next_byte_offset: next_byte,
            start_line_offset,
            next_line_offset: next_line,
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn resolve_start_byte_offset(&self, file: &str, byte_offset: u64, line_offset: i32) -> u64 {
        if byte_offset > 0 { return byte_offset; }
        if line_offset <= 0 { return 0; }
        // Migration: tính byte offset từ line offset cũ
        let migrated = self.compute_byte_offset_for_line(file, line_offset);
        self.logger.info(&format!(
            "Migrated checkpoint for {} line_offset={} to byte_offset={}.",
            Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or(file),
            line_offset, migrated
        ));
        migrated
    }

    fn compute_byte_offset_for_line(&self, file: &str, target_line: i32) -> u64 {
        if target_line <= 0 { return 0; }
        let f = match File::open(file) { Ok(f) => f, Err(_) => return 0 };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mut reader = BufReader::new(f);
        let mut line = 0i32;
        let mut pos: u64 = 0;
        let mut buf = Vec::new();
        loop {
            buf.clear();
            let n = reader.read_until(b'\n', &mut buf).unwrap_or(0);
            if n == 0 { return len; }
            pos += n as u64;
            line += 1;
            if line >= target_line { return pos; }
        }
    }

    fn try_archive_file(&self, file: &str, byte_offset: u64) {
        let _ = (|| -> anyhow::Result<()> {
            let meta = fs::metadata(file)?;
            if meta.len() == 0 || byte_offset >= meta.len() {
                let parent = Path::new(file).parent().unwrap_or(Path::new("."));
                let sent_dir = parent.join("sent");
                fs::create_dir_all(&sent_dir)?;
                let filename = Path::new(file).file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
                let ts = Utc::now().format("%Y%m%d%H%M%S");
                let dest = sent_dir.join(format!("{}.{}.sent", filename, ts));
                fs::rename(file, &dest)?;
                self.logger.info(&format!(
                    "Archived sent spool file {} -> {}.",
                    filename,
                    dest.file_name().and_then(|n| n.to_str()).unwrap_or("")
                ));
            }
            Ok(())
        })();
    }

    fn gzip_compress(data: &[u8]) -> Result<Vec<u8>, ShipperError> {
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(data).map_err(ShipperError::Io)?;
        encoder.finish().map_err(ShipperError::Io)
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

    // ── Runtime metric ───────────────────────────────────────────────────────

    async fn try_send_runtime_metric(
        &self,
        spool_file: &str,
        batch: &Batch,
        compressed_bytes: u64,
        jitter_secs: i32,
        jitter_window: i32,
        retry_attempt: u32,
        spool_stats: &SpoolStats,
        status_code: u16,
        send_duration: std::time::Duration,
        chunk: &ChunkMetadata,
        ack: &ChunkAck,
        timing: &SendTiming,
    ) {
        let result = (|| async {
            let (max_spool_bytes, low_watermark_bytes, normal_jitter, recovery_jitter, max_events_cfg, max_bytes_cfg, gateway_uri) = {
                let cfg = self.config.lock().unwrap();
                let msb = if cfg.max_spool_size_mb <= 0 { 0u64 } else { cfg.max_spool_size_mb as u64 * 1_048_576 };
                let lwb = if msb == 0 { 0u64 } else { msb * cfg.low_watermark_percent.clamp(1, 100) as u64 / 100 };
                (msb, lwb, cfg.normal_jitter_window_seconds, cfg.recovery_jitter_window_seconds, cfg.max_events, cfg.max_bytes, cfg.gateway_uri.clone())
            };

            let metric_ts = Utc::now();
            let computer = get_endpoint_computer_name();
            let spool_filename = Path::new(spool_file).file_name().and_then(|n| n.to_str()).unwrap_or(spool_file);
            let idempotency = sha256_hex(&format!(
                "{}|{}|{}|{}|{}",
                computer, spool_filename, batch.start_byte_offset, batch.next_byte_offset, metric_ts.to_rfc3339()
            ));

            let jitter_delay_ms = (timing.actual_send_at - timing.jitter_planned_at).num_milliseconds().max(0);
            let success = status_code >= 200 && status_code < 300;
            let data_loss = max_spool_bytes > 0 && spool_stats.bytes > max_spool_bytes;

            let metric = serde_json::json!({
                "source_type":              "hosteye_shipper_metric",
                "metric_type":              "shipper_batch",
                "metric_timestamp":         metric_ts.to_rfc3339(),
                "agent_id":                 get_agent_id(),
                "host_id":                  get_host_id(),
                "computer":                 computer,
                "source_platform":          "hosteye_windows_endpoint",
                "shipper_version":          env!("CARGO_PKG_VERSION"),
                "gateway_uri":              gateway_uri,
                "spool_directory":          spool_file,
                "spool_file":               spool_filename,
                "line_offset":              batch.start_line_offset,
                "next_line_offset":         batch.next_line_offset,
                "byte_offset":              batch.start_byte_offset,
                "next_byte_offset":         batch.next_byte_offset,
                "chunk_id":                 chunk.chunk_id,
                "chunk_checksum":           chunk.checksum,
                "sequence_number":          chunk.sequence_number,
                "ack_status":               ack.status,
                "lease_id":                 chunk.lease_id,
                "lease_issued_at":          chunk.lease_issued_at.to_rfc3339(),
                "lease_expires_at":         chunk.lease_expires_at.to_rfc3339(),
                "lease_ttl_seconds":        chunk.lease_ttl_seconds,
                "max_batch_mb":             chunk.max_batch_mb,
                "max_upload_rate_kbps":     chunk.max_upload_rate_kbps,
                "batch_size":               batch.lines.len(),
                "batch_bytes":              batch.bytes,
                "compressed_bytes":         compressed_bytes,
                "planned_jitter_ms":        jitter_secs * 1000,
                "jitter_window_ms":         jitter_window * 1000,
                "normal_jitter_window_ms":  normal_jitter.max(0) * 1000,
                "recovery_jitter_window_ms": recovery_jitter.max(0) * 1000,
                "max_events":               max_events_cfg.max(0),
                "max_bytes":                max_bytes_cfg.max(0),
                "scheduled_send_at":        timing.scheduled_send_at.to_rfc3339(),
                "actual_send_at":           timing.actual_send_at.to_rfc3339(),
                "send_started_at":          timing.send_started_at.to_rfc3339(),
                "send_completed_at":        timing.send_completed_at.to_rfc3339(),
                "jitter_delay_ms":          jitter_delay_ms,
                "backoff_delay_ms":         0,
                "next_retry_at":            timing.send_completed_at.to_rfc3339(),
                "retry_attempt":            retry_attempt,
                "planned_backoff_ms":       0,
                "spool_depth_bytes":        spool_stats.bytes,
                "spool_file_count":         spool_stats.file_count,
                "pending_file_count":       spool_stats.pending_file_count,
                "max_spool_bytes":          max_spool_bytes,
                "low_watermark_bytes":      low_watermark_bytes,
                "status_code":              status_code,
                "send_duration_ms":         send_duration.as_millis(),
                "success":                  success,
                "data_loss":                data_loss,
                "message":                  "HostEyeShipper batch sent",
                "idempotency_key":          idempotency,
            });

            let payload = format!("[{}]", serde_json::to_string(&metric)?);
            let current_gateway = self.config.lock().unwrap().gateway_uri.clone();
            let resp = self.http
                .post(&current_gateway)
                .header("Content-Type", "application/json")
                .header("User-Agent", "HostEyeShipper/1.0")
                .body(payload)
                .send()
                .await?;

            if !resp.status().is_success() {
                self.logger.warn(&format!(
                    "Runtime metric send returned {} {}.",
                    resp.status().as_u16(),
                    resp.status().canonical_reason().unwrap_or("")
                ));
            }
            Ok::<(), anyhow::Error>(())
        })().await;

        if let Err(e) = result {
            self.logger.warn(&format!("Runtime metric send skipped: {}", e));
        }
    }
}
