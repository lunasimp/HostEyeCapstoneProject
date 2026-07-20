use clickhouse::Row;
use serde::Deserialize;

/// Row được query từ default.ingest_chunks để check idempotency.
#[derive(Debug, Row, Deserialize)]
pub struct ExistingChunkRow {
    pub checksum: String,
    pub event_count: u32,
    pub status: String,
}

/// Kết quả từ idempotency check.
#[derive(Debug)]
pub struct ExistingChunk {
    pub checksum: String,
    pub event_count: u32,
    pub status: String,
}

/// Kiểm tra chunk đã được ingest trước đó chưa (chống retry trùng lặp).
///
/// Query ClickHouse `default.ingest_chunks FINAL` để lấy row mới nhất
/// theo (agent_id, chunk_id). Trả về None nếu chưa có.
///
/// Note: dùng FINAL vì table dùng ReplacingMergeTree — cần merge để đọc
/// trạng thái mới nhất.
pub async fn get_existing_chunk(
    ch: &clickhouse::Client,
    agent_id: &str,
    chunk_id: &str,
) -> anyhow::Result<Option<ExistingChunk>> {
    let query = format!(
        "SELECT checksum, event_count, status \
         FROM default.ingest_chunks FINAL \
         WHERE agent_id = '{}' AND chunk_id = '{}' \
         ORDER BY last_seen DESC \
         LIMIT 1",
        escape_string(agent_id),
        escape_string(chunk_id),
    );

    let mut cursor = ch.query(&query).fetch::<ExistingChunkRow>()?;

    match cursor.next().await? {
        Some(row) => Ok(Some(ExistingChunk {
            checksum: row.checksum,
            event_count: row.event_count,
            status: row.status,
        })),
        None => Ok(None),
    }
}

/// Xác định index_status từ chunk status để trả về trong duplicate ACK.
pub fn index_status_from_chunk_status(status: &str) -> &'static str {
    match status {
        "index_queued" | "index_failed" => status,
        "queued" => "index_queued",
        "raw_stored" | "received" => "not_indexed",
        _ => "duplicate",
    }
}

/// Escape string đơn giản để tránh SQL injection khi build query string.
/// ClickHouse parameterized queries được dùng khi có bind() support,
/// nhưng clickhouse-rs 0.12 yêu cầu build query thủ công cho LIMIT queries.
fn escape_string(s: &str) -> String {
    s.replace('\'', "\\'").replace('\\', "\\\\")
}
