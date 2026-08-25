use clickhouse::Row;
use serde::Serialize;
use serde_json::Value;
use chrono::{DateTime, Utc};

#[derive(Row, Serialize)]
pub struct SuppressionRow {
    pub kafka_timestamp: String,
    pub updated_at: String,
    pub fingerprint: String,
    pub window_start: String,
    pub window_end: String,
    
    pub agent_id: String,
    pub host_id: String,
    pub computer: String,
    pub channel: String,
    pub event_id: u32,
    pub record_id: u64,
    pub user_name: String,
    
    pub first_seen: String,
    pub last_seen: String,
    
    pub representative_event_key: String,
    pub representative_chunk_id: String,
    pub representative_record_id: u64,
    
    pub suppressed_count: u32,
}

pub fn build_suppression_row(
    event: &Value,
    fingerprint: &str,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    first_seen: DateTime<Utc>,
    last_seen: DateTime<Utc>,
    suppressed_count: u32,
) -> SuppressionRow {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    
    let get_str = |key: &str| event.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let get_u32 = |key: &str| event.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let get_u64 = |key: &str| event.get(key).and_then(|v| v.as_u64()).unwrap_or(0);

    SuppressionRow {
        kafka_timestamp: now.clone(),
        updated_at: now,
        fingerprint: fingerprint.to_string(),
        window_start: window_start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        window_end: window_end.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        
        agent_id: get_str("agent_id"),
        host_id: get_str("host_id"),
        computer: get_str("computer"),
        channel: get_str("channel"),
        event_id: get_u32("event_id"),
        record_id: get_u64("record_id"),
        user_name: get_str("user_name"),
        
        first_seen: first_seen.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        last_seen: last_seen.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        
        representative_event_key: get_str("idempotency_key"),
        representative_chunk_id: get_str("chunk_id"),
        representative_record_id: get_u64("record_id"),
        
        suppressed_count,
    }
}
