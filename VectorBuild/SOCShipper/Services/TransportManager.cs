using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using SOCShipper.Models;

namespace SOCShipper.Services;

public class TransportManager
{
    private readonly ShipperConfig _config;
    private readonly ShipperState _state;
    private readonly HttpClient _http;
    private readonly FileLogger _logger;
    private readonly AdmissionClient _admissionClient;
    private readonly SpoolQuotaManager _spoolQuotaManager;
    private readonly JitterScheduler _jitterScheduler;
    private readonly string _endpointSeed;

    public TransportManager(
        ShipperConfig config, 
        ShipperState state, 
        HttpClient http, 
        FileLogger logger, 
        AdmissionClient admissionClient, 
        SpoolQuotaManager spoolQuotaManager, 
        JitterScheduler jitterScheduler, 
        string endpointSeed)
    {
        _config = config;
        _state = state;
        _http = http;
        _logger = logger;
        _admissionClient = admissionClient;
        _spoolQuotaManager = spoolQuotaManager;
        _jitterScheduler = jitterScheduler;
        _endpointSeed = endpointSeed;
    }

    public async Task<bool> ProcessSpoolOnceAsync(int retryAttempt)
    {
        var files = Directory.GetFiles(_config.SpoolDirectory, "*.ndjson")
            .OrderBy(File.GetCreationTimeUtc)
            .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var spoolStats = _spoolQuotaManager.GetSpoolStats(_config.SpoolDirectory);

        foreach (var file in files)
        {
            var checkpoint = _state.GetCheckpoint(file);
            var startByteOffset = ResolveStartByteOffset(file, checkpoint);
            
            var fileLength = new FileInfo(file).Length;
            if (fileLength == 0 || startByteOffset >= fileLength)
            {
                TryArchiveEmptyOrFullyReadFile(file, startByteOffset);
                continue;
            }

            var jitterPlannedAt = DateTimeOffset.UtcNow;
            var (sendDelay, jitterWindow) = _jitterScheduler.GetSendDelay(file, startByteOffset, _endpointSeed, _config.NormalJitterWindowSeconds, _config.RecoveryJitterWindowSeconds);
            var scheduledSendAt = jitterPlannedAt.Add(sendDelay);
            if (sendDelay > TimeSpan.Zero)
            {
                _logger.Info($"Applying deterministic send jitter {sendDelay.TotalSeconds}s for {Path.GetFileName(file)} byte_offset={startByteOffset}.");
                await Task.Delay(sendDelay);
            }
            var actualSendAt = DateTimeOffset.UtcNow;
            var jitter = (int)sendDelay.TotalSeconds;

            var requestedChunkSizeMb = _config.MaxBytes / 1024d / 1024d;
            var lease = await _admissionClient.TryRequestAdmissionAsync(requestedChunkSizeMb, spoolStats, retryAttempt);
            
            var allowedBytes = lease.MaxBatchMb > 0 ? (int)Math.Min(_config.MaxBytes, lease.MaxBatchMb.Value * 1024 * 1024) : _config.MaxBytes;
            var batch = ReadBatch(file, checkpoint.LineOffset, startByteOffset, _config.MaxEvents, allowedBytes);
            
            if (batch.Lines.Count == 0)
            {
                TryArchiveEmptyOrFullyReadFile(file, batch.NextByteOffset);
                continue;
            }

            _admissionClient.EnsureUploadLeaseUsable(lease);

            var payload = BuildChunkPayload(file, batch, lease, out var chunk);
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            content.Headers.ContentEncoding.Add("gzip");
            using var gzipped = await GzipContent.Create(content, lease.MaxUploadRateKbps ?? 0);
            _admissionClient.EnsureUploadLeaseUsable(lease);
            using var req = new HttpRequestMessage(HttpMethod.Post, _config.GatewayUri) { Content = gzipped };
            req.Headers.UserAgent.ParseAdd("HostEyeShipper/1.0");

            _logger.Info($"Sending chunk={chunk.ChunkId} file={Path.GetFileName(file)} byte_offset={batch.StartByteOffset} events={batch.Lines.Count} checksum={chunk.Checksum} lease={lease.LeaseId} rate_kbps={lease.MaxUploadRateKbps} bytes={Encoding.UTF8.GetByteCount(payload)}.");
            var sendStartedAt = DateTimeOffset.UtcNow;
            var stopwatch = Stopwatch.StartNew();
            using var resp = await _http.SendAsync(req);
            stopwatch.Stop();
            var sendCompletedAt = DateTimeOffset.UtcNow;
            if ((int)resp.StatusCode == 429 || resp.StatusCode == HttpStatusCode.ServiceUnavailable)
            {
                var retryAfter = resp.Headers.RetryAfter?.Delta?.TotalSeconds;
                throw new BackpressureException((int)resp.StatusCode, retryAfter is null ? null : (int)Math.Ceiling(retryAfter.Value));
            }
            if (!resp.IsSuccessStatusCode)
            {
                throw new Exception($"Gateway returned {(int)resp.StatusCode} {resp.ReasonPhrase}");
            }

            var ack = await ReadAndValidateAck(resp, chunk);
            _state.SetCheckpoint(file, batch.NextLineOffset, batch.NextByteOffset);
            _state.LastSuccessTime = DateTimeOffset.UtcNow;
            _state.Save();
            _logger.Info($"Sent OK chunk={chunk.ChunkId} ack_status={ack.Status} index_status={ack.IndexStatus} file={Path.GetFileName(file)} next_byte_offset={batch.NextByteOffset} next_line_offset={batch.NextLineOffset}.");
            var timing = new SendTiming(jitterPlannedAt, scheduledSendAt, actualSendAt, sendStartedAt, sendCompletedAt);
            await TrySendRuntimeMetric(file, batch, gzipped.CompressedLength, jitter, jitterWindow, retryAttempt, spoolStats, (int)resp.StatusCode, stopwatch.Elapsed, chunk, ack, timing);
            TryArchiveEmptyOrFullyReadFile(file, batch.NextByteOffset);
            return true;
        }

        return false;
    }

    private string BuildChunkPayload(string spoolFile, Batch batch, UploadLease lease, out ChunkMetadata chunk)
    {
        var eventsJson = "[" + string.Join(",", batch.Lines) + "]";
        using var eventDoc = JsonDocument.Parse(eventsJson);
        var canonicalEventsJson = JsonSerializer.Serialize(eventDoc.RootElement);
        var checksum = Utilities.Sha256Hex(canonicalEventsJson);
        var agentId = Utilities.GetAgentId();
        var hostId = Utilities.GetHostId();
        var computerName = Utilities.GetEndpointComputerName();
        var sequenceNumber = Math.Max(0, batch.StartLineOffset);
        var chunkId = Utilities.Sha256Hex($"{agentId}|{hostId}|{computerName}|{Path.GetFileName(spoolFile)}|{batch.StartByteOffset}|{batch.NextByteOffset}|{checksum}");

        chunk = new ChunkMetadata(
            ChunkId: chunkId,
            AgentId: agentId,
            HostId: hostId,
            Computer: computerName,
            SpoolFile: Path.GetFileName(spoolFile),
            LineOffset: batch.StartLineOffset,
            NextLineOffset: batch.NextLineOffset,
            ByteOffset: batch.StartByteOffset,
            NextByteOffset: batch.NextByteOffset,
            SequenceNumber: sequenceNumber,
            EventCount: batch.Lines.Count,
            Checksum: checksum,
            LeaseId: lease.LeaseId ?? "",
            LeaseIssuedAt: lease.IssuedAtUtc,
            LeaseExpiresAt: lease.ExpiresAtUtc,
            LeaseTtlSeconds: lease.LeaseTtlSeconds ?? 0,
            MaxBatchMb: lease.MaxBatchMb ?? 0,
            MaxUploadRateKbps: lease.MaxUploadRateKbps ?? 0);

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            writer.WriteString("protocol", "hosteye.telemetry.v1");
            writer.WriteString("schema_version", "1.0.0");
            writer.WriteString("chunk_id", chunk.ChunkId);
            writer.WriteString("agent_id", chunk.AgentId);
            writer.WriteString("host_id", chunk.HostId);
            writer.WriteString("computer", chunk.Computer);
            writer.WriteString("source_platform", "hosteye_windows_endpoint");
            writer.WriteString("shipper_version", typeof(Program).Assembly.GetName().Version?.ToString() ?? "1.0.0");
            writer.WriteString("spool_file", chunk.SpoolFile);
            writer.WriteNumber("line_offset", chunk.LineOffset);
            writer.WriteNumber("next_line_offset", chunk.NextLineOffset);
            writer.WriteNumber("byte_offset", chunk.ByteOffset);
            writer.WriteNumber("next_byte_offset", chunk.NextByteOffset);
            writer.WriteNumber("sequence_number", chunk.SequenceNumber);
            writer.WriteNumber("event_count", chunk.EventCount);
            writer.WriteNumber("normal_jitter_window_ms", Math.Max(0, _config.NormalJitterWindowSeconds) * 1000);
            writer.WriteNumber("recovery_jitter_window_ms", Math.Max(0, _config.RecoveryJitterWindowSeconds) * 1000);
            writer.WriteNumber("max_events", Math.Max(0, _config.MaxEvents));
            writer.WriteNumber("max_bytes", Math.Max(0, _config.MaxBytes));
            writer.WriteNumber("batch_bytes", batch.Bytes);
            writer.WriteString("lease_id", chunk.LeaseId);
            writer.WriteString("lease_issued_at", chunk.LeaseIssuedAt.ToString("O"));
            writer.WriteString("lease_expires_at", chunk.LeaseExpiresAt.ToString("O"));
            writer.WriteNumber("lease_ttl_seconds", chunk.LeaseTtlSeconds);
            writer.WriteNumber("max_batch_mb", chunk.MaxBatchMb);
            writer.WriteNumber("max_upload_rate_kbps", chunk.MaxUploadRateKbps);
            writer.WriteString("checksum", chunk.Checksum);
            writer.WriteString("checksum_algorithm", "sha256");
            writer.WriteString("created_at", DateTimeOffset.UtcNow.ToString("O"));
            writer.WritePropertyName("events");
            writer.WriteRawValue(canonicalEventsJson, skipInputValidation: false);
            writer.WriteEndObject();
        }

        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private async Task<ChunkAck> ReadAndValidateAck(HttpResponseMessage resp, ChunkMetadata chunk)
    {
        var body = await resp.Content.ReadAsStringAsync();
        if (string.IsNullOrWhiteSpace(body))
        {
            throw new Exception($"Gateway returned success without ACK body for chunk={chunk.ChunkId}");
        }

        ChunkAck? ack;
        try
        {
            ack = JsonSerializer.Deserialize<ChunkAck>(body, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (Exception ex)
        {
            throw new Exception($"Gateway ACK was not valid JSON for chunk={chunk.ChunkId}: {ex.Message}");
        }

        if (ack is null || !ack.Ack || !ack.Commit)
        {
            throw new Exception($"Gateway did not commit chunk={chunk.ChunkId}; ack_body={body}");
        }
        if (!string.Equals(ack.ChunkId, chunk.ChunkId, StringComparison.OrdinalIgnoreCase))
        {
            throw new Exception($"Gateway ACK chunk_id mismatch. expected={chunk.ChunkId} actual={ack.ChunkId}");
        }
        if (!string.Equals(ack.Checksum, chunk.Checksum, StringComparison.OrdinalIgnoreCase))
        {
            throw new Exception($"Gateway ACK checksum mismatch for chunk={chunk.ChunkId}.");
        }
        if (ack.EventCount != chunk.EventCount)
        {
            throw new Exception($"Gateway ACK event_count mismatch for chunk={chunk.ChunkId}. expected={chunk.EventCount} actual={ack.EventCount}");
        }
        if (!string.IsNullOrWhiteSpace(chunk.LeaseId) &&
            !string.Equals(ack.LeaseId, chunk.LeaseId, StringComparison.OrdinalIgnoreCase))
        {
            throw new Exception($"Gateway ACK lease_id mismatch for chunk={chunk.ChunkId}. expected={chunk.LeaseId} actual={ack.LeaseId}");
        }

        return ack;
    }

    private async Task TrySendRuntimeMetric(
        string spoolFile,
        Batch batch,
        long compressedBytes,
        int plannedJitterSeconds,
        int jitterWindowSeconds,
        int retryAttempt,
        SpoolStats spoolStats,
        int statusCode,
        TimeSpan sendDuration,
        ChunkMetadata chunk,
        ChunkAck ack,
        SendTiming timing)
    {
        try
        {
            var maxSpoolBytes = _config.MaxSpoolSizeMB <= 0 ? 0 : _config.MaxSpoolSizeMB * 1024L * 1024L;
            var lowWatermarkBytes = maxSpoolBytes <= 0 ? 0 : maxSpoolBytes * Math.Clamp(_config.LowWatermarkPercent, 1, 100) / 100L;
            var metricTimestamp = DateTimeOffset.UtcNow;
            var computerName = Utilities.GetEndpointComputerName();
            var metric = new Dictionary<string, object?>
            {
                ["source_type"] = "hosteye_shipper_metric",
                ["metric_type"] = "shipper_batch",
                ["metric_timestamp"] = metricTimestamp.ToString("O"),
                ["agent_id"] = Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID") ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID") ?? "",
                ["host_id"] = Environment.GetEnvironmentVariable("HOSTEYE_HOST_ID") ?? Environment.GetEnvironmentVariable("VECTOR_HOST_ID") ?? "",
                ["computer"] = computerName,
                ["source_platform"] = "hosteye_windows_endpoint",
                ["shipper_version"] = typeof(Program).Assembly.GetName().Version?.ToString() ?? "1.0.0",
                ["gateway_uri"] = _config.GatewayUri,
                ["spool_directory"] = _config.SpoolDirectory,
                ["spool_file"] = Path.GetFileName(spoolFile),
                ["line_offset"] = batch.StartLineOffset,
                ["next_line_offset"] = batch.NextLineOffset,
                ["byte_offset"] = batch.StartByteOffset,
                ["next_byte_offset"] = batch.NextByteOffset,
                ["chunk_id"] = chunk.ChunkId,
                ["chunk_checksum"] = chunk.Checksum,
                ["sequence_number"] = chunk.SequenceNumber,
                ["ack_status"] = ack.Status,
                ["lease_id"] = chunk.LeaseId,
                ["lease_issued_at"] = chunk.LeaseIssuedAt.ToString("O"),
                ["lease_expires_at"] = chunk.LeaseExpiresAt.ToString("O"),
                ["lease_ttl_seconds"] = chunk.LeaseTtlSeconds,
                ["max_batch_mb"] = chunk.MaxBatchMb,
                ["max_upload_rate_kbps"] = chunk.MaxUploadRateKbps,
                ["batch_size"] = batch.Lines.Count,
                ["batch_bytes"] = batch.Bytes,
                ["compressed_bytes"] = compressedBytes,
                ["planned_jitter_ms"] = plannedJitterSeconds * 1000,
                ["jitter_window_ms"] = jitterWindowSeconds * 1000,
                ["normal_jitter_window_ms"] = Math.Max(0, _config.NormalJitterWindowSeconds) * 1000,
                ["recovery_jitter_window_ms"] = Math.Max(0, _config.RecoveryJitterWindowSeconds) * 1000,
                ["max_events"] = Math.Max(0, _config.MaxEvents),
                ["max_bytes"] = Math.Max(0, _config.MaxBytes),
                ["scheduled_send_at"] = timing.ScheduledSendAt.ToString("O"),
                ["actual_send_at"] = timing.ActualSendAt.ToString("O"),
                ["send_started_at"] = timing.SendStartedAt.ToString("O"),
                ["send_completed_at"] = timing.SendCompletedAt.ToString("O"),
                ["jitter_delay_ms"] = Math.Max(0, (int)Math.Round((timing.ActualSendAt - timing.JitterPlannedAt).TotalMilliseconds)),
                ["backoff_delay_ms"] = 0,
                ["next_retry_at"] = timing.SendCompletedAt.ToString("O"),
                ["retry_attempt"] = retryAttempt,
                ["planned_backoff_ms"] = 0,
                ["spool_depth_bytes"] = spoolStats.Bytes,
                ["spool_file_count"] = spoolStats.FileCount,
                ["pending_file_count"] = spoolStats.PendingFileCount,
                ["max_spool_bytes"] = maxSpoolBytes,
                ["low_watermark_bytes"] = lowWatermarkBytes,
                ["status_code"] = statusCode,
                ["send_duration_ms"] = Math.Max(0, (int)Math.Round(sendDuration.TotalMilliseconds)),
                ["success"] = statusCode >= 200 && statusCode < 300,
                ["data_loss"] = maxSpoolBytes > 0 && spoolStats.Bytes > maxSpoolBytes,
                ["message"] = "HostEyeShipper batch sent",
                ["idempotency_key"] = Utilities.Sha256Hex($"{computerName}|{Path.GetFileName(spoolFile)}|{batch.StartByteOffset}|{batch.NextByteOffset}|{metricTimestamp:O}")
            };

            var payload = "[" + JsonSerializer.Serialize(metric) + "]";
            using var content = new StringContent(payload, Encoding.UTF8, "application/json");
            using var req = new HttpRequestMessage(HttpMethod.Post, _config.GatewayUri) { Content = content };
            req.Headers.UserAgent.ParseAdd("HostEyeShipper/1.0");
            using var resp = await _http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.Warn($"Runtime metric send returned {(int)resp.StatusCode} {resp.ReasonPhrase}.");
            }
        }
        catch (Exception ex)
        {
            _logger.Warn($"Runtime metric send skipped: {ex.Message}");
        }
    }

    private long ResolveStartByteOffset(string file, FileCheckpoint checkpoint)
    {
        if (checkpoint.ByteOffset > 0) return checkpoint.ByteOffset;
        if (checkpoint.LineOffset <= 0) return 0;

        var migratedOffset = ComputeByteOffsetForLine(file, checkpoint.LineOffset);
        _logger.Info($"Migrated checkpoint for {Path.GetFileName(file)} line_offset={checkpoint.LineOffset} to byte_offset={migratedOffset}.");
        return migratedOffset;
    }

    private long ComputeByteOffsetForLine(string file, int targetLineOffset)
    {
        if (targetLineOffset <= 0) return 0;
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var line = 0;
        while (stream.Position < stream.Length)
        {
            var value = stream.ReadByte();
            if (value == -1) break;
            if (value == '\n')
            {
                line++;
                if (line >= targetLineOffset) return stream.Position;
            }
        }
        return stream.Length;
    }

    private Batch ReadBatch(string file, int startLineOffset, long startByteOffset, int maxEvents, int maxBytes)
    {
        var lines = new List<string>();
        var bytes = 2;
        var nextByteOffset = Math.Max(0, startByteOffset);
        var nextLineOffset = Math.Max(0, startLineOffset);
        using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (nextByteOffset > stream.Length)
        {
            return new Batch(lines, bytes, startByteOffset, stream.Length, startLineOffset, startLineOffset);
        }
        stream.Seek(nextByteOffset, SeekOrigin.Begin);

        while (stream.Position < stream.Length)
        {
            var lineStart = stream.Position;
            using var lineBuffer = new MemoryStream();
            while (stream.Position < stream.Length)
            {
                var value = stream.ReadByte();
                if (value == -1 || value == '\n') break;
                lineBuffer.WriteByte((byte)value);
            }

            var lineEnd = stream.Position;
            var rawLine = lineBuffer.ToArray();
            if (rawLine.Length > 0 && rawLine[^1] == '\r')
            {
                Array.Resize(ref rawLine, rawLine.Length - 1);
            }
            if (lineStart == 0 && rawLine.Length >= 3 && rawLine[0] == 0xEF && rawLine[1] == 0xBB && rawLine[2] == 0xBF)
            {
                rawLine = rawLine[3..];
            }

            var line = Encoding.UTF8.GetString(rawLine);
            if (string.IsNullOrWhiteSpace(line))
            {
                nextByteOffset = lineEnd;
                nextLineOffset++;
                continue;
            }
            using (JsonDocument.Parse(line)) { }
            var lineBytes = Encoding.UTF8.GetByteCount(line) + (lines.Count > 0 ? 1 : 0);
            if (lines.Count > 0 && (lines.Count >= maxEvents || bytes + lineBytes > maxBytes)) break;
            lines.Add(line);
            bytes += lineBytes;
            nextByteOffset = lineEnd;
            nextLineOffset++;
            if (lines.Count >= maxEvents || bytes >= maxBytes) break;
        }

        return new Batch(lines, bytes, startByteOffset, nextByteOffset, startLineOffset, nextLineOffset);
    }

    private void TryArchiveEmptyOrFullyReadFile(string file, long byteOffset)
    {
        try
        {
            var length = new FileInfo(file).Length;
            if (length == 0 || byteOffset >= length)
            {
                var sentDir = Path.Combine(Path.GetDirectoryName(file)!, "sent");
                Directory.CreateDirectory(sentDir);
                var dest = Path.Combine(sentDir, Path.GetFileName(file) + "." + DateTimeOffset.UtcNow.ToString("yyyyMMddHHmmss") + ".sent");
                File.Move(file, dest, overwrite: false);
                _logger.Info($"Archived sent spool file {Path.GetFileName(file)} -> {Path.GetFileName(dest)}.");
            }
        }
        catch (Exception ex)
        {
            _logger.Info($"Spool archive skipped for {Path.GetFileName(file)}: {ex.Message}");
        }
    }
}
