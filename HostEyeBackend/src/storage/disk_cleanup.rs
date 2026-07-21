use std::time::{Duration, SystemTime};
use tokio::fs;

/// Chạy background task dọn dẹp thư mục raw chunk liên tục mỗi `interval_secs`
///
/// Xóa file dựa trên 2 điều kiện:
/// 1. File cũ hơn `max_age_days` (3 ngày)
/// 2. Tổng dung lượng thư mục > `max_size_bytes` (5GB), xóa file cũ nhất đến khi dưới ngưỡng.
pub async fn start_disk_cleanup_loop(
    raw_chunk_dir: String,
    interval_secs: u64,
    max_age_days: u64,
    max_size_bytes: u64,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
    loop {
        interval.tick().await;
        if let Err(e) = run_cleanup(&raw_chunk_dir, max_age_days, max_size_bytes).await {
            tracing::error!("Disk cleanup failed: {}", e);
        }
    }
}

async fn run_cleanup(dir: &str, max_age_days: u64, max_size_bytes: u64) -> anyhow::Result<()> {
    let max_age = Duration::from_secs(max_age_days * 24 * 3600);
    let now = SystemTime::now();

    // Thu thập tất cả các file trong thư mục đệ quy
    let mut all_files = Vec::new();
    collect_files_recursively(dir, &mut all_files).await?;

    let mut total_size: u64 = 0;
    let mut valid_files = Vec::new();

    for file in all_files {
        match fs::metadata(&file).await {
            Ok(meta) => {
                if !meta.is_file() {
                    continue;
                }
                
                let size = meta.len();
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = now.duration_since(modified) {
                        if age > max_age {
                            // Xóa file cũ hơn max_age
                            if let Err(e) = fs::remove_file(&file).await {
                                tracing::warn!("Failed to delete old file {}: {}", file, e);
                            } else {
                                tracing::info!("Deleted old raw chunk file: {} (age: {}s)", file, age.as_secs());
                            }
                            continue;
                        }
                    }
                    total_size += size;
                    valid_files.push((file, modified, size));
                }
            }
            Err(e) => {
                tracing::warn!("Failed to read metadata for {}: {}", file, e);
            }
        }
    }

    // Nếu dung lượng > max_size_bytes, tiến hành xóa theo dung lượng
    if total_size > max_size_bytes {
        // Sắp xếp file từ cũ đến mới (modified time tăng dần)
        valid_files.sort_by_key(|k| k.1);

        for (file, _modified, size) in valid_files {
            if total_size <= max_size_bytes {
                break; // Đã đạt ngưỡng an toàn
            }
            if let Err(e) = fs::remove_file(&file).await {
                tracing::warn!("Failed to delete file {} for capacity: {}", file, e);
            } else {
                tracing::info!("Deleted raw chunk file for capacity: {} (size: {} bytes)", file, size);
                total_size = total_size.saturating_sub(size);
            }
        }
    }

    Ok(())
}

use std::path::PathBuf;

/// Tìm tất cả file trong một thư mục bằng thư viện tokio::fs không đệ quy
async fn collect_files_recursively(dir: &str, files: &mut Vec<String>) -> anyhow::Result<()> {
    let mut dirs_to_visit = vec![dir.to_string()];

    while let Some(current_dir) = dirs_to_visit.pop() {
        let mut entries = match fs::read_dir(&current_dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if path.is_dir() {
                if let Some(p) = path.to_str() {
                    dirs_to_visit.push(p.to_string());
                }
            } else if path.is_file() {
                if let Some(p) = path.to_str() {
                    if p.ends_with(".gz") || p.ends_with(".json.gz") {
                        files.push(p.to_string());
                    }
                }
            }
        }
    }
    Ok(())
}
