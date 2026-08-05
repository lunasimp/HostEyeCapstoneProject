// spool/quota.rs
// Port từ: Services/SpoolQuotaManager.cs

use crate::config::ShipperConfig;
use crate::util::logger::FileLogger;
use flate2::read::GzDecoder;
use std::{collections::HashMap, fs, io::Read, path::Path};

#[derive(Debug, Clone, Default)]
pub struct SpoolStats {
    pub bytes:               u64,
    pub file_count:          u32,
    pub pending_file_count:  u32,
    pub pending_event_count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpoolEnforcement {
    pub dropped_file_count: u32,
    pub dropped_event_count: u64,
    pub dropped_events_by_source: HashMap<String, u64>,
    pub unattributed_dropped_event_count: u64,
}

#[derive(Debug, Clone)]
pub struct QuotaFile {
    pub full_name: String,
    pub is_sent:   bool,
}

#[derive(Clone, Copy)]
pub struct SpoolQuotaManager;

impl SpoolQuotaManager {
    pub fn new() -> Self { Self }

    /// Enforce spool quota policy — xoá file cũ nếu vượt max size.
    /// Port từ EnforceSpoolPolicy()
    pub fn enforce_spool_policy(&self, config: &ShipperConfig, logger: &FileLogger) -> SpoolEnforcement {
        self.try_enforce(config, logger).unwrap_or_else(|e| {
            logger.info(&format!("Spool policy check failed: {}", e));
            SpoolEnforcement::default()
        })
    }

    fn try_enforce(&self, config: &ShipperConfig, logger: &FileLogger) -> anyhow::Result<SpoolEnforcement> {
        self.delete_expired_sent_files(config, logger);
        let mut enforcement = SpoolEnforcement::default();

        let max_bytes = if config.max_spool_size_mb <= 0 {
            return Ok(enforcement);
        } else {
            config.max_spool_size_mb as u64 * 1024 * 1024
        };

        let watermark = config.low_watermark_percent.clamp(1, 100) as u64;
        let target_bytes = max_bytes * watermark / 100;
        let mut total_bytes = self.get_directory_size_bytes(&config.spool_directory);

        if total_bytes <= max_bytes { return Ok(enforcement); }

        logger.info(&format!(
            "Spool size {} bytes exceeds max {} bytes; trimming to {} bytes.",
            total_bytes, max_bytes, target_bytes
        ));

        for candidate in self.get_deletion_candidates(config) {
            if total_bytes <= target_bytes { break; }
            match fs::metadata(&candidate.full_name) {
                Ok(meta) => {
                    let len = meta.len();
                    let event_count = event_count_from_path(Path::new(&candidate.full_name)).unwrap_or(0);
                    let dimensions = if candidate.is_sent { None } else { event_dimensions_from_chunk(Path::new(&candidate.full_name)) };
                    match fs::remove_file(&candidate.full_name) {
                        Ok(_) => {
                            total_bytes = total_bytes.saturating_sub(len);
                            if candidate.is_sent {
                                logger.info(&format!(
                                    "Deleted sent spool file {} ({} bytes) to enforce spool limit.",
                                    candidate.full_name, len
                                ));
                            } else {
                                enforcement.dropped_file_count += 1;
                                enforcement.dropped_event_count = enforcement.dropped_event_count.saturating_add(event_count);
                                if let Some(counts) = dimensions {
                                    for (key, value) in counts {
                                        let count = enforcement.dropped_events_by_source.entry(key).or_insert(0);
                                        *count = count.saturating_add(value);
                                    }
                                } else {
                                    enforcement.unattributed_dropped_event_count = enforcement.unattributed_dropped_event_count.saturating_add(event_count);
                                }
                                logger.warn(&format!(
                                    "Dropped unsent spool file {} ({} bytes) to enforce spool limit. DATA_LOSS=true",
                                    candidate.full_name, len
                                ));
                            }
                        }
                        Err(e) => {
                            logger.info(&format!("Spool cleanup skipped {}: {}", candidate.full_name, e));
                        }
                    }
                }
                Err(e) => {
                    logger.info(&format!("Spool cleanup metadata error {}: {}", candidate.full_name, e));
                }
            }
        }
        Ok(enforcement)
    }

    fn delete_expired_sent_files(&self, config: &ShipperConfig, logger: &FileLogger) {
        if config.sent_retention_days < 0 { return; }
        let sent_dir = Path::new(&config.spool_directory).join("sent");
        if !sent_dir.exists() { return; }

        let cutoff = chrono::Utc::now()
            - chrono::Duration::days(config.sent_retention_days as i64);

        let entries = match fs::read_dir(&sent_dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            if let Ok(meta) = fs::metadata(&path) {
                if let Ok(mtime) = meta.modified() {
                    let mtime_utc: chrono::DateTime<chrono::Utc> = mtime.into();
                    if mtime_utc > cutoff { continue; }
                }
                match fs::remove_file(&path) {
                    Ok(_)  => logger.info(&format!("Deleted sent spool file past retention: {}", path.display())),
                    Err(e) => logger.info(&format!("Sent retention cleanup skipped {}: {}", path.display(), e)),
                }
            }
        }
    }

    /// Tổng kích thước thư mục (bytes), đệ quy.
    pub fn get_directory_size_bytes(&self, directory: &str) -> u64 {
        let path = Path::new(directory);
        if !path.exists() { return 0; }
        walk_size(path)
    }

    /// Thống kê spool files.
    pub fn get_spool_stats(&self, directory: &str) -> SpoolStats {
        let path = Path::new(directory);
        if !path.exists() { return SpoolStats::default(); }

        let mut stats = SpoolStats::default();
        count_files(path, directory, &mut stats);
        stats
    }

    /// Iterator các file ứng cử viên để xoá — sent first (nếu prefer).
    fn get_deletion_candidates(&self, config: &ShipperConfig) -> Vec<QuotaFile> {
        let mut candidates = Vec::new();
        let spool = Path::new(&config.spool_directory);
        let sent_dir = spool.join("sent");

        let mut sent_files: Vec<_> = if sent_dir.exists() {
            fs::read_dir(&sent_dir)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.path())
                .collect()
        } else {
            vec![]
        };
        sent_files.sort_by_key(|p| {
            fs::metadata(p).and_then(|m| m.modified()).ok()
        });

        let mut pending_files: Vec<_> = if spool.exists() {
            fs::read_dir(spool)
                .ok()
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| {
                    let p = e.path();
                    p.is_file()
                        && p.extension()
                            .and_then(|x| x.to_str())
                            .map(|x| x.eq_ignore_ascii_case("gz"))
                            .unwrap_or(false)
                })
                .map(|e| e.path())
                .collect()
        } else {
            vec![]
        };
        pending_files.sort_by_key(|p| {
            fs::metadata(p).and_then(|m| m.created()).ok()
        });

        if config.prefer_deleting_sent_first {
            for p in &sent_files {
                candidates.push(QuotaFile { full_name: p.to_string_lossy().to_string(), is_sent: true });
            }
            for p in &pending_files {
                candidates.push(QuotaFile { full_name: p.to_string_lossy().to_string(), is_sent: false });
            }
        } else {
            for p in &pending_files {
                candidates.push(QuotaFile { full_name: p.to_string_lossy().to_string(), is_sent: false });
            }
            for p in &sent_files {
                candidates.push(QuotaFile { full_name: p.to_string_lossy().to_string(), is_sent: true });
            }
        }

        candidates
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn walk_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                total += walk_size(&p);
            } else if let Ok(m) = fs::metadata(&p) {
                total += m.len();
            }
        }
    }
    total
}

fn count_files(dir: &Path, spool_root: &str, stats: &mut SpoolStats) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                count_files(&p, spool_root, stats);
            } else if let Ok(m) = fs::metadata(&p) {
                stats.bytes += m.len();
                stats.file_count += 1;
                // pending = .gz ở thẳng spool root (không trong subdir)
                if p.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("gz"))
                    .unwrap_or(false)
                {
                    if let Some(parent) = p.parent() {
                        if parent == Path::new(spool_root) {
                            stats.pending_file_count += 1;
                            stats.pending_event_count = stats.pending_event_count
                                .saturating_add(event_count_from_path(&p).unwrap_or(0));
                        }
                    }
                }
            }
        }
    }
}

fn event_count_from_path(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?.strip_suffix(".gz")?;
    name.rsplit('_').next()?.parse().ok()
}
fn event_dimensions_from_chunk(path: &Path) -> Option<HashMap<String, u64>> {
    let mut decoder = GzDecoder::new(fs::File::open(path).ok()?);
    let mut json = String::new(); decoder.read_to_string(&mut json).ok()?;
    let payload: serde_json::Value = serde_json::from_str(&json).ok()?;
    let mut counts = HashMap::new();
    for event in payload.get("events")?.as_array()? {
        let channel = event.get("channel").and_then(|v| v.as_str()).or_else(|| event.pointer("/winlog/channel").and_then(|v| v.as_str())).unwrap_or("(unknown)");
        let event_id = event.get("event_id").and_then(json_scalar).or_else(|| event.pointer("/winlog/event_id").and_then(json_scalar)).or_else(|| event.pointer("/event/code").and_then(json_scalar)).unwrap_or_else(|| "0".to_string());
        let count = counts.entry(format!("{}\u{1f}{}", channel, event_id)).or_insert(0u64); *count = count.saturating_add(1);
    }
    Some(counts)
}
fn json_scalar(value: &serde_json::Value) -> Option<String> { value.as_str().map(ToOwned::to_owned).or_else(|| value.as_u64().map(|n| n.to_string())).or_else(|| value.as_i64().map(|n| n.to_string())) }

#[cfg(test)]
mod tests {
    use super::{event_count_from_path, SpoolQuotaManager};
    use crate::{config::ShipperConfig, util::logger::FileLogger};
    use std::{fs, path::Path, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn parses_event_count_from_chunk_filename() {
        assert_eq!(event_count_from_path(Path::new("chunk_id_checksum_42.gz")), Some(42));
        assert_eq!(event_count_from_path(Path::new("invalid.gz")), None);
    }

    #[test]
    fn reports_pending_and_quota_dropped_events() {
        let suffix = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("hosteye-uc14-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let chunk = root.join("chunk_id_checksum_42.gz");
        fs::write(&chunk, vec![0u8; 2 * 1024 * 1024]).unwrap();

        let manager = SpoolQuotaManager::new();
        let before = manager.get_spool_stats(root.to_str().unwrap());
        assert_eq!(before.pending_file_count, 1);
        assert_eq!(before.pending_event_count, 42);

        let mut config = ShipperConfig::default();
        config.spool_directory = root.to_string_lossy().to_string();
        config.max_spool_size_mb = 1;
        config.low_watermark_percent = 50;
        config.prefer_deleting_sent_first = false;
        let enforcement = manager.enforce_spool_policy(&config, &FileLogger::new(""));

        assert_eq!(enforcement.dropped_file_count, 1);
        assert_eq!(enforcement.dropped_event_count, 42);
        assert!(!chunk.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
