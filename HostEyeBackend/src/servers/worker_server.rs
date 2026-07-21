// worker_server.rs — HostEye Raw Chunk Worker
// Consume jobs từ Redpanda → đọc raw chunk từ disk → enrich → forward Vector

#[path = "../data_plane/mod.rs"]
mod data_plane;

#[path = "../storage/mod.rs"]
mod storage;

#[path = "../worker/mod.rs"]
mod worker;

use worker::index::run;
use worker::processor::WorkerConfig;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let redpanda_proxy_url = std::env::var("REDPANDA_PROXY_URL")
        .unwrap_or_else(|_| "http://redpanda-broker:8082".to_string());
    let raw_chunk_topic = std::env::var("RAW_CHUNK_TOPIC")
        .unwrap_or_else(|_| "raw-chunk-jobs".to_string());
    let worker_group = std::env::var("RAW_WORKER_GROUP")
        .unwrap_or_else(|_| "raw-chunk-worker".to_string());
    let worker_instance = std::env::var("RAW_WORKER_INSTANCE")
        .unwrap_or_else(|_| format!("{}-{}", hostname(), std::process::id()));
    let clickhouse_url = std::env::var("CLICKHOUSE_URL")
        .unwrap_or_else(|_| "http://clickhouse:8123".to_string());

    let ch = clickhouse::Client::default().with_url(&clickhouse_url);
    let config = WorkerConfig::from_env();

    // Channel để signal graceful shutdown
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

    // Handle SIGTERM + SIGINT cho graceful shutdown
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).unwrap();
            let mut sigint = signal(SignalKind::interrupt()).unwrap();
            tokio::select! {
                _ = sigterm.recv() => tracing::info!("SIGTERM received"),
                _ = sigint.recv() => tracing::info!("SIGINT received"),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.unwrap();
            tracing::info!("Ctrl-C received");
        }
        let _ = stop_tx.send(true);
    });

    run(redpanda_proxy_url, raw_chunk_topic, worker_group, worker_instance, config, ch, stop_rx).await;
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .unwrap_or_else(|_| "worker".to_string())
}
