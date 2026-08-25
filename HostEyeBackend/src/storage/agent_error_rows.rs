use clickhouse::Row;
use serde::{Deserialize, Serialize};

/// Một bản ghi lỗi chunk do Agent báo cáo.
/// Được INSERT vào bảng `default.agent_chunk_errors`.
///
/// Agent gom đủ 5 lỗi → gửi batch lên POST /api/v1/agent/telemetry/errors
/// → nhận 200 OK → xóa các file chunk tương ứng khỏi spool.
#[derive(Debug, Clone, Row, Serialize, Deserialize)]
pub struct AgentChunkErrorRow {
    /// Thời điểm Backend ghi nhận báo cáo (do Backend tự set, không do Agent gửi)
    pub reported_at: String,     // ISO 8601 / DateTime64(3)
    pub agent_id: String,
    pub chunk_id: String,
    /// Loại lỗi: "checksum_invalid" | "event_count_mismatch" | "missing_fields"
    ///           | "schema_invalid" | "conflict_409"
    pub error_type: String,
    /// Thời điểm Agent phát hiện lỗi (do Agent gửi lên)
    pub quarantined_at: String,  // ISO 8601 / DateTime64(3)
}

/// Payload Agent gửi lên POST /api/v1/agent/telemetry/errors.
/// Một request có thể chứa nhiều lỗi cùng lúc (batch tối đa 5).
#[derive(Debug, Deserialize)]
pub struct AgentErrorReport {
    pub agent_id: String,
    pub errors: Vec<AgentErrorItem>,
}

#[derive(Debug, Deserialize)]
pub struct AgentErrorItem {
    pub chunk_id: String,
    pub error_type: String,
    pub quarantined_at: String,
}

impl AgentErrorReport {
    /// Chuyển đổi sang Vec<AgentChunkErrorRow> để INSERT vào ClickHouse.
    pub fn into_rows(self, reported_at: &str) -> Vec<AgentChunkErrorRow> {
        self.errors
            .into_iter()
            .map(|item| AgentChunkErrorRow {
                reported_at: reported_at.to_string(),
                agent_id: self.agent_id.clone(),
                chunk_id: item.chunk_id,
                error_type: item.error_type,
                quarantined_at: item.quarantined_at,
            })
            .collect()
    }
}
