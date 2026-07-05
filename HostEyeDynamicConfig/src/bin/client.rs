use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use hosteye_dynamic_config::{
    agent_identity_proof, demo_ed25519_public_key_hex, parse_public_key_ring, render_vector_dynamic_toml, verify_envelope,
    verify_envelope_ed25519, ConfigAck, SignedConfigEnvelope, DEFAULT_ED25519_KEY_ID, ED25519_ALGORITHM,
    HMAC_SHA256_ALGORITHM,
};
use reqwest::StatusCode;
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::Duration};
use tokio::{fs, process::Command, time::sleep};

#[tokio::main]
async fn main() -> Result<()> {
    let settings = ClientSettings::from_env()?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(settings.request_timeout_seconds))
        .build()?;

    loop {
        match poll_once(&http, &settings).await {
            Ok(applied) => {
                if applied {
                    if settings.apply_mode == ApplyMode::RenderOnly {
                        println!("HostEye dynamic config rendered successfully.");
                    } else {
                        println!("HostEye dynamic config applied successfully.");
                    }
                } else {
                    println!("HostEye dynamic config unchanged.");
                }
            }
            Err(error) => {
                eprintln!("HostEye dynamic config poll failed: {error:#}");
                if settings.once {
                    return Err(error.context("HostEye dynamic config one-shot failed"));
                }
            }
        }

        if settings.once {
            break;
        }
        sleep(Duration::from_secs(settings.poll_interval_seconds)).await;
    }

    Ok(())
}

fn verify_signed_config(envelope: &SignedConfigEnvelope, settings: &ClientSettings) -> Result<()> {
    match envelope.signature_algorithm.as_str() {
        ED25519_ALGORITHM => verify_envelope_ed25519(envelope, &settings.ed25519_public_keys),
        HMAC_SHA256_ALGORITHM => verify_envelope(envelope, &settings.signing_key),
        other => Err(anyhow!("unsupported envelope signature algorithm: {other}")),
    }
}

fn add_agent_identity_headers(
    request: reqwest::RequestBuilder,
    settings: &ClientSettings,
) -> Result<reqwest::RequestBuilder> {
    let proof = agent_identity_proof(
        &settings.agent_identity_secret,
        &settings.agent_id,
        &settings.host_id,
        &settings.group_id,
    )?;
    Ok(request
        .header("x-hosteye-agent-id", &settings.agent_id)
        .header("x-hosteye-host-id", &settings.host_id)
        .header("x-hosteye-group-id", &settings.group_id)
        .header("x-hosteye-agent-proof", proof))
}

fn public_key_ring_from_env() -> Result<BTreeMap<String, String>> {
    let configured = env("HOSTEYE_DYNAMIC_CONFIG_ED25519_PUBLIC_KEYS", "");
    if !configured.trim().is_empty() {
        return parse_public_key_ring(&configured);
    }

    let mut keys = BTreeMap::new();
    keys.insert(DEFAULT_ED25519_KEY_ID.to_string(), demo_ed25519_public_key_hex()?);
    Ok(keys)
}
async fn poll_once(http: &reqwest::Client, settings: &ClientSettings) -> Result<bool> {
    fs::create_dir_all(&settings.output_dir).await?;
    fs::create_dir_all(&settings.backup_dir).await?;

    let state = load_client_state(&settings.state_path).await.unwrap_or_default();
    let url = format!(
        "{}/api/v1/dynamic-config/agents/{}/config?host_id={}&group_id={}&agent_version={}&current_policy_id={}&current_version={}",
        settings.server_url.trim_end_matches('/'),
        url_component(&settings.agent_id),
        url_component(&settings.host_id),
        url_component(&settings.group_id),
        url_component(&settings.agent_version),
        url_component(&state.policy_id),
        state.version
    );

    let response = add_agent_identity_headers(http.get(url), settings)?.send().await?;
    if response.status() == StatusCode::NOT_MODIFIED {
        return Ok(false);
    }
    if !response.status().is_success() {
        return Err(anyhow!("server returned {}", response.status()));
    }

    let envelope = response.json::<SignedConfigEnvelope>().await?;
    verify_signed_config(&envelope, settings)?;
    if envelope.agent_id != settings.agent_id || envelope.host_id != settings.host_id {
        return Err(anyhow!("envelope identity mismatch"));
    }

    match apply_envelope(settings, &envelope).await {
        Ok(report) => {
            let new_state = ClientState {
                policy_id: envelope.policy_id.clone(),
                version: envelope.version,
            };
            atomic_write_json(&settings.state_path, &new_state).await?;

            let ack_status = if settings.apply_mode == ApplyMode::RenderOnly {
                "rendered"
            } else {
                "applied"
            };

            send_ack(
                http,
                settings,
                &envelope,
                ack_status,
                &format!(
                    "{}; backup={}; files={}",
                    report.message,
                    report.backup_dir.display(),
                    report.applied_files.join(",")
                ),
            )
            .await?;
            Ok(true)
        }
        Err(error) => {
            let message = format!("Phase 3 apply failed: {error:#}");
            let _ = send_ack(http, settings, &envelope, "apply_failed", &message).await;
            Err(anyhow!(message))
        }
    }
}

async fn apply_envelope(settings: &ClientSettings, envelope: &SignedConfigEnvelope) -> Result<ApplyReport> {
    validate_desired_config(envelope)?;

    let staging_dir = settings.output_dir.join("staging").join(format!(
        "{}-{}-{}",
        safe_path_part(&envelope.policy_id),
        envelope.version,
        Utc::now().format("%Y%m%d%H%M%S")
    ));
    fs::create_dir_all(&staging_dir).await?;

    let staged_policy = staging_dir.join("applied-policy.json");
    let staged_vector = staging_dir.join("vector-dynamic.toml");
    fs::write(&staged_policy, serde_json::to_vec_pretty(envelope)?).await?;
    fs::write(&staged_vector, render_vector_dynamic_toml(&envelope.config)).await?;

    run_validation_commands(settings, &staged_policy, &staged_vector, "pre").await?;

    if settings.apply_mode == ApplyMode::RenderOnly {
        atomic_replace(&staged_policy, &settings.policy_path).await?;
        atomic_replace(&staged_vector, &settings.vector_dynamic_path).await?;
        return Ok(ApplyReport {
            backup_dir: settings.backup_dir.clone(),
            applied_files: vec![
                settings.policy_path.display().to_string(),
                settings.vector_dynamic_path.display().to_string(),
            ],
            message: "Rendered config only; service files were not modified".to_string(),
        });
    }

    let backup_dir = create_backup(settings).await?;
    let apply_result = async {
        atomic_replace(&staged_policy, &settings.policy_path).await?;
        atomic_replace(&staged_vector, &settings.vector_dynamic_path).await?;
        run_validation_commands(settings, &settings.policy_path, &settings.vector_dynamic_path, "post").await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = apply_result {
        rollback_from_backup(settings, &backup_dir).await?;
        return Err(anyhow!("{}; rollback restored previous config from {}", error, backup_dir.display()));
    }

    Ok(ApplyReport {
        backup_dir,
        applied_files: vec![
            settings.policy_path.display().to_string(),
            settings.vector_dynamic_path.display().to_string(),
        ],
        message: "Atomic apply completed".to_string(),
    })
}

fn validate_desired_config(envelope: &SignedConfigEnvelope) -> Result<()> {
    let config = &envelope.config;
    if envelope.expires_at <= Utc::now() {
        return Err(anyhow!("signed config envelope expired"));
    }
    if config.config_schema_version != 1 {
        return Err(anyhow!("unsupported config_schema_version={}", config.config_schema_version));
    }
    if config.vector.enabled && config.vector.channels.is_empty() {
        return Err(anyhow!("vector.channels must not be empty when vector is enabled"));
    }
    if config.vector.batch_max_events == 0 || config.vector.batch_max_events > 50_000 {
        return Err(anyhow!("vector.batch_max_events is outside allowed range 1..50000"));
    }
    if config.vector.batch_timeout_secs == 0 || config.vector.batch_timeout_secs > 3600 {
        return Err(anyhow!("vector.batch_timeout_secs is outside allowed range 1..3600"));
    }
    if config.shipper.enabled {
        let parsed = reqwest::Url::parse(&config.shipper.gateway_url)
            .with_context(|| format!("invalid shipper.gateway_url={}", config.shipper.gateway_url))?;
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err(anyhow!("shipper.gateway_url must use http or https"));
        }
    }
    if config.shipper.max_spool_size_mb == 0 || config.shipper.max_spool_size_mb > 1024 * 1024 {
        return Err(anyhow!("shipper.max_spool_size_mb is outside allowed range"));
    }
    if config.shipper.base_backoff_seconds > config.shipper.max_backoff_seconds {
        return Err(anyhow!("shipper.base_backoff_seconds must be <= max_backoff_seconds"));
    }
    Ok(())
}

async fn create_backup(settings: &ClientSettings) -> Result<PathBuf> {
    let backup_dir = settings.backup_dir.join(Utc::now().format("%Y%m%d%H%M%S").to_string());
    fs::create_dir_all(&backup_dir).await?;
    backup_file_if_exists(&settings.policy_path, &backup_dir.join("applied-policy.json")).await?;
    backup_file_if_exists(&settings.vector_dynamic_path, &backup_dir.join("vector-dynamic.toml")).await?;
    Ok(backup_dir)
}

async fn backup_file_if_exists(source: &Path, destination: &Path) -> Result<()> {
    if fs::metadata(source).await.is_ok() {
        fs::copy(source, destination).await.with_context(|| {
            format!("failed to backup {} to {}", source.display(), destination.display())
        })?;
    }
    Ok(())
}

async fn rollback_from_backup(settings: &ClientSettings, backup_dir: &Path) -> Result<()> {
    restore_or_remove(&backup_dir.join("applied-policy.json"), &settings.policy_path).await?;
    restore_or_remove(&backup_dir.join("vector-dynamic.toml"), &settings.vector_dynamic_path).await?;
    Ok(())
}

async fn restore_or_remove(backup: &Path, target: &Path) -> Result<()> {
    if fs::metadata(backup).await.is_ok() {
        atomic_replace(backup, target).await?;
    } else if fs::metadata(target).await.is_ok() {
        fs::remove_file(target).await?;
    }
    Ok(())
}

async fn atomic_write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write_bytes(path, &bytes).await
}

async fn atomic_replace(source: &Path, target: &Path) -> Result<()> {
    let bytes = fs::read(source).await?;
    atomic_write_bytes(target, &bytes).await
}

async fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|value| value.to_str()).unwrap_or("hosteye")
    ));
    fs::write(&tmp, bytes).await?;
    if fs::metadata(path).await.is_ok() {
        let _ = fs::remove_file(path).await;
    }
    fs::rename(&tmp, path).await.with_context(|| {
        format!("failed to atomically replace {} with {}", path.display(), tmp.display())
    })?;
    Ok(())
}

async fn run_validation_commands(
    settings: &ClientSettings,
    policy_path: &Path,
    vector_dynamic_path: &Path,
    stage: &str,
) -> Result<()> {
    let commands = if stage == "pre" {
        &settings.pre_validate_commands
    } else {
        &settings.post_validate_commands
    };

    for command in commands {
        run_shell_command(
            &command
                .replace("{policy}", &quote_path(policy_path))
                .replace("{vector_dynamic}", &quote_path(vector_dynamic_path))
                .replace("{output_dir}", &quote_path(&settings.output_dir)),
        )
        .await
        .with_context(|| format!("{stage}-apply validation command failed: {command}"))?;
    }
    Ok(())
}

async fn run_shell_command(command: &str) -> Result<()> {
    let status = if cfg!(windows) {
        Command::new("cmd").arg("/C").arg(command).status().await?
    } else {
        Command::new("sh").arg("-c").arg(command).status().await?
    };
    if !status.success() {
        return Err(anyhow!("command exited with {status}: {command}"));
    }
    Ok(())
}

async fn send_ack(
    http: &reqwest::Client,
    settings: &ClientSettings,
    envelope: &SignedConfigEnvelope,
    status: &str,
    message: &str,
) -> Result<()> {
    let ack = ConfigAck {
        agent_id: settings.agent_id.clone(),
        host_id: settings.host_id.clone(),
        group_id: settings.group_id.clone(),
        policy_id: envelope.policy_id.clone(),
        version: envelope.version,
        status: status.to_string(),
        message: message.to_string(),
        applied_at: Utc::now(),
    };

    let ack_url = format!(
        "{}/api/v1/dynamic-config/agents/{}/ack",
        settings.server_url.trim_end_matches('/'),
        url_component(&settings.agent_id)
    );
    let ack_response = add_agent_identity_headers(http.post(ack_url), settings)?.json(&ack).send().await?;
    if !ack_response.status().is_success() {
        return Err(anyhow!("ack failed with {}", ack_response.status()));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyMode {
    Apply,
    RenderOnly,
}

#[derive(Debug)]
struct ClientSettings {
    server_url: String,
    signing_key: String,
    ed25519_public_keys: BTreeMap<String, String>,
    agent_identity_secret: String,
    agent_id: String,
    host_id: String,
    group_id: String,
    agent_version: String,
    output_dir: PathBuf,
    policy_path: PathBuf,
    vector_dynamic_path: PathBuf,
    backup_dir: PathBuf,
    state_path: PathBuf,
    apply_mode: ApplyMode,
    pre_validate_commands: Vec<String>,
    post_validate_commands: Vec<String>,
    poll_interval_seconds: u64,
    request_timeout_seconds: u64,
    once: bool,
}

impl ClientSettings {
    fn from_env() -> Result<Self> {
        let output_dir = PathBuf::from(env("HOSTEYE_CONFIG_OUTPUT_DIR", "./out/agent-config"));
        let state_path = PathBuf::from(env(
            "HOSTEYE_CONFIG_STATE_PATH",
            output_dir.join("state.json").to_string_lossy().as_ref(),
        ));
        let policy_path = PathBuf::from(env(
            "HOSTEYE_APPLIED_POLICY_PATH",
            output_dir.join("applied-policy.json").to_string_lossy().as_ref(),
        ));
        let vector_dynamic_path = PathBuf::from(env(
            "HOSTEYE_VECTOR_DYNAMIC_PATH",
            output_dir.join("vector-dynamic.toml").to_string_lossy().as_ref(),
        ));
        let backup_dir = PathBuf::from(env(
            "HOSTEYE_CONFIG_BACKUP_DIR",
            output_dir.join("backups").to_string_lossy().as_ref(),
        ));
        let ed25519_public_keys = public_key_ring_from_env()?;
        Ok(Self {
            server_url: env("HOSTEYE_CONFIG_SERVER_URL", "http://127.0.0.1:5063"),
            signing_key: env("HOSTEYE_DYNAMIC_CONFIG_SIGNING_KEY", "hosteye-dynamic-config-demo-key"),
            ed25519_public_keys,
            agent_identity_secret: env("HOSTEYE_DYNAMIC_CONFIG_AGENT_IDENTITY_SECRET", "hosteye-agent-identity-demo-secret"),
            agent_id: env("HOSTEYE_AGENT_ID", "agent-demo-001"),
            host_id: env("HOSTEYE_HOST_ID", "host-demo-001"),
            group_id: env("HOSTEYE_GROUP_ID", "group-lab"),
            agent_version: env("HOSTEYE_AGENT_VERSION", "0.1.0"),
            output_dir,
            policy_path,
            vector_dynamic_path,
            backup_dir,
            state_path,
            apply_mode: match env("HOSTEYE_CONFIG_APPLY_MODE", "apply").to_lowercase().as_str() {
                "render" | "render_only" | "dry_run" => ApplyMode::RenderOnly,
                _ => ApplyMode::Apply,
            },
            pre_validate_commands: split_commands(&env("HOSTEYE_CONFIG_PRE_VALIDATE_CMDS", "")),
            post_validate_commands: split_commands(&env("HOSTEYE_CONFIG_POST_VALIDATE_CMDS", "")),
            poll_interval_seconds: env("HOSTEYE_CONFIG_POLL_SECONDS", "60").parse().unwrap_or(60),
            request_timeout_seconds: env("HOSTEYE_CONFIG_REQUEST_TIMEOUT_SECONDS", "15")
                .parse()
                .unwrap_or(15),
            once: env("HOSTEYE_CONFIG_ONCE", "true").eq_ignore_ascii_case("true"),
        })
    }
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct ClientState {
    #[serde(default)]
    policy_id: String,
    #[serde(default)]
    version: u64,
}

#[derive(Debug)]
struct ApplyReport {
    backup_dir: PathBuf,
    applied_files: Vec<String>,
    message: String,
}

async fn load_client_state(path: &PathBuf) -> Result<ClientState> {
    let bytes = fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

fn split_commands(value: &str) -> Vec<String> {
    value
        .split(";;")
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn quote_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('"', "\\\"");
    format!("\"{value}\"")
}

fn safe_path_part(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') { ch } else { '_' })
        .collect::<String>()
        .chars()
        .take(96)
        .collect()
}

fn url_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}







