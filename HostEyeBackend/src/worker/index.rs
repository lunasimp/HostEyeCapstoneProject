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
    let checkpoint_path = std::env::var("RAW_WORKER_CHECKPOINT_PATH")
        .unwrap_or_else(|_| "/var/lib/hosteye/raw_chunks/.worker-offsets.json".to_string());
    let mut checkpoints = load_checkpoints(&checkpoint_path).await;

    tracing::info!(
        group = worker_group.as_str(),
        instance = worker_instance.as_str(),
        topic = raw_chunk_topic.as_str(),
        "raw-chunk-worker starting"
    );

    // Tạo consumer (retry nếu conflict)
    establish_consumer(
        &client,
        &proxy_url,
        &worker_group,
        &worker_instance,
        &raw_chunk_topic,
        &auto_offset_reset,
        retry_delay_ms,
    ).await;

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
                tracing::warn!("consumer session is no longer usable; registering a new session");
                establish_consumer(
                    &client,
                    &proxy_url,
                    &worker_group,
                    &worker_instance,
                    &raw_chunk_topic,
                    &auto_offset_reset,
                    retry_delay_ms,
                ).await;
                continue;
            }
        };

        if records.is_empty() {
            // Check stop signal again before next poll
            let _ = stop.has_changed();
            continue;
        }

        for record in &records {
            if record_precedes_checkpoint(record, &checkpoints) {
                continue;
            }
            let job_value = match record.get("value") {
                Some(v) => v.clone(),
                None => continue,
            };

            let offset = record.get("offset").and_then(|v| v.as_i64()).unwrap_or(0);

            match RawChunkJob::from_value(&job_value) {
                Some(job) => {
                    if let Err(e) = process_job(&job, &config, &ch).await {
                        if is_missing_raw_chunk(&e) {
                            // The raw vault has a shorter retention window than Kafka in
                            // some upgraded installations. The payload cannot be recovered,
                            // so advance the consumer offset without creating endless
                            // worker_index_failed rows for an expired source object.
                            tracing::debug!(
                                chunk_id = job.chunk_id.as_str(),
                                raw_path = job.raw_path.as_str(),
                                "skip raw-chunk job whose retained source file has expired"
                            );
                            continue;
                        }
                        tracing::error!(chunk_id = job.chunk_id.as_str(), "worker process failed: {}", e);
                        // Log failed status vào ClickHouse
                        let fallback = payload_from_job(&job);
                        let row = build_chunk_row(&fallback, "worker_index_failed", false,
                            &format!("{}", e));
                        if let Err(insert_error) = crate::storage::json_rows::insert_json(
                            "default.ingest_chunks", &row
                        ).await {
                            tracing::warn!("failed to persist worker error status: {}", insert_error);
                        }
                    }
                }
                None => {
                    tracing::warn!(offset, "skip invalid job record (cannot parse)");
                }
            }
        }

        advance_checkpoints(&records, &mut checkpoints);
        if let Err(error) = persist_checkpoints(&checkpoint_path, &checkpoints).await {
            tracing::warn!("persist worker checkpoints failed: {}", error);
        }

        // Commit offsets sau khi xử lý xong batch
        if let Err(e) = commit_offsets(&client, &proxy_url, &worker_group, &worker_instance).await {
            tracing::warn!("commit offsets failed: {}", e);
            tracing::warn!("consumer commit failed; registering a new session");
            establish_consumer(
                &client,
                &proxy_url,
                &worker_group,
                &worker_instance,
                &raw_chunk_topic,
                &auto_offset_reset,
                retry_delay_ms,
            ).await;
        }
    }

    // Cleanup consumer khi stop
    if let Err(e) = delete_consumer(&client, &proxy_url, &worker_group, &worker_instance).await {
        tracing::warn!("delete consumer failed: {}", e);
    }

    tracing::info!("raw-chunk-worker stopped");
}

// ── Redpanda REST Proxy API calls ─────────────────────────────────────────────

async fn establish_consumer(
    client: &reqwest::Client,
    proxy_url: &str,
    group: &str,
    instance: &str,
    topic: &str,
    auto_offset_reset: &str,
    retry_delay_ms: u64,
) {
    loop {
        // REST Proxy invalidates the instance after its group membership expires.
        let _ = delete_consumer(client, proxy_url, group, instance).await;

        match create_consumer(client, proxy_url, group, instance, auto_offset_reset).await {
            Ok(_) => match subscribe(client, proxy_url, group, instance, topic).await {
                Ok(_) => return,
                Err(e) => tracing::warn!("subscribe failed: {}, retrying...", e),
            },
            Err(e) => tracing::warn!("create consumer failed: {}, retrying...", e),
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(retry_delay_ms)).await;
    }
}

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

type WorkerCheckpoints = std::collections::BTreeMap<String, i64>;

fn checkpoint_key(topic: &str, partition: i64) -> String {
    format!("{}:{}", topic, partition)
}

fn advance_checkpoints(records: &[Value], checkpoints: &mut WorkerCheckpoints) {
    for record in records {
        let Some(topic) = record.get("topic").and_then(Value::as_str) else { continue };
        let Some(partition) = record.get("partition").and_then(Value::as_i64) else { continue };
        let Some(offset) = record.get("offset").and_then(Value::as_i64) else { continue };
        checkpoints
            .entry(checkpoint_key(topic, partition))
            .and_modify(|current| *current = (*current).max(offset + 1))
            .or_insert(offset + 1);
    }
}

fn record_precedes_checkpoint(record: &Value, checkpoints: &WorkerCheckpoints) -> bool {
    let Some(topic) = record.get("topic").and_then(Value::as_str) else { return false };
    let Some(partition) = record.get("partition").and_then(Value::as_i64) else { return false };
    let Some(offset) = record.get("offset").and_then(Value::as_i64) else { return false };
    checkpoints
        .get(&checkpoint_key(topic, partition))
        .is_some_and(|next_offset| offset < *next_offset)
}

async fn load_checkpoints(path: &str) -> WorkerCheckpoints {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            tracing::warn!("parse worker checkpoint {} failed: {}", path, error);
            WorkerCheckpoints::new()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => WorkerCheckpoints::new(),
        Err(error) => {
            tracing::warn!("read worker checkpoint {} failed: {}", path, error);
            WorkerCheckpoints::new()
        }
    }
}

async fn persist_checkpoints(path: &str, checkpoints: &WorkerCheckpoints) -> anyhow::Result<()> {
    let temporary_path = format!("{}.tmp", path);
    let bytes = serde_json::to_vec(checkpoints)?;
    tokio::fs::write(&temporary_path, bytes).await?;
    tokio::fs::rename(&temporary_path, path).await?;
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

fn is_missing_raw_chunk(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io_error| io_error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
mod tests {
    use super::{advance_checkpoints, is_missing_raw_chunk, record_precedes_checkpoint, WorkerCheckpoints};
    use anyhow::Context;

    #[test]
    fn detects_not_found_through_anyhow_context() {
        let error = std::fs::read("definitely-missing-hosteye-test-file")
            .context("read retained raw chunk")
            .expect_err("fixture path must not exist");
        assert!(is_missing_raw_chunk(&error));
    }

    #[test]
    fn checkpoints_the_next_offset_for_each_partition() {
        let records = [
            serde_json::json!({"topic":"raw-chunk-jobs","partition":0,"offset":41}),
            serde_json::json!({"topic":"raw-chunk-jobs","partition":0,"offset":43}),
        ];
        let mut checkpoints = WorkerCheckpoints::new();
        advance_checkpoints(&records, &mut checkpoints);
        assert_eq!(checkpoints.get("raw-chunk-jobs:0"), Some(&44));
        assert!(record_precedes_checkpoint(&records[0], &checkpoints));
        assert!(record_precedes_checkpoint(&records[1], &checkpoints));
    }
}
