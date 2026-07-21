use serde_json::Value;
use crate::worker::processor::{process_job, payload_from_job, RawChunkJob, WorkerConfig};
use crate::storage::chunk_rows::build_chunk_row;

/// Main polling loop cho Redpanda REST Proxy consumer.
///
/// Port từ main() + createConsumer/subscribe/fetchRecords/commitOffsets trong raw-chunk-worker.js.
/// Dùng Redpanda REST Proxy API (HTTP), không dùng native Kafka client.
pub async fn run(
    redpanda_proxy_url: String,
    raw_chunk_topic: String,
    worker_group: String,
    worker_instance: String,
    config: WorkerConfig,
    ch: clickhouse::Client,
    mut stop: tokio::sync::watch::Receiver<bool>,
) {
    let proxy_url = redpanda_proxy_url.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();
    let poll_timeout_ms = std::env::var("RAW_WORKER_POLL_TIMEOUT_MS")
        .ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1000);
    let poll_max_bytes = std::env::var("RAW_WORKER_POLL_MAX_BYTES")
        .ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1024 * 1024);
    let retry_delay_ms = std::env::var("RAW_WORKER_RETRY_DELAY_MS")
        .ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(5000);
    let auto_offset_reset = std::env::var("RAW_WORKER_AUTO_OFFSET_RESET")
        .unwrap_or_else(|_| "earliest".to_string());

    tracing::info!(
        group = worker_group.as_str(),
        instance = worker_instance.as_str(),
        topic = raw_chunk_topic.as_str(),
        "raw-chunk-worker starting"
    );

    // Tạo consumer (retry nếu conflict)
    loop {
        match create_consumer(&client, &proxy_url, &worker_group, &worker_instance, &auto_offset_reset).await {
            Ok(_) => break,
            Err(e) => {
                tracing::warn!("create consumer failed: {}, retrying...", e);
                // Thử delete trước rồi recreate
                let _ = delete_consumer(&client, &proxy_url, &worker_group, &worker_instance).await;
                tokio::time::sleep(tokio::time::Duration::from_millis(retry_delay_ms)).await;
            }
        }
    }

    // Subscribe vào topic
    loop {
        match subscribe(&client, &proxy_url, &worker_group, &worker_instance, &raw_chunk_topic).await {
            Ok(_) => break,
            Err(e) => {
                tracing::warn!("subscribe failed: {}, retrying...", e);
                tokio::time::sleep(tokio::time::Duration::from_millis(retry_delay_ms)).await;
            }
        }
    }

    tracing::info!("raw-chunk-worker ready, polling...");

    // Main poll loop
    loop {
        // Check stop signal
        if *stop.borrow() {
            break;
        }

        let records = match fetch_records(&client, &proxy_url, &worker_group, &worker_instance,
            poll_timeout_ms, poll_max_bytes).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("fetch records failed: {}", e);
                tokio::time::sleep(tokio::time::Duration::from_millis(retry_delay_ms)).await;
                continue;
            }
        };

        if records.is_empty() {
            // Check stop signal again before next poll
            let _ = stop.has_changed();
            continue;
        }

        for record in &records {
            let job_value = match record.get("value") {
                Some(v) => v.clone(),
                None => continue,
            };

            let offset = record.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);

            match RawChunkJob::from_value(&job_value) {
                Some(job) => {
                    if let Err(e) = process_job(&job, &config, &ch).await {
                        tracing::error!(chunk_id = job.chunk_id.as_str(), "worker process failed: {}", e);
                        // Log failed status vào ClickHouse
                        let fallback = payload_from_job(&job);
                        let row = build_chunk_row(&fallback, "worker_index_failed", false,
                            &format!("{}", e));
                        if let Ok(mut ins) = ch.insert("default.ingest_chunks") {
                            let _ = ins.write(&row).await;
                            let _ = ins.end().await;
                        }
                    }
                }
                None => {
                    tracing::warn!(offset, "skip invalid job record (cannot parse)");
                }
            }
        }

        // Commit offsets sau khi xử lý xong batch
        if let Err(e) = commit_offsets(&client, &proxy_url, &worker_group, &worker_instance).await {
            tracing::warn!("commit offsets failed: {}", e);
        }
    }

    // Cleanup consumer khi stop
    if let Err(e) = delete_consumer(&client, &proxy_url, &worker_group, &worker_instance).await {
        tracing::warn!("delete consumer failed: {}", e);
    }

    tracing::info!("raw-chunk-worker stopped");
}

// ── Redpanda REST Proxy API calls ─────────────────────────────────────────────

async fn create_consumer(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
    auto_offset_reset: &str,
) -> anyhow::Result<()> {
    let url = format!("{}/consumers/{}", proxy_url, urlencoding_encode(group));
    let body = serde_json::json!({
        "name": instance,
        "format": "json",
        "auto.offset.reset": auto_offset_reset,
        "auto.commit.enable": "false"
    });

    let resp = client
        .post(&url)
        .header("content-type", "application/vnd.kafka.v2+json")
        .header("accept", "application/vnd.kafka.v2+json")
        .json(&body)
        .send()
        .await?;

    if resp.status().as_u16() == 409 {
        anyhow::bail!("consumer already exists (conflict)");
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("create consumer {} {}: {}", group, status, text);
    }

    Ok(())
}

async fn subscribe(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
    topic: &str,
) -> anyhow::Result<()> {
    let url = format!("{}/consumers/{}/instances/{}/subscription",
        proxy_url, urlencoding_encode(group), urlencoding_encode(instance));
    let body = serde_json::json!({ "topics": [topic] });

    let resp = client
        .post(&url)
        .header("content-type", "application/vnd.kafka.v2+json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("subscribe {} {}: {}", group, status, text);
    }

    Ok(())
}

async fn fetch_records(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
    timeout_ms: u64,
    max_bytes: u64,
) -> anyhow::Result<Vec<Value>> {
    let url = format!(
        "{}/consumers/{}/instances/{}/records?timeout={}&max_bytes={}",
        proxy_url,
        urlencoding_encode(group),
        urlencoding_encode(instance),
        timeout_ms,
        max_bytes,
    );

    let resp = client
        .get(&url)
        .header("accept", "application/vnd.kafka.json.v2+json")
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("fetch records {} {}: {}", group, status, text);
    }

    let records: Vec<Value> = resp.json().await?;
    Ok(records)
}

async fn commit_offsets(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
) -> anyhow::Result<()> {
    let url = format!("{}/consumers/{}/instances/{}/offsets",
        proxy_url, urlencoding_encode(group), urlencoding_encode(instance));

    let resp = client
        .post(&url)
        .header("content-type", "application/vnd.kafka.v2+json")
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("commit offsets {} {}: {}", group, status, text);
    }

    Ok(())
}

async fn delete_consumer(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
) -> anyhow::Result<()> {
    let url = format!("{}/consumers/{}/instances/{}",
        proxy_url, urlencoding_encode(group), urlencoding_encode(instance));

    let resp = client
        .delete(&url)
        .header("content-type", "application/vnd.kafka.v2+json")
        .send()
        .await?;

    // 204 No Content hoặc 404 Not Found đều OK
    let status = resp.status().as_u16();
    if status != 204 && status != 404 && !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        anyhow::bail!("delete consumer {} {}: {}", group, status, text);
    }

    Ok(())
}

fn urlencoding_encode(s: &str) -> String {
    s.chars().map(|c| match c {
        'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u8),
    }).collect()
}
