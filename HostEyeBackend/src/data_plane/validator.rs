use sha2::{Digest, Sha256};
use serde_json::Value;

const REQUIRED_EVENT_FIELDS: &[&str] = &[
    "agent_id", "host_id", "computer", "timestamp",
    "channel", "event_id", "record_id",
];

const PROCESSING_VERSION: &str = "server-processing-1.0.0";

/// Kết quả validate chunk envelope.
#[derive(Debug)]
pub struct ValidationResult {
    pub ok: bool,
    pub status_code: u16,
    pub body: Option<Value>,
    /// sha256(JSON string của events array)
    pub checksum: String,
    pub event_count: usize,
    pub chunk_id: String,
    pub agent_id: String,
}

/// Validate chunk envelope theo protocol hosteye.telemetry.v1.
///
/// Port từ validateChunkEnvelope() trong Node.js dataplane/index.js.
/// Kiểm tra:
/// - events là array
/// - schema_version khớp required_schema_version
/// - chunk_id và agent_id không rỗng
/// - event_count trong payload khớp events.len()
/// - checksum == sha256(JSON.stringify(events))
pub fn validate_chunk_envelope(payload: &Value, required_schema_version: &str) -> ValidationResult {
    let chunk_id = str_field(payload, "chunk_id");
    let agent_id = str_field(payload, "agent_id");
    let schema_version = str_field(payload, "schema_version");

    let events = match payload.get("events").and_then(|e| e.as_array()) {
        Some(arr) => arr,
        None => {
            return invalid_chunk(400, serde_json::json!({
                "ack": false, "commit": false, "status": "invalid",
                "message": "events must be an array"
            }));
        }
    };

    let event_count = events.len();
    // Tính checksum: sha256(JSON string của events, compact không có extra spaces)
    let events_json = Value::Array(events.clone()).to_string();
    let checksum = sha256_hex(&events_json);

    if schema_version != required_schema_version {
        return invalid_chunk(400, serde_json::json!({
            "ack": false, "commit": false, "status": "schema_invalid",
            "chunk_id": chunk_id,
            "message": format!("schema_version must be {}", required_schema_version)
        }));
    }

    if chunk_id.is_empty() || agent_id.is_empty() {
        return invalid_chunk(400, serde_json::json!({
            "ack": false, "commit": false, "status": "missing_fields",
            "message": "chunk_id and agent_id are required"
        }));
    }

    let payload_event_count = payload.get("event_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    if payload_event_count != event_count {
        return invalid_chunk(400, serde_json::json!({
            "ack": false, "commit": false, "status": "event_count_mismatch",
            "chunk_id": chunk_id,
            "declared": payload_event_count,
            "actual": event_count,
            "message": "event_count mismatch"
        }));
    }

    let payload_checksum = str_field(payload, "checksum").to_lowercase();
    if payload_checksum != checksum {
        return invalid_chunk(400, serde_json::json!({
            "ack": false, "commit": false, "status": "checksum_invalid",
            "chunk_id": chunk_id,
            "event_count": event_count,
            "message": "checksum mismatch"
        }));
    }

    ValidationResult {
        ok: true,
        status_code: 200,
        body: None,
        checksum,
        event_count,
        chunk_id,
        agent_id,
    }
}

/// Validate các required fields của một event đơn lẻ.
/// Trả về list các lỗi (rỗng = hợp lệ).
pub fn validate_event(event: &Value) -> Vec<String> {
    let mut errors = Vec::new();

    for &field in REQUIRED_EVENT_FIELDS {
        if is_blank(event.get(field)) {
            errors.push(format!("missing_{}", field));
        }
    }

    // event_id phải là số nguyên dương
    match event.get("event_id").and_then(|v| v.as_i64()) {
        Some(n) if n > 0 => {}
        _ => errors.push("invalid_event_id".to_string()),
    }

    // record_id phải là số nguyên dương
    match event.get("record_id").and_then(|v| v.as_i64()) {
        Some(n) if n > 0 => {}
        _ => errors.push("invalid_record_id".to_string()),
    }

    // timestamp phải parse được
    if let Some(ts) = event.get("timestamp").and_then(|v| v.as_str()) {
        if !ts.is_empty() && ts.parse::<chrono::DateTime<chrono::Utc>>().is_err() {
            // Thử các format khác
            if chrono::DateTime::parse_from_rfc3339(ts).is_err() {
                errors.push("invalid_timestamp".to_string());
            }
        }
    }

    errors
}

/// Enrich events với metadata từ chunk envelope.
/// Port từ enrichEvents() trong Node.js.
pub fn enrich_events(payload: &Value) -> Vec<Value> {
    let events = match payload.get("events").and_then(|e| e.as_array()) {
        Some(arr) => arr,
        None => return vec![],
    };

    let schema_version = str_field(payload, "schema_version");
    let chunk_id = str_field(payload, "chunk_id");
    let chunk_checksum = str_field(payload, "checksum");
    let sequence_number = payload.get("sequence_number")
        .and_then(|v| v.as_i64()).unwrap_or(0);

    events.iter().enumerate().map(|(index, event)| {
        let mut enriched = event.clone();
        let obj = enriched.as_object_mut().unwrap();
        let validation_errors = validate_event(event);
        let idempotency_key = event.get("idempotency_key")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| sha256_hex(&format!("{}:{}", chunk_id, index)));

        obj.insert("schema_version".to_string(), Value::String(schema_version.clone()));
        obj.insert("parser_status".to_string(), Value::String(
            if validation_errors.is_empty() { "valid" } else { "invalid" }.to_string()
        ));
        obj.insert("parser_error".to_string(), Value::String("".to_string()));
        obj.insert("validation_errors".to_string(), Value::String(validation_errors.join(",")));
        obj.insert("processing_version".to_string(), Value::String(PROCESSING_VERSION.to_string()));
        obj.insert("chunk_id".to_string(), Value::String(chunk_id.clone()));
        obj.insert("chunk_checksum".to_string(), Value::String(chunk_checksum.clone()));
        obj.insert("sequence_number".to_string(), Value::Number(sequence_number.into()));
        obj.insert("chunk_event_index".to_string(), Value::Number(index.into()));
        obj.insert("idempotency_key".to_string(), Value::String(idempotency_key));

        enriched
    }).collect()
}

/// Tính SHA-256 hex của chuỗi đầu vào.
pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn invalid_chunk(status_code: u16, body: Value) -> ValidationResult {
    ValidationResult {
        ok: false,
        status_code,
        body: Some(body),
        checksum: String::new(),
        event_count: 0,
        chunk_id: String::new(),
        agent_id: String::new(),
    }
}

fn str_field(payload: &Value, field: &str) -> String {
    payload.get(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::enrich_events;
    use serde_json::json;

    #[test]
    fn enrichment_generates_a_stable_event_key_for_replayed_chunks() {
        let payload = json!({
            "schema_version": "1.0",
            "chunk_id": "chunk-123",
            "checksum": "checksum-123",
            "sequence_number": 7,
            "events": [{ "event_id": 1, "record_id": 42 }]
        });

        let first = enrich_events(&payload);
        let replay = enrich_events(&payload);

        assert_eq!(first[0]["idempotency_key"], replay[0]["idempotency_key"]);
        assert_eq!(first[0]["idempotency_key"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn enrichment_preserves_an_agent_supplied_event_key() {
        let payload = json!({
            "chunk_id": "chunk-123",
            "events": [{
                "event_id": 1,
                "record_id": 42,
                "idempotency_key": "agent-event-key"
            }]
        });

        let enriched = enrich_events(&payload);

        assert_eq!(enriched[0]["idempotency_key"], "agent-event-key");
    }
}
