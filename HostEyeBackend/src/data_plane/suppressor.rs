use serde_json::Value;
use sha2::{Sha256, Digest};
use hex;
use chrono::{DateTime, Utc, Duration, TimeZone};
use serde::Deserialize;

use crate::storage::suppression_rows::{build_suppression_row, SuppressionRow};

/// Trạng thái suppression hiện tại lấy từ ClickHouse.
#[derive(Debug, Deserialize)]
pub struct SuppressionState {
    pub fingerprint: String,
    pub first_seen: String,
    pub last_seen: String,
    pub suppressed_count: u32,
    pub representative_event_key: String,
    pub representative_chunk_id: String,
    pub representative_record_id: u64,
}

/// Chạy server-side suppression cho một event.
/// Trả về (event đã sửa đổi, suppression_row để upsert nếu có).
pub async fn suppress_event(
    mut event: Value,
    ch: &clickhouse::Client,
) -> (Value, Option<SuppressionRow>) {
    // 1. Kiểm tra nếu event được cấu hình bypass suppression (forensic EIDs: 1, 3, 7, 8, 10, 11, 22, 25, v.v.)
    let event_id = event.get("event_id").and_then(|v| v.as_u64()).unwrap_or(0);
    let channel = event.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    
    if should_bypass_suppression(event_id, channel) {
        if let Some(obj) = event.as_object_mut() {
            obj.insert("suppression_rule_id".to_string(), serde_json::json!("bypassed"));
        }
        return (event, None);
    }

    // 2. Tính fingerprint của event
    let fingerprint = calculate_fingerprint(&event);
    
    // 3. Tính window_start và window_end (ví dụ window 1 giờ)
    let timestamp_str = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let timestamp = chrono::DateTime::parse_from_rfc3339(timestamp_str)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
        
    let window_start = timestamp.duration_trunc(Duration::hours(1)).unwrap_or(timestamp);
    let window_end = window_start + Duration::hours(1);

    // 4. Lấy trạng thái hiện tại từ ClickHouse
    let existing_state = get_suppression_state(ch, &fingerprint, window_start).await;

    // 5. Cập nhật trạng thái
    let mut row;
    if let Some(state) = existing_state {
        // Đã có fingerprint này trong window
        let first_seen = chrono::DateTime::parse_from_rfc3339(&state.first_seen)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or(timestamp);
            
        row = build_suppression_row(
            &event,
            &fingerprint,
            window_start,
            window_end,
            first_seen,
            timestamp, // last_seen mới
            state.suppressed_count + 1,
        );
        
        // Giữ nguyên representative info
        row.representative_event_key = state.representative_event_key;
        row.representative_chunk_id = state.representative_chunk_id;
        row.representative_record_id = state.representative_record_id;
        
        // Đánh dấu event này bị suppress
        if let Some(obj) = event.as_object_mut() {
            obj.insert("suppression_rule_id".to_string(), serde_json::json!("suppressed_duplicate"));
        }
    } else {
        // Lần đầu gặp fingerprint này trong window
        row = build_suppression_row(
            &event,
            &fingerprint,
            window_start,
            window_end,
            timestamp,
            timestamp,
            0,
        );
        // Đánh dấu event này là representative
        if let Some(obj) = event.as_object_mut() {
            obj.insert("suppression_rule_id".to_string(), serde_json::json!("representative"));
        }
    }

    (event, Some(row))
}

fn should_bypass_suppression(event_id: u64, channel: &str) -> bool {
    // Luôn giữ lại các event Sysmon / Security quan trọng không nên bị deduplicate
    if channel == "Microsoft-Windows-Sysmon/Operational" {
        match event_id {
            1 | 3 | 7 | 8 | 10 | 11 | 22 | 25 => return true,
            _ => return false,
        }
    }
    
    if channel == "Security" {
        match event_id {
            4624 | 4625 | 4688 | 4689 => return true,
            _ => return false,
        }
    }
    
    false
}

fn calculate_fingerprint(event: &Value) -> String {
    // Fingerprint cơ bản: computer + event_id + message_hash (hoặc các field quan trọng khác)
    let computer = event.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    let event_id = event.get("event_id").and_then(|v| v.as_u64()).unwrap_or(0);
    
    // Dùng event_data_json nếu có, nếu không thì dùng raw_log/message
    let payload = if let Some(data) = event.get("event_data_json").and_then(|v| v.as_object()) {
        serde_json::to_string(data).unwrap_or_default()
    } else {
        event.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    
    let input = format!("{}|{}|{}", computer, event_id, payload);
    
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

async fn get_suppression_state(
    ch: &clickhouse::Client,
    fingerprint: &str,
    window_start: DateTime<Utc>,
) -> Option<SuppressionState> {
    let window_start_str = window_start.format("%Y-%m-%d %H:%M:%S").to_string();
    
    // Dùng FINAL để lấy trạng thái mới nhất từ ReplacingMergeTree
    let query = format!(
        "SELECT fingerprint, first_seen, last_seen, suppressed_count, representative_event_key, representative_chunk_id, representative_record_id \
         FROM default.suppression_state FINAL \
         WHERE fingerprint = ? AND window_start = ?"
    );
    
    let mut cursor = match ch.query(&query)
        .bind(fingerprint)
        .bind(&window_start_str)
        .fetch::<SuppressionState>()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Failed to query suppression_state: {}", e);
            return None;
        }
    };
    
    match cursor.next().await {
        Ok(Some(state)) => Some(state),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!("Failed to fetch suppression_state row: {}", e);
            None
        }
    }
}

// Ext trait để format datetime truncate dễ dàng hơn
trait DurationTruncate {
    fn duration_trunc(&self, duration: Duration) -> Option<DateTime<Utc>>;
}

impl DurationTruncate for DateTime<Utc> {
    fn duration_trunc(&self, duration: Duration) -> Option<DateTime<Utc>> {
        let span = duration.num_seconds();
        if span <= 0 {
            return None;
        }
        let ts = self.timestamp();
        let trunc = ts - (ts % span);
        Utc.timestamp_opt(trunc, 0).single()
    }
}
