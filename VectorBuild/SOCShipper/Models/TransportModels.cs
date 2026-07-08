using System.Text.Json.Serialization;

namespace SOCShipper.Models;

public record Batch(List<string> Lines, int Bytes, long StartByteOffset, long NextByteOffset, int StartLineOffset, int NextLineOffset);

public record QuotaFile(string FullName, bool IsSent);

public record SpoolStats(long Bytes, int FileCount, int PendingFileCount);

public record SendTiming(
    DateTimeOffset JitterPlannedAt,
    DateTimeOffset ScheduledSendAt,
    DateTimeOffset ActualSendAt,
    DateTimeOffset SendStartedAt,
    DateTimeOffset SendCompletedAt);

public record ChunkMetadata(
    string ChunkId,
    string AgentId,
    string HostId,
    string Computer,
    string SpoolFile,
    int LineOffset,
    int NextLineOffset,
    long ByteOffset,
    long NextByteOffset,
    int SequenceNumber,
    int EventCount,
    string Checksum,
    string LeaseId,
    DateTimeOffset LeaseIssuedAt,
    DateTimeOffset LeaseExpiresAt,
    int LeaseTtlSeconds,
    double MaxBatchMb,
    int MaxUploadRateKbps);

public record UploadLease(
    string LeaseId,
    DateTimeOffset IssuedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    int LeaseTtlSeconds,
    double MaxBatchMb,
    int MaxUploadRateKbps,
    bool Required)
{
    public static UploadLease Disabled() => new(
        LeaseId: "",
        IssuedAtUtc: DateTimeOffset.UtcNow,
        ExpiresAtUtc: DateTimeOffset.MaxValue,
        LeaseTtlSeconds: 0,
        MaxBatchMb: 0,
        MaxUploadRateKbps: 0,
        Required: false);
}

public class ChunkAck
{
    [JsonPropertyName("ack")]
    public bool Ack { get; set; }

    [JsonPropertyName("commit")]
    public bool Commit { get; set; }

    [JsonPropertyName("status")]
    public string Status { get; set; } = "";

    [JsonPropertyName("index_status")]
    public string IndexStatus { get; set; } = "";

    [JsonPropertyName("chunk_id")]
    public string ChunkId { get; set; } = "";

    [JsonPropertyName("checksum")]
    public string Checksum { get; set; } = "";

    [JsonPropertyName("event_count")]
    public int EventCount { get; set; }

    [JsonPropertyName("sequence_number")]
    public int SequenceNumber { get; set; }

    [JsonPropertyName("lease_id")]
    public string LeaseId { get; set; } = "";
}
