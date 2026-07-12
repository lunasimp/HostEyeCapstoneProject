// spool/quota.rs
// Port từ: Services/SpoolQuotaManager.cs

use crate::config::ShipperConfig;
use crate::util::logger::FileLogger;
use std::{fs, path::Path};

#[derive(Debug, Clone, Default)]
pub struct SpoolStats {
    pub bytes:             u64,
    pub file_count:        u32,
    pub pending_file_count: u32,
}

#[derive(Debug, Clone)]
pub struct QuotaFile {
    pub full_name: String,
    pub is_sent:   bool,
}

pub struct SpoolQuotaManager;

impl SpoolQuotaManager {
    pub fn new() -> Self { Self }

    /// Enforce spool quota policy — xoá file cũ nếu vượt max size.
    /// Port từ EnforceSpoolPolicy()
    pub fn enforce_spool_policy(&self, config: &ShipperConfig, logger: &FileLogger) {
        if let Err(e) = self.try_enforce(config, logger) {
            logger.info(&format!("Spool policy check failed: {}", e));
        }
    }

    fn try_enforce(&self, config: &ShipperConfig, logger: &FileLogger) -> anyhow::Result<()> {
        self.delete_expired_sent_files(config, logger);

        let max_bytes = if config.max_spool_size_mb <= 0 {
            return Ok(());
        } else {
            config.max_spool_size_mb as u64 * 1024 * 1024
        };

        let watermark = config.low_watermark_percent.clamp(1, 100) as u64;
        let target_bytes = max_bytes * watermark / 100;
        let mut total_bytes = self.get_directory_size_bytes(&config.spool_directory);

        if total_bytes <= max_bytes { return Ok(()); }

        logger.info(&format!(
            "Spool size {} bytes exceeds max {} bytes; trimming to {} bytes.",
            total_bytes, max_bytes, target_bytes
        ));

        for candidate in self.get_deletion_candidates(config) {
            if total_bytes <= target_bytes { break; }
            match fs::metadata(&candidate.full_name) {
                Ok(meta) => {
                    let len = meta.len();
                    match fs::remove_file(&candidate.full_name) {
                        Ok(_) => {
                            total_bytes = total_bytes.saturating_sub(len);
                            if candidate.is_sent {
                                logger.info(&format!(
                                    "Deleted sent spool file {} ({} bytes) to enforce spool limit.",
                                    candidate.full_name, len
                                ));
                            } else {
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
        Ok(())
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
                            .map(|x| x.eq_ignore_ascii_case("ndjson"))
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
                // pending = .ndjson ở thẳng spool root (không trong subdir)
                if p.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case("ndjson"))
                    .unwrap_or(false)
                {
                    if let Some(parent) = p.parent() {
                        if parent == Path::new(spool_root) {
                            stats.pending_file_count += 1;
                        }
                    }
                }
            }
        }
    }
}
