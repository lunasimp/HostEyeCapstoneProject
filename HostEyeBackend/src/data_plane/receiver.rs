use axum::http::HeaderMap;

/// Context được extract từ các Nginx-injected headers cho mỗi telemetry request.
/// Nginx thực hiện mTLS termination và forward thông tin cert dưới dạng headers.
#[derive(Debug, Clone)]
pub struct IngestContext {
    /// ID của collector (từ route param hoặc env COLLECTOR_ID)
    pub collector_id: String,
    /// Cert serial của agent client (header: X-Client-Cert-Serial)
    /// Được Nginx set từ $ssl_client_serial sau khi verify mTLS
    pub cert_serial: String,
    /// Distinguished Name của cert subject (header: X-Client-Cert-Subject)
    pub cert_subject: String,
    /// True nếu Nginx đã verify cert thành công (header: X-Client-Verify == "SUCCESS")
    pub cert_verified: bool,
    /// IP thực của client agent (header: X-Real-IP)
    pub client_ip: String,
}

/// Extract IngestContext từ Axum HeaderMap.
/// Tất cả headers đều được Nginx inject — backend không cần verify lại,
/// vì Nginx đã enforce mTLS trước khi forward request.
pub fn extract_context(headers: &HeaderMap, collector_id: &str) -> IngestContext {
    let cert_verify_value = header_str(headers, "x-client-verify");
    IngestContext {
        collector_id: collector_id.to_string(),
        cert_serial: header_str(headers, "x-client-cert-serial"),
        cert_subject: header_str(headers, "x-client-cert-subject"),
        cert_verified: cert_verify_value == "SUCCESS",
        client_ip: header_str(headers, "x-real-ip"),
    }
}

/// Lấy giá trị header dạng String, trả về chuỗi rỗng nếu không có.
fn header_str(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}
