// main.rs — HostEye Shipper entry point
// Port từ: Program.cs

mod config;
mod spool;
mod sync;
mod transport;
mod util;

use config::{ShipperConfig, ShipperState};
use spool::SpoolQuotaManager;
use sync::ConfigSynchronizer;
use transport::TransportManager;
use util::{
    error::ShipperError,
    http::build_http_client,
    jitter::JitterScheduler,
    logger::FileLogger,
};

use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::time::sleep;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(code) => std::process::ExitCode::from(code),
        Err(e) => {
            eprintln!("Fatal error: {}", e);
            std::process::ExitCode::from(1u8)
        }
    }
}

async fn run() -> anyhow::Result<u8> {
    // ── Load config ──────────────────────────────────────────────────────────
    let args: Vec<String> = std::env::args().collect();
    let config_path = if args.len() > 1 {
        args[1].clone()
    } else {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
        exe_dir.join("shipper-config.json").to_string_lossy().to_string()
    };

    let initial_config = ShipperConfig::load(&config_path)?;

    std::fs::create_dir_all(&initial_config.spool_directory)?;
    std::fs::create_dir_all(&initial_config.state_directory)?;
    std::fs::create_dir_all(&initial_config.log_directory)?;

    let log_path = Path::new(&initial_config.log_directory).join("shipper.log");
    let logger   = Arc::new(FileLogger::new(&log_path.to_string_lossy()));

    let state_path = Path::new(&initial_config.state_directory).join("shipper-state.json");
    let state = ShipperState::load(&state_path.to_string_lossy())?;

    let gateway_uri = initial_config.gateway_uri.clone();
    let run_once    = initial_config.run_once;
    let startup_jitter_window = initial_config.startup_jitter_window_seconds;
    let base_backoff          = initial_config.base_backoff_seconds;
    let max_backoff           = initial_config.max_backoff_seconds;
    let enable_config_sync    = initial_config.enable_config_sync;
    let enable_ingestion_server = initial_config.enable_ingestion_server;
    let config_sync_interval  = initial_config.config_sync_interval_seconds;
    let config_sync_jitter    = initial_config.config_sync_jitter_seconds;
    let max_spool_mb          = initial_config.max_spool_size_mb;
    let spool_check_interval  = initial_config.spool_check_interval_seconds;

    logger.info(&format!(
        "HostEyeShipper starting. Config={} Spool={} Gateway={} ConfigUri={} AdmissionUri={} StartupJitter={}s NormalJitter={}s RecoveryJitter={}s",
        config_path,
        initial_config.spool_directory,
        gateway_uri,
        initial_config.config_uri,
        initial_config.admission_uri,
        initial_config.startup_jitter_window_seconds,
        initial_config.normal_jitter_window_seconds,
        initial_config.recovery_jitter_window_seconds
    ));

    // Shared state: config và state đằng sau Mutex để config_sync có thể cập nhật runtime
    let config = Arc::new(Mutex::new(initial_config));
    let state  = Arc::new(Mutex::new(state));

    // ── Build HTTP client ────────────────────────────────────────────────────
    let http = {
        let cfg = config.lock().unwrap().clone();
        build_http_client(&cfg, &logger)?
    };

    // ── Endpoint seed cho jitter deterministic ───────────────────────────────
    let endpoint_seed = std::env::var("HOSTEYE_AGENT_ID")
        .or_else(|_| std::env::var("VECTOR_AGENT_ID"))
        .unwrap_or_else(|_| {
            hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| uuid_v4())
        });

    // ── Jitter / Spool services ──────────────────────────────────────────────
    let jitter       = JitterScheduler::new();
    let spool_quota  = SpoolQuotaManager::new();

    // ── ConfigSynchronizer ───────────────────────────────────────────────────
    let config_sync = ConfigSynchronizer::new(&config, &http, &state, &logger);

    // Startup sync
    config_sync.try_sync_agent_config().await;
    state.lock().unwrap().save().ok();

    // ── Startup jitter ───────────────────────────────────────────────────────
    if startup_jitter_window > 0 {
        let startup_delay = jitter.get_startup_jitter(startup_jitter_window);
        if !startup_delay.is_zero() {
            logger.info(&format!(
                "Applying startup jitter of {:.0}s before contacting server.",
                startup_delay.as_secs_f64()
            ));
            sleep(startup_delay).await;
        }
    }

    // ── TransportManager ─────────────────────────────────────────────────────
    let transport = TransportManager::new(
        &config, &state, &http, &logger,
        &spool_quota, &jitter, &endpoint_seed,
    );

    // ── Ingestion Server (Axum) ──────────────────────────────────────────────
    let ingestion_server_loop = if enable_ingestion_server {
        let config_clone = Arc::clone(&config);
        let state_clone  = Arc::clone(&state);
        let http_clone   = http.clone();
        let logger_clone = Arc::clone(&logger);
        Some(tokio::spawn(async move {
            if let Err(e) = transport::ingest::start_ingestion_server(config_clone, state_clone, http_clone, logger_clone.clone()).await {
                logger_clone.error(&format!("Fatal error in Ingestion Server: {}", e));
            }
        }))
    } else {
        logger.info("Ingestion server disabled; running as a read-only spool mirror.");
        None
    };

    // ── Background loops ─────────────────────────────────────────────────────
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let stop_tx = Arc::new(stop_tx);

    // Spool quota background loop
    let spool_quota_loop = if max_spool_mb > 0 {
        let config_clone  = Arc::clone(&config);
        let state_clone   = Arc::clone(&state);
        let stop_clone    = Arc::clone(&stop_tx);
        let spool_interval = spool_check_interval;
        Some(tokio::spawn(async move {
            let q = SpoolQuotaManager::new();
            let dummy_logger = FileLogger::new(""); // logger không có file (stdout only) cho background
            let mut rx = stop_clone.subscribe();
            loop {
                {
                    let cfg = config_clone.lock().unwrap().clone();
                    let enforcement = q.enforce_spool_policy(&cfg, &dummy_logger);
                    if enforcement.dropped_event_count > 0 {
                        let mut shipper_state = state_clone.lock().unwrap();
                        shipper_state.dropped_event_count = shipper_state.dropped_event_count
                            .saturating_add(enforcement.dropped_event_count);                        for (key, value) in enforcement.dropped_events_by_source {
                            let count = shipper_state.dropped_events_by_source.entry(key).or_insert(0); *count = count.saturating_add(value);
                        }
                        shipper_state.unattributed_dropped_event_count = shipper_state.unattributed_dropped_event_count.saturating_add(enforcement.unattributed_dropped_event_count);
                        shipper_state.save().ok();
                    }
                }
                tokio::select! {
                    _ = sleep(std::time::Duration::from_secs(spool_interval.max(1) as u64)) => {}
                    _ = rx.changed() => { break; }
                }
            }
        }))
    } else {
        None
    };

    // Config sync background loop
    let config_sync_loop = if enable_config_sync && !run_once {
        let config_clone = Arc::clone(&config);
        let state_clone  = Arc::clone(&state);
        let stop_clone   = Arc::clone(&stop_tx);
        let http_clone   = http.clone();
        let log_path_str = log_path.to_string_lossy().to_string();
        Some(tokio::spawn(async move {
            let bg_logger   = FileLogger::new(&log_path_str);
            let cs = ConfigSynchronizer::new(&config_clone, &http_clone, &state_clone, &bg_logger);
            let jit = JitterScheduler::new();
            let mut rx = stop_clone.subscribe();
            bg_logger.info(&format!(
                "Periodic config sync loop enabled. Interval={}s Jitter={}s.",
                config_sync_interval, config_sync_jitter
            ));
            loop {
                let delay = jit.get_periodic_jitter(config_sync_interval, config_sync_jitter);
                tokio::select! {
                    _ = sleep(delay) => {
                        cs.try_sync_agent_config().await;
                        state_clone.lock().unwrap().save().ok();
                    }
                    _ = rx.changed() => { break; }
                }
            }
        }))
    } else {
        None
    };

    // ── Main spool loop ───────────────────────────────────────────────────────
    let mut attempt: u32 = 0;
    let exit_code: u8;

    loop {
        match transport.process_spool_once(attempt).await {
            Ok(true) => {
                attempt = 0;
                if run_once {
                    logger.info("RunOnce completed after one successful batch.");
                    exit_code = 0;
                    break;
                }
            }
            Ok(false) => {
                if run_once {
                    logger.info("RunOnce completed; no pending spool data.");
                    exit_code = 0;
                    break;
                }
                let check_delay = std::time::Duration::from_secs(spool_check_interval as u64);
                logger.info(&format!(
                    "Spool is empty. Sleeping for spool check interval: {:.0}s.",
                    check_delay.as_secs_f64()
                ));
                sleep(check_delay).await;
            }
            Err(ShipperError::Backpressure { status_code, retry_after_secs }) => {
                attempt += 1;
                let retry_secs = retry_after_secs.unwrap_or(0);
                let delay = if retry_secs > 0 {
                    let extra = jitter.random_u64(0, 30);
                    std::time::Duration::from_secs(retry_secs as u64 + extra)
                } else {
                    jitter.get_retry_jitter(base_backoff, max_backoff, attempt)
                };
                logger.info(&format!(
                    "Backpressure/status={}; delaying {:.0}s attempt={}.",
                    status_code, delay.as_secs_f64(), attempt
                ));
                if run_once { exit_code = 2; break; }
                sleep(delay).await;
            }
            Err(e) => {
                attempt += 1;
                let delay = jitter.get_retry_jitter(base_backoff, max_backoff, attempt);
                logger.error(&format!(
                    "Unhandled shipper error: {}; delaying {:.0}s attempt={}.",
                    e, delay.as_secs_f64(), attempt
                ));
                if run_once { exit_code = 1; break; }
                sleep(delay).await;
            }
        }
    }

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    let _ = stop_tx.send(true);
    if let Some(t) = spool_quota_loop   { let _ = t.await; }
    if let Some(t) = config_sync_loop   { let _ = t.await; }
    if let Some(task) = ingestion_server_loop { task.abort(); }

    Ok(exit_code)
}

/// Simple UUID v4 fallback khi không có hostname
fn uuid_v4() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;
    let mut h = DefaultHasher::new();
    SystemTime::now().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    format!("{:016x}", h.finish())
}
