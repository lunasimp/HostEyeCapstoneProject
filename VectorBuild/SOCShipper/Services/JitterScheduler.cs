using System;
using System.Security.Cryptography;

namespace SOCShipper.Services
{
    public class JitterScheduler
    {
        private readonly RandomNumberGenerator _rng = RandomNumberGenerator.Create();

        /// <summary>
        /// Tạo độ trễ khi Agent vừa khởi động (Mặc định cửa sổ 300 giây).
        /// Giải quyết vấn đề "Startup Herd" (P1).
        /// </summary>
        public TimeSpan GetStartupDelay(int windowSeconds = 300)
        {
            if (windowSeconds <= 0) return TimeSpan.Zero;
            int delaySeconds = RandomInt(0, windowSeconds);
            return TimeSpan.FromSeconds(delaySeconds);
        }

        /// <summary>
        /// Tạo khoảng thời gian ngẫu nhiên cộng trừ quanh một chu kỳ gốc.
        /// Giải quyết vấn đề "Config Storm" (P2).
        /// </summary>
        public TimeSpan GetPeriodicDelay(int baseSeconds, int jitterSeconds)
        {
            if (jitterSeconds <= 0) return TimeSpan.FromSeconds(baseSeconds);
            int offset = RandomInt(-jitterSeconds, jitterSeconds);
            int total = Math.Max(1, baseSeconds + offset);
            return TimeSpan.FromSeconds(total);
        }

        /// <summary>
        /// Exponential Backoff kèm Jitter ngẫu nhiên khi Retry.
        /// Giải quyết vấn đề "Retry Storm" (P8).
        /// Công thức: U(0, min(C, B * 2^r))
        /// </summary>
        public TimeSpan GetRetryDelay(int retryCount, int baseSeconds = 10, int capSeconds = 600)
        {
            if (retryCount < 0) retryCount = 0;
            
            // Tính B * 2^r
            // Hạn chế r tràn số (ví dụ r > 30)
            int effectiveRetry = Math.Min(retryCount, 30);
            double maxDelayForThisRetry = baseSeconds * Math.Pow(2, effectiveRetry);
            
            // Giới hạn bởi Cap C
            int effectiveCap = (int)Math.Min((double)capSeconds, maxDelayForThisRetry);
            
            int delaySeconds = RandomInt(0, effectiveCap + 1); // Cần +1 vì RandomInt loại trừ cận trên
            return TimeSpan.FromSeconds(delaySeconds);
        }

        private int RandomInt(int minInclusive, int maxExclusive)
        {
            if (maxExclusive <= minInclusive) return minInclusive;
            Span<byte> bytes = stackalloc byte[4];
            _rng.GetBytes(bytes);
            uint value = BitConverter.ToUInt32(bytes);
            long diff = (long)maxExclusive - minInclusive;
            return minInclusive + (int)(value % diff);
        }
    }
}
