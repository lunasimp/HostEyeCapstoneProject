// util/http.rs
// Port từ: Services/Utilities.cs — BuildHttpClient, DeriveEndpointUri, GetAgentId/HostId, JSON helpers

use crate::config::ShipperConfig;
use crate::util::logger::FileLogger;
use reqwest::{Certificate, Client, Identity};
use std::{fs, path::Path};
use url::Url;

/// Build reqwest Client với mTLS (nếu cert tồn tại) và custom CA.
/// Port từ Utilities.BuildHttpClient()
pub fn build_http_client(config: &ShipperConfig, logger: &FileLogger) -> anyhow::Result<Client> {
    let mut builder = Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .connection_verbose(false);

    // ── Client certificate (mTLS) ──
    let pfx_exists = Path::new(&config.client_identity_pfx_file).exists();
    let cert_exists = Path::new(&config.client_certificate_file).exists();
    let key_exists  = Path::new(&config.client_key_file).exists();

    if pfx_exists {
        let pfx = fs::read(&config.client_identity_pfx_file)?;
        let identity = Identity::from_pkcs12_der(&pfx, &config.client_identity_pfx_password)?;
        builder = builder.identity(identity);
        logger.info(&format!("Loaded enrolled PKCS#12 client identity: {}", config.client_identity_pfx_file));
    } else if cert_exists && key_exists {
        let cert_pem = fs::read(&config.client_certificate_file)?;
        let key_pem  = fs::read(&config.client_key_file)?;

        // Ghép cert + key thành PEM identity
        let mut identity_pem = cert_pem.clone();
        identity_pem.extend_from_slice(&key_pem);

        let identity = Identity::from_pem(&identity_pem)?;
        builder = builder.identity(identity);
        logger.info(&format!("Loaded client certificate: {}", config.client_certificate_file));
    } else {
        logger.info("WARNING: client certificate/key missing; mTLS request will likely fail.");
    }

    // ── Custom CA ──
    if Path::new(&config.ca_certificate_file).exists() {
        let ca_pem = fs::read(&config.ca_certificate_file)?;
        let ca_cert = Certificate::from_pem(&ca_pem)?;
        builder = builder.add_root_certificate(ca_cert);

        if config.allow_system_server_certificate_trust {
            // Giữ nguyên system trust + thêm custom CA
            logger.info(&format!(
                "Loaded custom CA trust: {}; AllowSystemServerCertificateTrust=true",
                config.ca_certificate_file
            ));
        } else {
            builder = builder.tls_built_in_root_certs(false);
            logger.info(&format!(
                "Loaded custom CA trust: {}; AllowSystemServerCertificateTrust=false",
                config.ca_certificate_file
            ));
        }
    }

    Ok(builder.build()?)
}

/// Derive một endpoint URI từ gateway_uri bằng cách thay path.
/// Port từ Utilities.DeriveEndpointUri()
pub fn derive_endpoint_uri(gateway_uri: &str, path: &str) -> String {
    match Url::parse(gateway_uri) {
        Ok(mut url) => {
            url.set_path(path);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => path.to_string(),
    }
}

// ── Environment helpers ──────────────────────────────────────────────────────

pub fn get_endpoint_computer_name() -> String {
    std::env::var("HOSTEYE_COMPUTER_NAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_default())
}

pub fn get_agent_id() -> String {
    std::env::var("HOSTEYE_AGENT_ID")
        .or_else(|_| std::env::var("VECTOR_AGENT_ID"))
        .unwrap_or_else(|_| hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown-agent".to_string()))
}

pub fn get_host_id() -> String {
    std::env::var("HOSTEYE_HOST_ID")
        .or_else(|_| std::env::var("VECTOR_HOST_ID"))
        .unwrap_or_else(|_| hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown-host".to_string()))
}

pub fn get_ci_id() -> String {
    std::env::var("HOSTEYE_CI_ID").unwrap_or_default()
}

// ── JSON field helpers ───────────────────────────────────────────────────────

pub fn get_json_str<'a>(obj: &'a serde_json::Value, key: &str) -> &'a str {
    obj.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

pub fn get_json_i64(obj: &serde_json::Value, key: &str) -> i64 {
    obj.get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(0)
}

pub fn get_json_f64(obj: &serde_json::Value, key: &str) -> f64 {
    obj.get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(0.0)
}

pub fn get_json_datetime(
    obj: &serde_json::Value,
    key: &str,
) -> Option<chrono::DateTime<chrono::Utc>> {
    let s = obj.get(key)?.as_str()?;
    s.parse().ok()
}

pub fn ms_to_seconds(ms: i64) -> i32 {
    if ms <= 0 { return 0; }
    ((ms as f64 / 1000.0).ceil() as i64).max(1) as i32
}
