// util/jitter.rs
// Port từ: Services/JitterScheduler.cs

use rand::Rng;
use std::time::Duration;

pub struct JitterScheduler;

impl JitterScheduler {
    pub fn new() -> Self { Self }

    /// Startup jitter ngẫu nhiên trong khoảng [0, window_seconds].
    pub fn get_startup_jitter(&self, window_seconds: i32) -> Duration {
        if window_seconds <= 0 {
            return Duration::ZERO;
        }
        Duration::from_secs(self.random_u64(0, window_seconds as u64 + 1))
    }

    /// Periodic jitter: base ± jitter. 
    /// Nếu base_seconds = 0, trả về ngẫu nhiên U(0, jitter_seconds).
    pub fn get_periodic_jitter(&self, base_seconds: i32, jitter_seconds: i32) -> Duration {
        if base_seconds == 0 {
            let secs = self.random_u64(0, jitter_seconds as u64 + 1);
            Duration::from_secs(secs)
        } else {
            let offset: i64 = if jitter_seconds > 0 {
                self.random_i64(-jitter_seconds as i64, jitter_seconds as i64)
            } else {
                0
            };
            let secs = (base_seconds as i64 + offset).max(1) as u64;
            Duration::from_secs(secs)
        }
    }

    pub fn get_recovery_jitter(&self, window_seconds: i32, attempt: u32) -> Duration {
        self.get_retry_jitter(1, window_seconds.max(1), attempt)
    }

    /// Full-jitter exponential backoff (truncated binary exponential).
    pub fn get_retry_jitter(&self, base_seconds: i32, cap_seconds: i32, attempt: u32) -> Duration {
        let exp = (2u64).saturating_pow(attempt.min(16));
        let max = (cap_seconds as u64).min(base_seconds as u64 * exp);
        Duration::from_secs(self.random_u64(0, max.max(1)))
    }

    // ── internals ──────────────────────────────

    pub fn random_u64(&self, min_inclusive: u64, max_exclusive: u64) -> u64 {
        if max_exclusive <= min_inclusive { return min_inclusive; }
        let mut rng = rand::thread_rng();
        min_inclusive + rng.gen_range(0..(max_exclusive - min_inclusive))
    }

    fn random_i64(&self, min_inclusive: i64, max_exclusive: i64) -> i64 {
        if max_exclusive <= min_inclusive { return min_inclusive; }
        let mut rng = rand::thread_rng();
        min_inclusive + rng.gen_range(0..(max_exclusive - min_inclusive))
    }
}
