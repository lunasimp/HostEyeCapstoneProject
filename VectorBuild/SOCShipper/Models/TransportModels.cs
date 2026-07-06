using System;
using System.Text.Json.Serialization;

namespace SOCShipper.Models
{
    public class PermissionRequest
    {
        [JsonPropertyName("client_id")]
        public string ClientId { get; set; } = "";

        [JsonPropertyName("queue_used_mb")]
        public double QueueUsedMb { get; set; }

        [JsonPropertyName("next_chunk_size_mb")]
        public double NextChunkSizeMb { get; set; }

        [JsonPropertyName("retry_count")]
        public int RetryCount { get; set; }

        [JsonPropertyName("rank")]
        public int Rank { get; set; }

        [JsonPropertyName("last_success_time")]
        public DateTimeOffset? LastSuccessTime { get; set; }
    }

    public class UploadLease
    {
        [JsonPropertyName("status")]
        public string Status { get; set; } = "";

        [JsonPropertyName("lease_id")]
        public string? LeaseId { get; set; }

        [JsonPropertyName("max_batch_mb")]
        public double? MaxBatchMb { get; set; }

        [JsonPropertyName("max_upload_rate_kbps")]
        public int? MaxUploadRateKbps { get; set; }

        [JsonPropertyName("lease_ttl_seconds")]
        public int? LeaseTtlSeconds { get; set; }

        [JsonPropertyName("retry_after_seconds")]
        public int? RetryAfterSeconds { get; set; }

        [JsonPropertyName("reason")]
        public string? Reason { get; set; }
    }
}
