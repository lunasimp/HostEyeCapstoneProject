use clickhouse::Row;
use serde::Serialize;

#[derive(Row, Serialize)]
pub struct ContextEdgeRow {
    pub edge_timestamp: String,
    pub computer: String,
    
    pub edge_type: String,
    pub source_event_key: String,
    pub target_event_key: String,
    
    pub source_guid: String,
    pub target_guid: String,
    
    pub confidence: u8,
    pub evidence: String,
    pub context_window_ms: i32,
}

pub fn build_context_edge(
    edge_type: &str,
    source_event_key: &str,
    target_event_key: &str,
    source_guid: &str,
    target_guid: &str,
    computer: &str,
    evidence: &str,
) -> ContextEdgeRow {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    
    ContextEdgeRow {
        edge_timestamp: now,
        computer: computer.to_string(),
        edge_type: edge_type.to_string(),
        source_event_key: source_event_key.to_string(),
        target_event_key: target_event_key.to_string(),
        source_guid: source_guid.to_string(),
        target_guid: target_guid.to_string(),
        confidence: 100, // Hardcoded high confidence for explicit logs (like Sysmon 1)
        evidence: evidence.to_string(),
        context_window_ms: 300000, // 5 phút (tương lai có thể cấu hình linh hoạt)
    }
}
