use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const HMAC_SHA256_ALGORITHM: &str = "hmac-sha256";
pub const ED25519_ALGORITHM: &str = "ed25519";
pub const DEFAULT_ED25519_KEY_ID: &str = "hosteye-demo-ed25519-v1";
pub const DEFAULT_DEMO_SIGNING_KEY: &str = "hosteye-dynamic-config-demo-key";

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicPolicy {
    pub policy_id: String,
    pub version: u64,
    pub name: String,
    pub enabled: bool,
    pub target: PolicyTarget,
    pub rollout: Rollout,
    pub config: HostEyeDesiredConfig,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PolicyTarget {
    Default,
    Group { group_id: String },
    Agent { agent_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rollout {
    pub enabled: bool,
    pub percent: u8,
    pub min_agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEyeDesiredConfig {
    pub config_schema_version: u32,
    pub vector: VectorConfigPatch,
    pub shipper: ShipperConfigPatch,
    pub sensors: SensorConfigPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorConfigPatch {
    pub enabled: bool,
    pub channels: Vec<String>,
    pub batch_max_events: u32,
    pub batch_timeout_secs: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShipperConfigPatch {
    pub enabled: bool,
    pub gateway_url: String,
    pub normal_jitter_window_seconds: u32,
    pub recovery_jitter_window_seconds: u32,
    pub base_backoff_seconds: u32,
    pub max_backoff_seconds: u32,
    pub max_spool_size_mb: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SensorConfigPatch {
    pub sysmon_enabled: bool,
    pub powershell_enabled: bool,
    pub network_events_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigRequest {
    pub agent_id: String,
    pub host_id: String,
    pub group_id: String,
    pub current_policy_id: Option<String>,
    pub current_version: Option<u64>,
    pub agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedConfigEnvelope {
    pub envelope_version: u32,
    pub policy_id: String,
    pub version: u64,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub agent_id: String,
    pub host_id: String,
    pub group_id: String,
    pub config_sha256: String,
    pub config: HostEyeDesiredConfig,
    pub signature_algorithm: String,
    #[serde(default)]
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigAck {
    pub agent_id: String,
    pub host_id: String,
    #[serde(default)]
    pub group_id: String,
    pub policy_id: String,
    pub version: u64,
    pub status: String,
    pub message: String,
    pub applied_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub event_id: String,
    pub event_type: String,
    pub actor: String,
    pub target: String,
    pub message: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    pub agent_id: String,
    pub host_id: String,
    pub group_id: String,
    pub last_policy_id: String,
    pub last_version: u64,
    pub last_seen_at: DateTime<Utc>,
    pub last_ack_status: String,
    pub last_ack_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlPlaneState {
    pub policies: Vec<DynamicPolicy>,
    pub agents: BTreeMap<String, AgentState>,
    #[serde(default)]
    pub audit_events: Vec<AuditEvent>,
}

impl Default for ControlPlaneState {
    fn default() -> Self {
        Self {
            policies: vec![default_policy()],
            agents: BTreeMap::new(),
            audit_events: Vec::new(),
        }
    }
}

pub fn default_policy() -> DynamicPolicy {
    DynamicPolicy {
        policy_id: "policy-default-windows-baseline".to_string(),
        version: 1,
        name: "Default Windows Endpoint Baseline".to_string(),
        enabled: true,
        target: PolicyTarget::Default,
        rollout: Rollout {
            enabled: true,
            percent: 100,
            min_agent_version: "0.1.0".to_string(),
        },
        config: HostEyeDesiredConfig {
            config_schema_version: 1,
            vector: VectorConfigPatch {
                enabled: true,
                channels: vec![
                    "Application".to_string(),
                    "System".to_string(),
                    "Security".to_string(),
                    "Microsoft-Windows-Sysmon/Operational".to_string(),
                    "Microsoft-Windows-PowerShell/Operational".to_string(),
                    "Microsoft-Windows-WMI-Activity/Operational".to_string(),
                ],
                batch_max_events: 1000,
                batch_timeout_secs: 10,
            },
            shipper: ShipperConfigPatch {
                enabled: true,
                gateway_url: "https://soc-gateway.yourcorporate.com/api/v1/telemetry".to_string(),
                normal_jitter_window_seconds: 300,
                recovery_jitter_window_seconds: 1800,
                base_backoff_seconds: 2,
                max_backoff_seconds: 300,
                max_spool_size_mb: 8192,
            },
            sensors: SensorConfigPatch {
                sysmon_enabled: true,
                powershell_enabled: true,
                network_events_enabled: true,
            },
        },
        updated_at: Utc::now(),
    }
}

pub fn select_policy<'a>(state: &'a ControlPlaneState, request: &AgentConfigRequest) -> Option<&'a DynamicPolicy> {
    let mut default = None;
    let mut group = None;
    let mut agent = None;

    for policy in state.policies.iter().filter(|policy| policy.enabled && policy.rollout.enabled) {
        match &policy.target {
            PolicyTarget::Default => default = newer(default, policy),
            PolicyTarget::Group { group_id } if group_id == &request.group_id => group = newer(group, policy),
            PolicyTarget::Agent { agent_id } if agent_id == &request.agent_id => agent = newer(agent, policy),
            _ => {}
        }
    }

    agent.or(group).or(default)
}

fn newer<'a>(current: Option<&'a DynamicPolicy>, candidate: &'a DynamicPolicy) -> Option<&'a DynamicPolicy> {
    match current {
        Some(existing) if existing.version >= candidate.version => Some(existing),
        _ => Some(candidate),
    }
}

pub fn sign_envelope(mut envelope: SignedConfigEnvelope, key: &str) -> Result<SignedConfigEnvelope> {
    envelope.signature_algorithm = HMAC_SHA256_ALGORITHM.to_string();
    envelope.config_sha256 = sha256_json(&envelope.config)?;
    envelope.signature = hmac_sha256_hex(key.as_bytes(), envelope_signing_text(&envelope).as_bytes())?;
    Ok(envelope)
}

pub fn sign_envelope_ed25519(
    mut envelope: SignedConfigEnvelope,
    key_id: &str,
    private_key_seed_hex: &str,
) -> Result<SignedConfigEnvelope> {
    envelope.signature_algorithm = ED25519_ALGORITHM.to_string();
    envelope.key_id = key_id.to_string();
    envelope.config_sha256 = sha256_json(&envelope.config)?;
    envelope.signature.clear();

    let signing_key = ed25519_signing_key_from_hex(private_key_seed_hex)?;
    let signature = signing_key.sign(envelope_signing_text(&envelope).as_bytes());
    envelope.signature = hex::encode(signature.to_bytes());
    Ok(envelope)
}

pub fn verify_envelope(envelope: &SignedConfigEnvelope, key: &str) -> Result<()> {
    verify_config_hash(envelope)?;
    if envelope.signature_algorithm != HMAC_SHA256_ALGORITHM {
        return Err(anyhow!("unsupported envelope signature algorithm: {}", envelope.signature_algorithm));
    }

    let expected = hmac_sha256_hex(key.as_bytes(), envelope_signing_text(envelope).as_bytes())?;
    if !constant_time_eq(expected.as_bytes(), envelope.signature.as_bytes()) {
        return Err(anyhow!("envelope signature mismatch"));
    }
    Ok(())
}

pub fn verify_envelope_ed25519(envelope: &SignedConfigEnvelope, public_keys: &BTreeMap<String, String>) -> Result<()> {
    verify_config_hash(envelope)?;
    if envelope.signature_algorithm != ED25519_ALGORITHM {
        return Err(anyhow!("unsupported envelope signature algorithm: {}", envelope.signature_algorithm));
    }
    if envelope.key_id.trim().is_empty() {
        return Err(anyhow!("ed25519 envelope missing key_id"));
    }

    let public_key_hex = public_keys
        .get(&envelope.key_id)
        .ok_or_else(|| anyhow!("unknown ed25519 key_id: {}", envelope.key_id))?;
    let verifying_key = ed25519_verifying_key_from_hex(public_key_hex)?;
    let signature_bytes = decode_fixed_hex::<64>(&envelope.signature, "ed25519 signature")?;
    let signature = Signature::from_bytes(&signature_bytes);
    verifying_key
        .verify(envelope_signing_text(envelope).as_bytes(), &signature)
        .map_err(|_| anyhow!("ed25519 envelope signature mismatch"))?;
    Ok(())
}

pub fn demo_ed25519_private_key_seed_hex() -> String {
    hex::encode(Sha256::digest(DEFAULT_DEMO_SIGNING_KEY.as_bytes()))
}

pub fn demo_ed25519_public_key_hex() -> Result<String> {
    ed25519_public_key_hex_from_private_seed_hex(&demo_ed25519_private_key_seed_hex())
}

pub fn ed25519_public_key_hex_from_private_seed_hex(private_key_seed_hex: &str) -> Result<String> {
    let signing_key = ed25519_signing_key_from_hex(private_key_seed_hex)?;
    Ok(hex::encode(signing_key.verifying_key().to_bytes()))
}

pub fn parse_public_key_ring(value: &str) -> Result<BTreeMap<String, String>> {
    let mut keys = BTreeMap::new();
    for entry in value.split(',').map(str::trim).filter(|entry| !entry.is_empty()) {
        let (key_id, public_key_hex) = entry
            .split_once(':')
            .ok_or_else(|| anyhow!("invalid public key entry, expected key_id:hex_public_key"))?;
        let key_id = key_id.trim();
        let public_key_hex = public_key_hex.trim();
        if key_id.is_empty() {
            return Err(anyhow!("public key entry has empty key_id"));
        }
        ed25519_verifying_key_from_hex(public_key_hex)
            .with_context(|| format!("invalid public key for key_id {key_id}"))?;
        keys.insert(key_id.to_string(), public_key_hex.to_string());
    }
    Ok(keys)
}

pub fn agent_identity_proof(secret: &str, agent_id: &str, host_id: &str, group_id: &str) -> Result<String> {
    hmac_sha256_hex(
        secret.as_bytes(),
        format!("HOSTEYE_AGENT_IDENTITY_V1\n{agent_id}\n{host_id}\n{group_id}").as_bytes(),
    )
}
pub fn sha256_json<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(key)?;
    mac.update(data);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn verify_config_hash(envelope: &SignedConfigEnvelope) -> Result<()> {
    let actual_config_sha = sha256_json(&envelope.config)?;
    if actual_config_sha != envelope.config_sha256 {
        return Err(anyhow!("config sha256 mismatch"));
    }
    Ok(())
}

fn ed25519_signing_key_from_hex(seed_hex: &str) -> Result<SigningKey> {
    let seed = decode_fixed_hex::<32>(seed_hex, "ed25519 private key seed")?;
    Ok(SigningKey::from_bytes(&seed))
}

fn ed25519_verifying_key_from_hex(public_key_hex: &str) -> Result<VerifyingKey> {
    let public_key = decode_fixed_hex::<32>(public_key_hex, "ed25519 public key")?;
    VerifyingKey::from_bytes(&public_key).map_err(|error| anyhow!("invalid ed25519 public key: {error}"))
}

fn decode_fixed_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(value.trim()).with_context(|| format!("invalid hex for {label}"))?;
    let actual = bytes.len();
    bytes
        .try_into()
        .map_err(|_| anyhow!("{label} must be {N} bytes, got {actual}"))
}

fn envelope_signing_text(envelope: &SignedConfigEnvelope) -> String {
    [
        "HOSTEYE_DYNAMIC_CONFIG_V1".to_string(),
        envelope.signature_algorithm.clone(),
        envelope.key_id.clone(),
        envelope.policy_id.clone(),
        envelope.version.to_string(),
        envelope.issued_at.to_rfc3339(),
        envelope.expires_at.to_rfc3339(),
        envelope.agent_id.clone(),
        envelope.host_id.clone(),
        envelope.group_id.clone(),
        envelope.config_sha256.clone(),
    ]
    .join("\n")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

pub fn render_vector_dynamic_toml(config: &HostEyeDesiredConfig) -> String {
    let channels = config
        .vector
        .channels
        .iter()
        .map(|channel| format!("  \"{}\"", channel.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(",\n");

    format!(
        r#"# Generated by HostEye Dynamic Config Agent.
# This file is intentionally a patch/include candidate for the endpoint pipeline.

[hosteye_dynamic]
schema_version = {schema_version}
vector_enabled = {vector_enabled}
shipper_enabled = {shipper_enabled}
sysmon_enabled = {sysmon_enabled}
powershell_enabled = {powershell_enabled}
network_events_enabled = {network_events_enabled}

[hosteye_dynamic.vector]
batch_max_events = {batch_max_events}
batch_timeout_secs = {batch_timeout_secs}
channels = [
{channels}
]

[hosteye_dynamic.shipper]
gateway_url = "{gateway_url}"
normal_jitter_window_seconds = {normal_jitter}
recovery_jitter_window_seconds = {recovery_jitter}
base_backoff_seconds = {base_backoff}
max_backoff_seconds = {max_backoff}
max_spool_size_mb = {max_spool}
"#,
        schema_version = config.config_schema_version,
        vector_enabled = config.vector.enabled,
        shipper_enabled = config.shipper.enabled,
        sysmon_enabled = config.sensors.sysmon_enabled,
        powershell_enabled = config.sensors.powershell_enabled,
        network_events_enabled = config.sensors.network_events_enabled,
        batch_max_events = config.vector.batch_max_events,
        batch_timeout_secs = config.vector.batch_timeout_secs,
        channels = channels,
        gateway_url = config.shipper.gateway_url.replace('\\', "\\\\").replace('"', "\\\""),
        normal_jitter = config.shipper.normal_jitter_window_seconds,
        recovery_jitter = config.shipper.recovery_jitter_window_seconds,
        base_backoff = config.shipper.base_backoff_seconds,
        max_backoff = config.shipper.max_backoff_seconds,
        max_spool = config.shipper.max_spool_size_mb,
    )
}



