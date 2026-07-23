// util/error.rs
// Port từ: Models/Exceptions.cs → BackpressureException → ShipperError enum

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShipperError {
    /// Backpressure từ gateway (429 / 503) — tương đương BackpressureException.
    #[error("Backpressure status={status_code}")]
    Backpressure {
        status_code:        u16,
        retry_after_secs:   Option<u32>,
    },

    /// Gateway trả về HTTP error không phải backpressure.
    #[error("Gateway error: {message}")]
    Gateway { message: String },

    /// ACK không hợp lệ hoặc mismatch.
    #[error("ACK validation failed: {message}")]
    AckValidation { message: String },

    /// Admission lease hết hạn hoặc bị từ chối.
    #[error("Upload lease invalid: {message}")]
    LeaseInvalid { message: String },

    /// Config signature verify fail.
    #[error("Config signature invalid: {message}")]
    SignatureInvalid { message: String },

    /// I/O error bọc từ std::io.
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// JSON parse/serialize error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// HTTP client error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// Generic anyhow-wrapped error.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl ShipperError {
    pub fn backpressure(status: u16, retry_after: impl Into<Option<u32>>) -> Self {
        Self::Backpressure {
            status_code:      status,
            retry_after_secs: retry_after.into(),
        }
    }

    pub fn is_backpressure(&self) -> bool {
        matches!(self, Self::Backpressure { .. } | Self::LeaseInvalid { .. })
    }
}
