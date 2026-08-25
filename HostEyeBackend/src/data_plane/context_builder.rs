use serde_json::Value;
use serde::Deserialize;
use clickhouse::Row;
use tokio::time::{sleep, Duration};

use crate::storage::context_edge_rows::{build_context_edge, ContextEdgeRow};

#[derive(Debug, Row, Deserialize)]
struct ParentProcessQueryRow {
    idempotency_key: String,
    process_guid: String,
}

/// Chạy Context Builder cho một event (ví dụ Sysmon EID 1, 3).
/// Delay 1 chút (e.g. 5s) để đảm bảo Vector đã ghi log xuống ClickHouse (Eventual Consistency).
pub async fn build_context(event: Value, ch: clickhouse::Client) {
    let event_id = event.get("event_id").and_then(|v| v.as_u64()).unwrap_or(0);
    let channel = event.get("channel").and_then(|v| v.as_str()).unwrap_or("");
    
    // Chỉ xử lý Sysmon cho việc tạo context đồ thị
    if channel != "Microsoft-Windows-Sysmon/Operational" {
        return;
    }

    match event_id {
        1 => build_process_child_edge(event, ch).await,
        3 => build_process_network_edge(event, ch).await,
        11 | 23 => build_process_file_edge(event, ch).await,
        12 | 13 | 14 => build_process_registry_edge(event, ch).await,
        _ => {}
    }
}

async fn build_process_child_edge(event: Value, ch: clickhouse::Client) {
    // Với EID 1 (Process Create), tạo liên kết giữa process_guid và parent_process_guid.
    // Lấy thông tin từ event
    let computer = event.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    let target_event_key = event.get("idempotency_key").and_then(|v| v.as_str()).unwrap_or("");
    let target_guid = event.get("process_guid").and_then(|v| v.as_str()).unwrap_or("");
    let source_guid = event.get("parent_process_guid").and_then(|v| v.as_str()).unwrap_or("");
    
    if source_guid.is_empty() || target_guid.is_empty() || target_event_key.is_empty() {
        return;
    }
    
    let timestamp_str = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    
    // Đợi Vector persist (ví dụ Vector batch interval 1-2s + độ trễ ClickHouse)
    sleep(Duration::from_secs(5)).await;
    
    // Query ngược ClickHouse để tìm idempotency_key của Parent Process (source)
    let query = format!(
        "SELECT idempotency_key, process_guid \
         FROM default.windows_system_logs FINAL \
         WHERE computer = ? AND process_guid = ? AND event_id = 1 \
         ORDER BY timestamp DESC LIMIT 1"
    );
    
    let source_event_key = match ch.query(&query)
        .bind(computer)
        .bind(source_guid)
        .fetch::<ParentProcessQueryRow>()
    {
        Ok(mut cursor) => {
            if let Ok(Some(row)) = cursor.next().await {
                row.idempotency_key
            } else {
                tracing::debug!("ContextBuilder: Parent process {} not found yet for child {}", source_guid, target_guid);
                String::new()
            }
        },
        Err(e) => {
            tracing::warn!("ContextBuilder: Failed to query parent process: {}", e);
            String::new()
        }
    };
    
    // Ghi edge dù có tìm thấy cha hay không (nếu không thấy, source_event_key rỗng, nhưng vẫn có source_guid)
    let edge = build_context_edge(
        "process_child",
        &source_event_key,
        target_event_key,
        source_guid,
        target_guid,
        computer,
        &format!("Child process spawned at {}", timestamp_str),
    );
    
    ch_insert_edge(&ch, edge).await;
}

async fn build_process_network_edge(event: Value, ch: clickhouse::Client) {
    let computer = event.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    let target_event_key = event.get("idempotency_key").and_then(|v| v.as_str()).unwrap_or("");
    let source_guid = event.get("process_guid").and_then(|v| v.as_str()).unwrap_or("");
    let timestamp_str = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let dest_ip = event.get("destination_ip").and_then(|v| v.as_str()).unwrap_or("");
    let dest_port = event.get("destination_port").and_then(|v| v.as_u64()).unwrap_or(0);
    
    if source_guid.is_empty() || target_event_key.is_empty() || dest_ip.is_empty() {
        return;
    }
    
    sleep(Duration::from_secs(5)).await;
    
    // Query process cha để lấy event_key
    let query = format!(
        "SELECT idempotency_key, process_guid \
         FROM default.windows_system_logs FINAL \
         WHERE computer = ? AND process_guid = ? AND event_id = 1 \
         ORDER BY timestamp DESC LIMIT 1"
    );
    
    let source_event_key = match ch.query(&query)
        .bind(computer)
        .bind(source_guid)
        .fetch::<ParentProcessQueryRow>()
    {
        Ok(mut cursor) => {
            if let Ok(Some(row)) = cursor.next().await {
                row.idempotency_key
            } else {
                String::new()
            }
        },
        Err(_) => String::new()
    };
    
    let edge = build_context_edge(
        "process_network",
        &source_event_key,
        target_event_key,
        source_guid,
        "", // Network events không có target process guid (mà là remote IP)
        computer,
        &format!("Connection to {}:{} at {}", dest_ip, dest_port, timestamp_str),
    );
    
    ch_insert_edge(&ch, edge).await;
}

async fn build_process_file_edge(event: Value, ch: clickhouse::Client) {
    let computer = event.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    let target_event_key = event.get("idempotency_key").and_then(|v| v.as_str()).unwrap_or("");
    let source_guid = event.get("process_guid").and_then(|v| v.as_str()).unwrap_or("");
    let timestamp_str = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let target_file = event.get("target_filename").and_then(|v| v.as_str()).unwrap_or("");
    
    if source_guid.is_empty() || target_event_key.is_empty() {
        return;
    }
    
    sleep(Duration::from_secs(5)).await;
    
    let query = format!(
        "SELECT idempotency_key, process_guid \
         FROM default.windows_system_logs FINAL \
         WHERE computer = ? AND process_guid = ? AND event_id = 1 \
         ORDER BY timestamp DESC LIMIT 1"
    );
    
    let source_event_key = match ch.query(&query)
        .bind(computer)
        .bind(source_guid)
        .fetch::<ParentProcessQueryRow>()
    {
        Ok(mut cursor) => {
            if let Ok(Some(row)) = cursor.next().await {
                row.idempotency_key
            } else {
                String::new()
            }
        },
        Err(_) => String::new()
    };
    
    let edge = build_context_edge(
        "process_file",
        &source_event_key,
        target_event_key,
        source_guid,
        "", 
        computer,
        &format!("File operation on {} at {}", target_file, timestamp_str),
    );
    
    ch_insert_edge(&ch, edge).await;
}

async fn build_process_registry_edge(event: Value, ch: clickhouse::Client) {
    let computer = event.get("computer").and_then(|v| v.as_str()).unwrap_or("");
    let target_event_key = event.get("idempotency_key").and_then(|v| v.as_str()).unwrap_or("");
    let source_guid = event.get("process_guid").and_then(|v| v.as_str()).unwrap_or("");
    let timestamp_str = event.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
    let target_obj = event.get("target_object").and_then(|v| v.as_str()).unwrap_or("");
    
    if source_guid.is_empty() || target_event_key.is_empty() {
        return;
    }
    
    sleep(Duration::from_secs(5)).await;
    
    let query = format!(
        "SELECT idempotency_key, process_guid \
         FROM default.windows_system_logs FINAL \
         WHERE computer = ? AND process_guid = ? AND event_id = 1 \
         ORDER BY timestamp DESC LIMIT 1"
    );
    
    let source_event_key = match ch.query(&query)
        .bind(computer)
        .bind(source_guid)
        .fetch::<ParentProcessQueryRow>()
    {
        Ok(mut cursor) => {
            if let Ok(Some(row)) = cursor.next().await {
                row.idempotency_key
            } else {
                String::new()
            }
        },
        Err(_) => String::new()
    };
    
    let edge = build_context_edge(
        "process_registry",
        &source_event_key,
        target_event_key,
        source_guid,
        "", 
        computer,
        &format!("Registry operation on {} at {}", target_obj, timestamp_str),
    );
    
    ch_insert_edge(&ch, edge).await;
}

async fn ch_insert_edge(_ch: &clickhouse::Client, row: ContextEdgeRow) {
    if let Err(e) = crate::storage::json_rows::insert_json("default.context_edges", &row).await {
        tracing::warn!("ContextBuilder: ClickHouse JSONEachRow insert failed: {}", e);
    }
}
