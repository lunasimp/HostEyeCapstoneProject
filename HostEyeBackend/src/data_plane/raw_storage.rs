use std::io::Write;
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use serde_json::Value;
use tokio::fs;

/// Metadata của raw chunk sau khi được ghi xuống disk.
#[derive(Debug, Clone)]
pub struct RawChunkMeta {
    /// Đường dẫn tuyệt đối của file .json.gz
    pub raw_path: String,
    /// Kích thước JSON gốc (chưa nén) tính bằng bytes
    pub raw_size_bytes: usize,
    /// Kích thước sau khi gzip nén
    pub compressed_size_bytes: usize,
    /// Luôn là "gzip"
    pub compression: String,
    /// sha256 của raw JSON string (dùng để verify khi worker đọc lại)
    pub raw_sha256: String,
}

/// Ghi raw chunk payload xuống disk dưới dạng gzip JSON.
///
/// Cấu trúc thư mục: `{raw_chunk_dir}/{YYYY-MM-DD}/{safe_agent_id}/{safe_chunk_id}.json.gz`
///
/// Port từ writeRawChunk() trong Node.js dataplane/index.js:
/// - Nén bằng gzip (flate2, tương đương zlib.gzipSync)
/// - Nếu file đã tồn tại (EEXIST) → idempotent, bỏ qua không lỗi
/// - Trả RawChunkMeta để insert vào raw_chunk_vault và build broker job
pub async fn write_raw_chunk(
    raw_chunk_dir: &str,
    payload: &Value,
    agent_id: &str,
    chunk_id: &str,
) -> anyhow::Result<RawChunkMeta> {
    let now = chrono::Utc::now();
    let day = now.format("%Y-%m-%d").to_string();
    let safe_agent_id = safe_path_part(agent_id);
    let safe_chunk_id = safe_path_part(chunk_id);

    let dir = format!("{}/{}/{}", raw_chunk_dir, day, safe_agent_id);
    fs::create_dir_all(&dir).await?;

    let file_path = format!("{}/{}.json.gz", dir, safe_chunk_id);

    // Serialize payload sang canonical JSON
    let canonical = payload.to_string();
    let raw_bytes = canonical.as_bytes();
    let raw_size_bytes = raw_bytes.len();
    let raw_sha256 = sha256_hex(&canonical);

    // Nén bằng gzip
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw_bytes)?;
    let compressed = encoder.finish()?;
    let compressed_size_bytes = compressed.len();

    // Ghi file — nếu đã tồn tại thì bỏ qua (idempotent, giống flag "wx" trong Node.js)
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)  // fail nếu file đã tồn tại
        .open(&file_path)
        .await
    {
        Ok(file) => {
            use tokio::io::AsyncWriteExt;
            let mut file = file;
            file.write_all(&compressed).await?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // File đã tồn tại — idempotent, không cần ghi lại
            tracing::debug!(chunk_id, "raw chunk file already exists, skipping write");
        }
        Err(e) => return Err(e.into()),
    }

    Ok(RawChunkMeta {
        raw_path: file_path,
        raw_size_bytes,
        compressed_size_bytes,
        compression: "gzip".to_string(),
        raw_sha256,
    })
}

/// Sanitize path component để tránh directory traversal.
/// Chỉ giữ lại a-z, A-Z, 0-9, _, ., - và cắt tối đa 128 ký tự.
fn safe_path_part(value: &str) -> String {
    value.chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' })
        .take(128)
        .collect()
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}
