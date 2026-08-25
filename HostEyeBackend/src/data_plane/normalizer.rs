use serde_json::{Value, json};
use quick_xml::reader::Reader;
use quick_xml::events::Event as XmlEvent;

/// Server-side normalization: trích xuất các trường từ event_data_json hoặc raw_log.
/// HostEye Agent gửi raw Windows Event Log.
pub fn normalize_event(mut event: Value) -> Value {
    if !event.is_object() {
        return event;
    }

    let obj = event.as_object_mut().unwrap();
    let channel = obj.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    let event_id = obj.get("event_id").and_then(|v| v.as_u64()).unwrap_or(0);

    // Thử lấy event_data từ JSON (nếu agent đã chuyển sẵn sang JSON), hoặc từ chuỗi XML.
    let mut event_data_map = serde_json::Map::new();

    if let Some(event_data) = obj.get("event_data_json").and_then(|v| v.as_object()) {
        event_data_map = event_data.clone();
    } else if let Some(event_data_xml) = obj.get("event_data").and_then(|v| v.as_str()) {
        // Fallback parse XML đơn giản (Sysmon thường dùng EventData > Data Name="...")
        let parsed = parse_sysmon_xml(event_data_xml);
        for (k, v) in parsed {
            event_data_map.insert(k, json!(v));
        }
    }

    if event_data_map.is_empty() {
        return event;
    }

    // Trích xuất các trường quan trọng lên top-level dựa trên event_id (Sysmon)
    match event_id {
        1 => { // Process Create
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_str(&mut event_data_map, obj, "ParentProcessGuid", "parent_process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_u32(&mut event_data_map, obj, "ParentProcessId", "parent_process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "CommandLine", "command_line");
            extract_str(&mut event_data_map, obj, "ParentCommandLine", "parent_command_line");
            extract_str(&mut event_data_map, obj, "User", "user_name");
            extract_str(&mut event_data_map, obj, "Hashes", "hashes");
        },
        3 => { // Network Connection
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "SourceIp", "source_ip");
            extract_u32(&mut event_data_map, obj, "SourcePort", "source_port");
            extract_str(&mut event_data_map, obj, "DestinationIp", "destination_ip");
            extract_u32(&mut event_data_map, obj, "DestinationPort", "destination_port");
            extract_str(&mut event_data_map, obj, "Protocol", "protocol");
            extract_str(&mut event_data_map, obj, "Initiated", "initiated");
        },
        5 => { // Process Terminated
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
        },
        11 | 23 => { // File Create / Delete
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "TargetFilename", "target_filename");
        },
        12 | 13 | 14 => { // Registry
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "TargetObject", "target_object");
        },
        22 => { // DNS Query
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "QueryName", "dns_query");
            extract_str(&mut event_data_map, obj, "QueryStatus", "query_status");
        }
        _ => {
            // Các event ID khác, extract các trường common
            extract_str(&mut event_data_map, obj, "ProcessGuid", "process_guid");
            extract_u32(&mut event_data_map, obj, "ProcessId", "process_id");
            extract_str(&mut event_data_map, obj, "Image", "process_path");
            extract_str(&mut event_data_map, obj, "User", "user_name");
        }
    }

    // Đẩy lại event_data_json đã chuẩn hóa vào event
    obj.insert("event_data_json".to_string(), json!(event_data_map));

    event
}

fn extract_str(data: &mut serde_json::Map<String, Value>, obj: &mut serde_json::Map<String, Value>, src_key: &str, dest_key: &str) {
    if let Some(val) = data.get(src_key) {
        if let Some(s) = val.as_str() {
            obj.insert(dest_key.to_string(), json!(s));
        }
    }
}

fn extract_u32(data: &mut serde_json::Map<String, Value>, obj: &mut serde_json::Map<String, Value>, src_key: &str, dest_key: &str) {
    if let Some(val) = data.get(src_key) {
        if let Some(s) = val.as_str() {
            if let Ok(n) = s.parse::<u32>() {
                obj.insert(dest_key.to_string(), json!(n));
            }
        } else if let Some(n) = val.as_u64() {
            obj.insert(dest_key.to_string(), json!(n as u32));
        }
    }
}

/// Parse nhanh `<EventData><Data Name="ProcessGuid">{...}</Data>...</EventData>`
fn parse_sysmon_xml(xml: &str) -> Vec<(String, String)> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);

    let mut result = Vec::new();
    let mut current_name = String::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(XmlEvent::Start(ref e)) if e.name().as_ref() == b"Data" => {
                for attr in e.attributes().filter_map(|a| a.ok()) {
                    if attr.key.as_ref() == b"Name" {
                        if let Ok(name) = String::from_utf8(attr.value.into_owned()) {
                            current_name = name;
                        }
                    }
                }
            }
            Ok(XmlEvent::Text(e)) => {
                if !current_name.is_empty() {
                    if let Ok(text) = e.unescape() {
                        result.push((current_name.clone(), text.into_owned()));
                    }
                    current_name.clear();
                }
            }
            Ok(XmlEvent::End(ref e)) if e.name().as_ref() == b"Data" => {
                current_name.clear();
            }
            Ok(XmlEvent::Eof) => break,
            Err(_) => break,
            _ => (),
        }
        buf.clear();
    }
    result
}
