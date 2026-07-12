// util/crypto.rs
// Port từ: Services/Utilities.cs — Sha256Hex, HmacSha256Hex, FixedTimeEqualsHex

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// SHA-256 hex của UTF-8 string — tương đương Utilities.Sha256Hex()
pub fn sha256_hex(value: &str) -> String {
    let hash = Sha256::digest(value.as_bytes());
    hex::encode(hash)
}

/// HMAC-SHA256 hex — tương đương Utilities.HmacSha256Hex()
pub fn hmac_sha256_hex(key: &str, value: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(value.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time hex compare — tương đương Utilities.FixedTimeEqualsHex()
pub fn fixed_time_equals_hex(left: &str, right: &str) -> bool {
    match (hex::decode(left), hex::decode(right)) {
        (Ok(l), Ok(r)) => {
            if l.len() != r.len() { return false; }
            // XOR compare — constant time
            l.iter().zip(r.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
        }
        _ => false,
    }
}
