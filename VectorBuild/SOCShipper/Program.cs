using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

var configPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "shipper-config.json");
var config = ShipperConfig.Load(configPath);
Directory.CreateDirectory(config.SpoolDirectory);
Directory.CreateDirectory(config.StateDirectory);
Directory.CreateDirectory(config.LogDirectory);
var logger = new FileLogger(Path.Combine(config.LogDirectory, "shipper.log"));
var state = ShipperState.Load(Path.Combine(config.StateDirectory, "shipper-state.json"));
var random = RandomNumberGenerator.Create();
var endpointSeed = Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID")
    ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID")
    ?? Environment.MachineName
    ?? Guid.NewGuid().ToString("n");

logger.Info($"HostEyeShipper starting. Config={configPath} Spool={config.SpoolDirectory} Gateway={config.GatewayUri}");
using var http = BuildHttpClient(config, logger);
await TrySyncAgentConfig(config, http, state, logger);
state.Save();
using var cleanupCts = new CancellationTokenSource();
var cleanupTask = config.MaxSpoolSizeMB > 0
    ? RunSpoolQuotaLoop(config, logger, cleanupCts.Token)
    : Task.CompletedTask;
var attempt = 0;

try
{
    while (true)
    {
        try
        {
            var sentAny = await ProcessSpoolOnce(config, state, http, logger, endpointSeed, attempt);
            if (sentAny)
            {
                attempt = 0;
                if (config.RunOnce)
                {
                    logger.Info("RunOnce completed after one successful batch.");
                    return 0;
                }
            }
            else if (config.RunOnce)
            {
                logger.Info("RunOnce completed; no pending spool data.");
                return 0;
            }
            else
            {
                await Task.Delay(TimeSpan.FromSeconds(5));
            }
        }
        catch (BackpressureException ex)
        {
            attempt++;
            var retryAfter = ex.RetryAfterSeconds ?? 0;
            var delay = retryAfter > 0
                ? TimeSpan.FromSeconds(retryAfter + RandomInt(random, 0, 30))
                : FullJitterDelay(random, config.BaseBackoffSeconds, config.MaxBackoffSeconds, attempt);
            logger.Info($"Backpressure/status={ex.StatusCode}; delaying {delay.TotalSeconds:F0}s attempt={attempt}.");
            if (config.RunOnce) return 2;
            await Task.Delay(delay);
        }
        catch (Exception ex)
        {
            attempt++;
            var delay = FullJitterDelay(random, config.BaseBackoffSeconds, config.MaxBackoffSeconds, attempt);
            logger.Error($"Unhandled shipper error: {ex}; delaying {delay.TotalSeconds:F0}s attempt={attempt}.");
            if (config.RunOnce) return 1;
            await Task.Delay(delay);
        }
    }
}
finally
{
    await StopCleanupLoop(cleanupCts, cleanupTask, logger);
}

static async Task RunSpoolQuotaLoop(ShipperConfig config, FileLogger logger, CancellationToken token)
{
    logger.Info($"Spool quota loop enabled. MaxSpoolSizeMB={config.MaxSpoolSizeMB} LowWatermarkPercent={config.LowWatermarkPercent} CheckIntervalSeconds={config.SpoolCheckIntervalSeconds} PreferDeletingSentFirst={config.PreferDeletingSentFirst} SentRetentionDays={config.SentRetentionDays}.");
    while (!token.IsCancellationRequested)
    {
        try
        {
            EnforceSpoolPolicy(config, logger);
        }
        catch (Exception ex)
        {
            logger.Warn($"Spool quota check failed: {ex.Message}");
        }

        try
        {
            await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, config.SpoolCheckIntervalSeconds)), token);
        }
        catch (OperationCanceledException)
        {
            break;
        }
    }
}

static async Task StopCleanupLoop(CancellationTokenSource cleanupCts, Task cleanupTask, FileLogger logger)
{
    try
    {
        cleanupCts.Cancel();
        await cleanupTask;
    }
    catch (OperationCanceledException)
    {
    }
    catch (Exception ex)
    {
        logger.Warn($"Spool quota loop stopped with error: {ex.Message}");
    }
}

static async Task<bool> ProcessSpoolOnce(ShipperConfig config, ShipperState state, HttpClient http, FileLogger logger, string endpointSeed, int retryAttempt)
{
    var files = Directory.GetFiles(config.SpoolDirectory, "*.ndjson")
        .OrderBy(File.GetCreationTimeUtc)
        .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
        .ToArray();
    var spoolStats = GetSpoolStats(config.SpoolDirectory);

    foreach (var file in files)
    {
        var checkpoint = state.GetCheckpoint(file);
        var startByteOffset = ResolveStartByteOffset(file, checkpoint, logger);
        var batch = ReadBatch(file, checkpoint.LineOffset, startByteOffset, config.MaxEvents, config.MaxBytes);
        if (batch.Lines.Count == 0)
        {
            TryArchiveEmptyOrFullyReadFile(file, batch.NextByteOffset, logger);
            continue;
        }

        var jitterPlannedAt = DateTimeOffset.UtcNow;
        var jitterWindow = batch.StartByteOffset == 0 ? config.NormalJitterWindowSeconds : Math.Min(config.RecoveryJitterWindowSeconds, Math.Max(config.NormalJitterWindowSeconds, config.RecoveryJitterWindowSeconds));
        var jitter = StableJitterSeconds(endpointSeed + ":" + Path.GetFileName(file) + ":" + batch.StartByteOffset, jitterWindow);
        var scheduledSendAt = jitterPlannedAt.AddSeconds(jitter);
        if (jitter > 0)
        {
            logger.Info($"Applying deterministic send jitter {jitter}s for {Path.GetFileName(file)} byte_offset={batch.StartByteOffset}.");
            await Task.Delay(TimeSpan.FromSeconds(jitter));
        }
        var actualSendAt = DateTimeOffset.UtcNow;

        var lease = await TryRequestAdmission(config, http, logger, batch, spoolStats, retryAttempt);
        EnsureUploadLeaseUsable(lease, batch);

        var payload = BuildChunkPayload(config, file, batch, lease, out var chunk);
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        content.Headers.ContentEncoding.Add("gzip");
        using var gzipped = await GzipContent.Create(content, lease.MaxUploadRateKbps);
        EnsureUploadLeaseUsable(lease, batch);
        using var req = new HttpRequestMessage(HttpMethod.Post, config.GatewayUri) { Content = gzipped };
        req.Headers.UserAgent.ParseAdd("HostEyeShipper/1.0");

        logger.Info($"Sending chunk={chunk.ChunkId} file={Path.GetFileName(file)} byte_offset={batch.StartByteOffset} events={batch.Lines.Count} checksum={chunk.Checksum} lease={lease.LeaseId} rate_kbps={lease.MaxUploadRateKbps} bytes={Encoding.UTF8.GetByteCount(payload)}.");
        var sendStartedAt = DateTimeOffset.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        using var resp = await http.SendAsync(req);
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
        state.SetCheckpoint(file, batch.NextLineOffset, batch.NextByteOffset);
        state.Save();
        logger.Info($"Sent OK chunk={chunk.ChunkId} ack_status={ack.Status} index_status={ack.IndexStatus} file={Path.GetFileName(file)} next_byte_offset={batch.NextByteOffset} next_line_offset={batch.NextLineOffset}.");
        var timing = new SendTiming(jitterPlannedAt, scheduledSendAt, actualSendAt, sendStartedAt, sendCompletedAt);
        await TrySendRuntimeMetric(config, http, logger, file, batch, gzipped.CompressedLength, jitter, jitterWindow, retryAttempt, spoolStats, (int)resp.StatusCode, stopwatch.Elapsed, chunk, ack, timing);
        TryArchiveEmptyOrFullyReadFile(file, batch.NextByteOffset, logger);
        return true;
    }

    return false;
}

static string BuildChunkPayload(ShipperConfig config, string spoolFile, Batch batch, UploadLease lease, out ChunkMetadata chunk)
{
    var eventsJson = "[" + string.Join(",", batch.Lines) + "]";
    using var eventDoc = JsonDocument.Parse(eventsJson);
    var canonicalEventsJson = JsonSerializer.Serialize(eventDoc.RootElement);
    var checksum = Sha256Hex(canonicalEventsJson);
    var agentId = GetAgentId();
    var hostId = GetHostId();
    var computerName = GetEndpointComputerName();
    var sequenceNumber = Math.Max(0, batch.StartLineOffset);
    var chunkId = Sha256Hex($"{agentId}|{hostId}|{computerName}|{Path.GetFileName(spoolFile)}|{batch.StartByteOffset}|{batch.NextByteOffset}|{checksum}");

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
        LeaseId: lease.LeaseId,
        LeaseIssuedAt: lease.IssuedAtUtc,
        LeaseExpiresAt: lease.ExpiresAtUtc,
        LeaseTtlSeconds: lease.LeaseTtlSeconds,
        MaxBatchMb: lease.MaxBatchMb,
        MaxUploadRateKbps: lease.MaxUploadRateKbps);

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
        writer.WriteNumber("normal_jitter_window_ms", Math.Max(0, config.NormalJitterWindowSeconds) * 1000);
        writer.WriteNumber("recovery_jitter_window_ms", Math.Max(0, config.RecoveryJitterWindowSeconds) * 1000);
        writer.WriteNumber("max_events", Math.Max(0, config.MaxEvents));
        writer.WriteNumber("max_bytes", Math.Max(0, config.MaxBytes));
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

static async Task<ChunkAck> ReadAndValidateAck(HttpResponseMessage resp, ChunkMetadata chunk)
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

static async Task TrySyncAgentConfig(ShipperConfig config, HttpClient http, ShipperState state, FileLogger logger)
{
    if (!config.EnableConfigSync) return;
    var configUri = string.IsNullOrWhiteSpace(config.ConfigUri)
        ? DeriveEndpointUri(config.GatewayUri, "/api/v1/agent/config")
        : config.ConfigUri;

    try
    {
        using var req = new HttpRequestMessage(HttpMethod.Get, configUri);
        AddAgentConfigHeaders(req, config);
        if (!string.IsNullOrWhiteSpace(state.AgentConfigEtag))
        {
            req.Headers.TryAddWithoutValidation("If-None-Match", state.AgentConfigEtag);
        }
        using var resp = await http.SendAsync(req);
        if (resp.StatusCode == HttpStatusCode.NotModified)
        {
            logger.Info($"Agent config unchanged etag={state.AgentConfigEtag}.");
            return;
        }
        if (!resp.IsSuccessStatusCode)
        {
            logger.Warn($"Agent config sync skipped: {(int)resp.StatusCode} {resp.ReasonPhrase}.");
            return;
        }

        var body = await resp.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        var ackStatus = "applied";
        var ackMessage = "legacy config applied";
        if (root.TryGetProperty("signed_policy", out var signedPolicy))
        {
            var verify = VerifySignedPolicy(signedPolicy, config, logger);
            if (!verify.Valid)
            {
                logger.Error($"Agent config signature verification failed: {verify.Message}");
                await TryAckAgentConfig(config, http, logger, root, "verify_failed", verify.Message);
                return;
            }

            if (signedPolicy.TryGetProperty("config", out var signedConfig))
            {
                ApplyServerConfig(config, signedConfig);
            }
            ApplyServerConfig(config, root);
            state.AgentConfigPolicyId = GetJsonString(signedPolicy, "policy_id");
            state.AgentConfigPolicyVersion = GetJsonInt(signedPolicy, "version");
            state.AgentConfigSha256 = GetJsonString(signedPolicy, "config_sha256");
            state.AgentConfigCachedJson = signedPolicy.GetRawText();
            ackMessage = "signed policy verified and applied";
        }
        else
        {
            ApplyServerConfig(config, root);
            state.AgentConfigPolicyId = GetJsonString(root, "policy_id");
            state.AgentConfigPolicyVersion = GetJsonInt(root, "policy_version");
            state.AgentConfigCachedJson = root.GetRawText();
        }
        if (resp.Headers.ETag is not null)
        {
            state.AgentConfigEtag = resp.Headers.ETag.Tag;
        }
        await TryAckAgentConfig(config, http, logger, root, ackStatus, ackMessage);
        logger.Info($"Agent config synced from {configUri}; etag={state.AgentConfigEtag}; MaxEvents={config.MaxEvents}; MaxBytes={config.MaxBytes}; NormalJitter={config.NormalJitterWindowSeconds}s; RecoveryJitter={config.RecoveryJitterWindowSeconds}s.");
    }
    catch (Exception ex)
    {
        logger.Warn($"Agent config sync skipped: {ex.Message}");
    }
}

static void ApplyServerConfig(ShipperConfig config, JsonElement root)
{
    if (TryGetInt(root, "max_events", out var maxEvents) && maxEvents > 0) config.MaxEvents = maxEvents;
    if (TryGetInt(root, "max_bytes", out var maxBytes) && maxBytes > 0) config.MaxBytes = maxBytes;
    if (TryGetInt(root, "normal_jitter_window_ms", out var normalJitterMs)) config.NormalJitterWindowSeconds = MillisecondsToSeconds(normalJitterMs);
    if (TryGetInt(root, "recovery_jitter_window_ms", out var recoveryJitterMs)) config.RecoveryJitterWindowSeconds = MillisecondsToSeconds(recoveryJitterMs);

    if (root.TryGetProperty("routing", out var routing))
    {
        var telemetryUrl = GetJsonString(routing, "telemetry_url");
        var admissionUrl = GetJsonString(routing, "admission_url");
        var configUrl = GetJsonString(routing, "config_url");
        if (Uri.TryCreate(telemetryUrl, UriKind.Absolute, out _)) config.GatewayUri = telemetryUrl;
        if (Uri.TryCreate(admissionUrl, UriKind.Absolute, out _)) config.AdmissionUri = admissionUrl;
        if (Uri.TryCreate(configUrl, UriKind.Absolute, out _)) config.ConfigUri = configUrl;
    }

    if (root.TryGetProperty("limits", out var limits))
    {
        if (TryGetInt(limits, "max_events", out maxEvents) && maxEvents > 0) config.MaxEvents = maxEvents;
        if (TryGetInt(limits, "max_bytes", out maxBytes) && maxBytes > 0) config.MaxBytes = maxBytes;
    }

    if (root.TryGetProperty("jitter", out var jitter))
    {
        if (TryGetInt(jitter, "normal_jitter_window_ms", out normalJitterMs)) config.NormalJitterWindowSeconds = MillisecondsToSeconds(normalJitterMs);
        if (TryGetInt(jitter, "recovery_jitter_window_ms", out recoveryJitterMs)) config.RecoveryJitterWindowSeconds = MillisecondsToSeconds(recoveryJitterMs);
    }
}

static (bool Valid, string Message) VerifySignedPolicy(JsonElement signedPolicy, ShipperConfig config, FileLogger logger)
{
    var algorithm = GetJsonString(signedPolicy, "signature_algorithm");
    if (!string.Equals(algorithm, "hmac-sha256", StringComparison.OrdinalIgnoreCase))
    {
        return (false, $"unsupported signature_algorithm={algorithm}");
    }
    if (!signedPolicy.TryGetProperty("config", out var policyConfig))
    {
        return (false, "signed policy missing config");
    }

    var expectedHash = GetJsonString(signedPolicy, "config_sha256");
    var actualHash = Sha256Hex(policyConfig.GetRawText());
    if (!string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
    {
        return (false, "config_sha256 mismatch");
    }

    var signature = GetJsonString(signedPolicy, "signature");
    var expectedSignature = HmacSha256Hex(config.AgentConfigSigningKey, SignedPolicyText(signedPolicy));
    if (!FixedTimeEqualsHex(signature, expectedSignature))
    {
        return (false, "signature mismatch");
    }

    logger.Info($"Verified signed policy id={GetJsonString(signedPolicy, "policy_id")} version={GetJsonInt(signedPolicy, "version")} key_id={GetJsonString(signedPolicy, "key_id")}.");
    return (true, "ok");
}

static string SignedPolicyText(JsonElement envelope)
{
    return string.Join("\n", new[]
    {
        "HOSTEYE_DYNAMIC_CONFIG_V1",
        GetJsonString(envelope, "signature_algorithm"),
        GetJsonString(envelope, "key_id"),
        GetJsonString(envelope, "policy_id"),
        GetJsonInt(envelope, "version").ToString(),
        GetJsonString(envelope, "issued_at"),
        GetJsonString(envelope, "expires_at"),
        GetJsonString(envelope, "agent_id"),
        GetJsonString(envelope, "host_id"),
        GetJsonString(envelope, "group_id"),
        GetJsonString(envelope, "config_sha256")
    });
}

static async Task TryAckAgentConfig(ShipperConfig config, HttpClient http, FileLogger logger, JsonElement root, string status, string message)
{
    try
    {
        var ackUri = DeriveEndpointUri(string.IsNullOrWhiteSpace(config.ConfigUri) ? config.GatewayUri : config.ConfigUri, "/api/v1/agent/config/ack");
        var policy = root.TryGetProperty("signed_policy", out var signedPolicy) ? signedPolicy : root;
        var payload = new Dictionary<string, object?>
        {
            ["agent_id"] = GetAgentId(),
            ["host_id"] = GetHostId(),
            ["computer"] = GetEndpointComputerName(),
            ["source_platform"] = "hosteye_windows_endpoint",
            ["policy_id"] = GetJsonString(policy, "policy_id"),
            ["version"] = GetJsonInt(policy, "version") == 0 ? GetJsonInt(root, "policy_version") : GetJsonInt(policy, "version"),
            ["status"] = status,
            ["message"] = message,
            ["applied_at"] = DateTimeOffset.UtcNow.ToString("O")
        };
        using var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, ackUri) { Content = content };
        AddAgentConfigHeaders(req, config);
        using var resp = await http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
        {
            logger.Warn($"Agent config ACK returned {(int)resp.StatusCode} {resp.ReasonPhrase}.");
        }
    }
    catch (Exception ex)
    {
        logger.Warn($"Agent config ACK skipped: {ex.Message}");
    }
}

static void AddAgentConfigHeaders(HttpRequestMessage req, ShipperConfig config)
{
    req.Headers.TryAddWithoutValidation("x-hosteye-agent-id", GetAgentId());
    req.Headers.TryAddWithoutValidation("x-hosteye-host-id", GetHostId());
    req.Headers.TryAddWithoutValidation("x-hosteye-group-id", config.GroupId);
}

static async Task<UploadLease> TryRequestAdmission(ShipperConfig config, HttpClient http, FileLogger logger, Batch batch, SpoolStats spoolStats, int retryAttempt)
{
    if (!config.EnableAdmissionControl) return UploadLease.Disabled();
    var admissionUri = string.IsNullOrWhiteSpace(config.AdmissionUri)
        ? DeriveEndpointUri(config.GatewayUri, "/api/v1/admission/request")
        : config.AdmissionUri;

    var request = new Dictionary<string, object?>
    {
        ["agent_id"] = GetAgentId(),
        ["host_id"] = GetHostId(),
        ["computer"] = GetEndpointComputerName(),
        ["queue_used_mb"] = Math.Round(spoolStats.Bytes / 1024d / 1024d, 3),
        ["next_chunk_size_mb"] = Math.Round(batch.Bytes / 1024d / 1024d, 3),
        ["retry_count"] = retryAttempt,
        ["rank"] = Math.Max(0, retryAttempt)
    };

    try
    {
        using var content = new StringContent(JsonSerializer.Serialize(request), Encoding.UTF8, "application/json");
        using var resp = await http.PostAsync(admissionUri, content);
        var body = await resp.Content.ReadAsStringAsync();
        if (resp.StatusCode == HttpStatusCode.NotFound || resp.StatusCode == HttpStatusCode.MethodNotAllowed)
        {
            if (config.RequireUploadLease)
            {
                throw new BackpressureException(503, 30);
            }
            logger.Warn($"Admission endpoint unavailable at {admissionUri}; continuing without enforced lease.");
            return UploadLease.Disabled();
        }
        if ((int)resp.StatusCode == 429 || resp.StatusCode == HttpStatusCode.ServiceUnavailable)
        {
            var retryAfter = resp.Headers.RetryAfter?.Delta?.TotalSeconds;
            throw new BackpressureException((int)resp.StatusCode, retryAfter is null ? 15 : (int)Math.Ceiling(retryAfter.Value));
        }
        if (!resp.IsSuccessStatusCode)
        {
            if (config.RequireUploadLease)
            {
                throw new Exception($"Admission request failed: {(int)resp.StatusCode} {resp.ReasonPhrase}; body={body}");
            }
            logger.Warn($"Admission request returned {(int)resp.StatusCode} {resp.ReasonPhrase}; continuing without enforced lease. Body={body}");
            return UploadLease.Disabled();
        }

        using var doc = JsonDocument.Parse(body);
        var admission = doc.RootElement.TryGetProperty("admission", out var value) ? value.GetString() : "";
        if (string.Equals(admission, "ng", StringComparison.OrdinalIgnoreCase))
        {
            var retryAfter = doc.RootElement.TryGetProperty("retry_after_seconds", out var retryValue) && retryValue.TryGetInt32(out var seconds)
                ? seconds
                : 15;
            throw new BackpressureException(429, retryAfter);
        }
        var issuedAt = DateTimeOffset.UtcNow;
        var ttlSeconds = GetJsonInt(doc.RootElement, "lease_ttl_seconds");
        var expiresAt = GetJsonDateTimeOffset(doc.RootElement, "lease_expires_at") ?? issuedAt.AddSeconds(Math.Max(1, ttlSeconds));
        var lease = new UploadLease(
            LeaseId: GetJsonString(doc.RootElement, "lease_id"),
            IssuedAtUtc: issuedAt,
            ExpiresAtUtc: expiresAt,
            LeaseTtlSeconds: ttlSeconds,
            MaxBatchMb: GetJsonDouble(doc.RootElement, "max_batch_mb"),
            MaxUploadRateKbps: GetJsonInt(doc.RootElement, "max_upload_rate_kbps"),
            Required: config.RequireUploadLease);

        var collectorUrl = GetJsonString(doc.RootElement, "collector_url");
        if (string.IsNullOrWhiteSpace(collectorUrl) &&
            doc.RootElement.TryGetProperty("routing", out var routing))
        {
            collectorUrl = GetJsonString(routing, "telemetry_url");
        }
        if (Uri.TryCreate(collectorUrl, UriKind.Absolute, out _))
        {
            config.GatewayUri = collectorUrl;
        }

        if (config.RequireUploadLease && string.IsNullOrWhiteSpace(lease.LeaseId))
        {
            throw new Exception("Admission response did not include lease_id.");
        }

        EnsureUploadLeaseUsable(lease, batch);
        var sendAfter = GetJsonDateTimeOffset(doc.RootElement, "send_after");
        if (sendAfter is not null && sendAfter.Value > DateTimeOffset.UtcNow)
        {
            var delay = sendAfter.Value - DateTimeOffset.UtcNow;
            logger.Info($"Admission send_after={sendAfter.Value:O}; delaying {delay.TotalSeconds:F0}s before upload.");
            await Task.Delay(delay);
            EnsureUploadLeaseUsable(lease, batch);
        }
        logger.Info($"Admission OK lease={lease.LeaseId} collector_url={config.GatewayUri} ttl={lease.LeaseTtlSeconds}s max_batch_mb={lease.MaxBatchMb:F3} max_upload_rate_kbps={lease.MaxUploadRateKbps}.");
        return lease;
    }
    catch (BackpressureException)
    {
        throw;
    }
    catch (Exception ex)
    {
        if (config.RequireUploadLease)
        {
            throw;
        }
        logger.Warn($"Admission request skipped: {ex.Message}");
        return UploadLease.Disabled();
    }
}

static void EnsureUploadLeaseUsable(UploadLease lease, Batch batch)
{
    if (!lease.Required) return;
    if (string.IsNullOrWhiteSpace(lease.LeaseId))
    {
        throw new Exception("Upload lease is required but lease_id is empty.");
    }
    if (lease.ExpiresAtUtc <= DateTimeOffset.UtcNow)
    {
        throw new BackpressureException(429, 5);
    }
    if (lease.MaxBatchMb > 0)
    {
        var batchMb = batch.Bytes / 1024d / 1024d;
        if (batchMb > lease.MaxBatchMb)
        {
            throw new Exception($"Batch size {batchMb:F3} MB exceeds upload lease max_batch_mb={lease.MaxBatchMb:F3}.");
        }
    }
}

static string DeriveEndpointUri(string gatewayUri, string path)
{
    if (!Uri.TryCreate(gatewayUri, UriKind.Absolute, out var uri)) return path;
    var builder = new UriBuilder(uri)
    {
        Path = path,
        Query = "",
        Fragment = ""
    };
    return builder.Uri.ToString();
}

static bool TryGetInt(JsonElement root, string name, out int value)
{
    value = 0;
    if (!root.TryGetProperty(name, out var property)) return false;
    if (property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value)) return true;
    return property.ValueKind == JsonValueKind.String && int.TryParse(property.GetString(), out value);
}

static int GetJsonInt(JsonElement root, string name)
{
    return TryGetInt(root, name, out var value) ? value : 0;
}

static double GetJsonDouble(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var property)) return 0;
    if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var value)) return value;
    return property.ValueKind == JsonValueKind.String && double.TryParse(property.GetString(), out value) ? value : 0;
}

static string GetJsonString(JsonElement root, string name)
{
    return root.TryGetProperty(name, out var property) ? property.GetString() ?? "" : "";
}

static DateTimeOffset? GetJsonDateTimeOffset(JsonElement root, string name)
{
    if (!root.TryGetProperty(name, out var property)) return null;
    var value = property.GetString();
    return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
}

static int MillisecondsToSeconds(int value)
{
    return value <= 0 ? 0 : Math.Max(1, (int)Math.Ceiling(value / 1000d));
}

static long ResolveStartByteOffset(string file, FileCheckpoint checkpoint, FileLogger logger)
{
    if (checkpoint.ByteOffset > 0) return checkpoint.ByteOffset;
    if (checkpoint.LineOffset <= 0) return 0;

    var migratedOffset = ComputeByteOffsetForLine(file, checkpoint.LineOffset);
    logger.Info($"Migrated checkpoint for {Path.GetFileName(file)} line_offset={checkpoint.LineOffset} to byte_offset={migratedOffset}.");
    return migratedOffset;
}

static long ComputeByteOffsetForLine(string file, int targetLineOffset)
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

static Batch ReadBatch(string file, int startLineOffset, long startByteOffset, int maxEvents, int maxBytes)
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

static async Task TrySendRuntimeMetric(
    ShipperConfig config,
    HttpClient http,
    FileLogger logger,
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
        var maxSpoolBytes = config.MaxSpoolSizeMB <= 0 ? 0 : config.MaxSpoolSizeMB * 1024L * 1024L;
        var lowWatermarkBytes = maxSpoolBytes <= 0 ? 0 : maxSpoolBytes * Math.Clamp(config.LowWatermarkPercent, 1, 100) / 100L;
        var metricTimestamp = DateTimeOffset.UtcNow;
        var computerName = GetEndpointComputerName();
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
            ["gateway_uri"] = config.GatewayUri,
            ["spool_directory"] = config.SpoolDirectory,
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
            ["normal_jitter_window_ms"] = Math.Max(0, config.NormalJitterWindowSeconds) * 1000,
            ["recovery_jitter_window_ms"] = Math.Max(0, config.RecoveryJitterWindowSeconds) * 1000,
            ["max_events"] = Math.Max(0, config.MaxEvents),
            ["max_bytes"] = Math.Max(0, config.MaxBytes),
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
            ["idempotency_key"] = Sha256Hex($"{computerName}|{Path.GetFileName(spoolFile)}|{batch.StartByteOffset}|{batch.NextByteOffset}|{metricTimestamp:O}")
        };

        var payload = "[" + JsonSerializer.Serialize(metric) + "]";
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Post, config.GatewayUri) { Content = content };
        req.Headers.UserAgent.ParseAdd("HostEyeShipper/1.0");
        using var resp = await http.SendAsync(req);
        if (!resp.IsSuccessStatusCode)
        {
            logger.Warn($"Runtime metric send returned {(int)resp.StatusCode} {resp.ReasonPhrase}.");
        }
    }
    catch (Exception ex)
    {
        logger.Warn($"Runtime metric send skipped: {ex.Message}");
    }
}

static string GetEndpointComputerName()
{
    return Environment.GetEnvironmentVariable("HOSTEYE_COMPUTER_NAME")
        ?? Environment.GetEnvironmentVariable("COMPUTERNAME")
        ?? Environment.MachineName
        ?? "";
}

static string GetAgentId()
{
    return Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID")
        ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID")
        ?? Environment.MachineName
        ?? "unknown-agent";
}

static string GetHostId()
{
    return Environment.GetEnvironmentVariable("HOSTEYE_HOST_ID")
        ?? Environment.GetEnvironmentVariable("VECTOR_HOST_ID")
        ?? Environment.MachineName
        ?? "unknown-host";
}

static void EnforceSpoolPolicy(ShipperConfig config, FileLogger logger)
{
    try
    {
        DeleteExpiredSentFiles(config, logger);

        var maxBytes = config.MaxSpoolSizeMB <= 0 ? 0 : config.MaxSpoolSizeMB * 1024L * 1024L;
        if (maxBytes <= 0) return;

        var lowWatermarkPercent = Math.Clamp(config.LowWatermarkPercent, 1, 100);
        var targetBytes = Math.Max(0, maxBytes * lowWatermarkPercent / 100L);
        var totalBytes = GetDirectorySizeBytes(config.SpoolDirectory);
        if (totalBytes <= maxBytes) return;

        logger.Info($"Spool size {totalBytes} bytes exceeds max {maxBytes} bytes; trimming to {targetBytes} bytes.");
        foreach (var file in GetDeletionCandidates(config))
        {
            if (totalBytes <= targetBytes) break;
            try
            {
                var length = new FileInfo(file.FullName).Length;
                File.Delete(file.FullName);
                totalBytes -= length;
                if (file.IsSent)
                {
                    logger.Info($"Deleted sent spool file {file.FullName} ({length} bytes) to enforce spool limit.");
                }
                else
                {
                    logger.Warn($"Dropped unsent spool file {file.FullName} ({length} bytes) to enforce spool limit. DATA_LOSS=true");
                }
            }
            catch (Exception ex)
            {
                logger.Info($"Spool cleanup skipped {file.FullName}: {ex.Message}");
            }
        }
    }
    catch (Exception ex)
    {
        logger.Info($"Spool policy check failed: {ex.Message}");
    }
}

static void DeleteExpiredSentFiles(ShipperConfig config, FileLogger logger)
{
    if (config.SentRetentionDays < 0) return;
    var sentDir = Path.Combine(config.SpoolDirectory, "sent");
    if (!Directory.Exists(sentDir)) return;

    var cutoffUtc = DateTimeOffset.UtcNow.AddDays(-config.SentRetentionDays);
    foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly))
    {
        try
        {
            var info = new FileInfo(file);
            if (info.LastWriteTimeUtc > cutoffUtc.UtcDateTime) continue;
            info.Delete();
            logger.Info($"Deleted sent spool file past retention: {file}");
        }
        catch (Exception ex)
        {
            logger.Info($"Sent retention cleanup skipped {file}: {ex.Message}");
        }
    }
}

static long GetDirectorySizeBytes(string directory)
{
    if (!Directory.Exists(directory)) return 0;
    long total = 0;
    foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
    {
        try { total += new FileInfo(file).Length; } catch { }
    }
    return total;
}

static SpoolStats GetSpoolStats(string directory)
{
    if (!Directory.Exists(directory)) return new SpoolStats(0, 0, 0);
    long bytes = 0;
    var fileCount = 0;
    var pendingFileCount = 0;
    foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
    {
        try
        {
            var info = new FileInfo(file);
            bytes += info.Length;
            fileCount++;
            if (string.Equals(info.Extension, ".ndjson", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(info.Directory?.FullName, directory, StringComparison.OrdinalIgnoreCase))
            {
                pendingFileCount++;
            }
        }
        catch
        {
        }
    }
    return new SpoolStats(bytes, fileCount, pendingFileCount);
}

static IEnumerable<QuotaFile> GetDeletionCandidates(ShipperConfig config)
{
    var sentDir = Path.Combine(config.SpoolDirectory, "sent");
    if (config.PreferDeletingSentFirst && Directory.Exists(sentDir))
    {
        foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly)
            .OrderBy(File.GetLastWriteTimeUtc)
            .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            yield return new QuotaFile(file, true);
        }
    }

    if (!Directory.Exists(config.SpoolDirectory)) yield break;
    foreach (var file in Directory.EnumerateFiles(config.SpoolDirectory, "*.ndjson", SearchOption.TopDirectoryOnly)
        .OrderBy(File.GetCreationTimeUtc)
        .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
    {
        yield return new QuotaFile(file, false);
    }

    if (!config.PreferDeletingSentFirst && Directory.Exists(sentDir))
    {
        foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly)
            .OrderBy(File.GetLastWriteTimeUtc)
            .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase))
        {
            yield return new QuotaFile(file, true);
        }
    }
}

static void TryArchiveEmptyOrFullyReadFile(string file, long byteOffset, FileLogger logger)
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
            logger.Info($"Archived sent spool file {Path.GetFileName(file)} -> {Path.GetFileName(dest)}.");
        }
    }
    catch (Exception ex)
    {
        logger.Info($"Spool archive skipped for {Path.GetFileName(file)}: {ex.Message}");
    }
}

static HttpClient BuildHttpClient(ShipperConfig config, FileLogger logger)
{
    var handler = new HttpClientHandler
    {
        UseProxy = false
    };
    if (File.Exists(config.ClientCertificateFile) && File.Exists(config.ClientKeyFile))
    {
        var cert = X509Certificate2.CreateFromPemFile(config.ClientCertificateFile, config.ClientKeyFile);
        handler.ClientCertificates.Add(new X509Certificate2(cert.Export(X509ContentType.Pkcs12)));
        logger.Info($"Loaded client certificate: {config.ClientCertificateFile}");
    }
    else
    {
        logger.Info("WARNING: client certificate/key missing; mTLS request will likely fail.");
    }

    if (File.Exists(config.CaCertificateFile))
    {
        var trustedRoot = new X509Certificate2(config.CaCertificateFile);
        handler.ServerCertificateCustomValidationCallback = (_, cert, chain, errors) =>
        {
            if (cert is null) return false;
            if ((errors & SslPolicyErrors.RemoteCertificateNameMismatch) != 0) return false;
            if ((errors & SslPolicyErrors.RemoteCertificateNotAvailable) != 0) return false;
            if (config.AllowSystemServerCertificateTrust && errors == SslPolicyErrors.None)
            {
                logger.Info("Accepted server certificate using Windows system trust.");
                return true;
            }
            using var customChain = new X509Chain();
            customChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            customChain.ChainPolicy.CustomTrustStore.Add(trustedRoot);
            customChain.ChainPolicy.ExtraStore.Add(trustedRoot);
            customChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            customChain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            var leaf = new X509Certificate2(cert);
            var ok = customChain.Build(leaf);
            if (!ok)
            {
                var statuses = string.Join("; ", customChain.ChainStatus.Select(s => $"{s.Status}: {s.StatusInformation.Trim()}"));
                logger.Error($"Server certificate validation failed. Errors={errors}; Statuses={statuses}");
                logger.Error($"Server cert issuer='{leaf.Issuer}', pinned CA subject='{trustedRoot.Subject}'");
                if (errors == SslPolicyErrors.None && string.Equals(leaf.Issuer, trustedRoot.Subject, StringComparison.Ordinal))
                {
                    logger.Info("Accepting server certificate because issuer matches the pinned CA certificate.");
                    return true;
                }
            }
            return ok;
        };
        logger.Info($"Loaded custom CA trust: {config.CaCertificateFile}; AllowSystemServerCertificateTrust={config.AllowSystemServerCertificateTrust}");
    }

    return new HttpClient(handler)
    {
        Timeout = TimeSpan.FromSeconds(60)
    };
}

static int StableJitterSeconds(string seed, int windowSeconds)
{
    if (windowSeconds <= 0) return 0;
    var hash = SHA256.HashData(Encoding.UTF8.GetBytes(seed));
    return (int)(BitConverter.ToUInt32(hash, 0) % (uint)windowSeconds);
}

static TimeSpan FullJitterDelay(RandomNumberGenerator rng, int baseSeconds, int capSeconds, int attempt)
{
    var max = Math.Min(capSeconds, baseSeconds * Math.Pow(2, Math.Min(attempt, 16)));
    return TimeSpan.FromSeconds(RandomInt(rng, 0, Math.Max(1, (int)Math.Ceiling(max))));
}

static int RandomInt(RandomNumberGenerator rng, int minInclusive, int maxExclusive)
{
    if (maxExclusive <= minInclusive) return minInclusive;
    Span<byte> bytes = stackalloc byte[4];
    rng.GetBytes(bytes);
    var value = BitConverter.ToUInt32(bytes);
    return minInclusive + (int)(value % (uint)(maxExclusive - minInclusive));
}

static string Sha256Hex(string value)
{
    var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
    return Convert.ToHexString(hash).ToLowerInvariant();
}

static string HmacSha256Hex(string key, string value)
{
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
    return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

static bool FixedTimeEqualsHex(string left, string right)
{
    try
    {
        var leftBytes = Convert.FromHexString(left);
        var rightBytes = Convert.FromHexString(right);
        return CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }
    catch
    {
        return false;
    }
}

record Batch(List<string> Lines, int Bytes, long StartByteOffset, long NextByteOffset, int StartLineOffset, int NextLineOffset);
record QuotaFile(string FullName, bool IsSent);
record SpoolStats(long Bytes, int FileCount, int PendingFileCount);
record SendTiming(
    DateTimeOffset JitterPlannedAt,
    DateTimeOffset ScheduledSendAt,
    DateTimeOffset ActualSendAt,
    DateTimeOffset SendStartedAt,
    DateTimeOffset SendCompletedAt);
record ChunkMetadata(
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

record UploadLease(
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

class ChunkAck
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

class BackpressureException(int statusCode, int? retryAfterSeconds) : Exception($"Backpressure {statusCode}")
{
    public int StatusCode { get; } = statusCode;
    public int? RetryAfterSeconds { get; } = retryAfterSeconds;
}

class ShipperConfig
{
    public string GatewayUri { get; set; } = "https://hosteye.iahn.hanoi.vn/api/v1/telemetry";
    public string ConfigUri { get; set; } = "";
    public string AdmissionUri { get; set; } = "";
    public string GroupId { get; set; } = "default";
    public string AgentConfigSigningKey { get; set; } = "hosteye-dynamic-config-demo-key";
    public string SpoolDirectory { get; set; } = "C:\\ProgramData\\HostEye\\spool";
    public string StateDirectory { get; set; } = "C:\\ProgramData\\HostEye\\shipper_state";
    public string LogDirectory { get; set; } = "C:\\ProgramData\\HostEye\\logs";
    public string ClientCertificateFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\client.crt";
    public string ClientKeyFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\client.key";
    public string CaCertificateFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\company_ca.crt";
    public bool AllowSystemServerCertificateTrust { get; set; } = true;
    public int MaxEvents { get; set; } = 1000;
    public int MaxBytes { get; set; } = 1048576;
    public int NormalJitterWindowSeconds { get; set; } = 120;
    public int RecoveryJitterWindowSeconds { get; set; } = 900;
    public int BaseBackoffSeconds { get; set; } = 2;
    public int MaxBackoffSeconds { get; set; } = 300;
    public long MaxSpoolSizeMB { get; set; } = 8192;
    public int LowWatermarkPercent { get; set; } = 85;
    public int SpoolCheckIntervalSeconds { get; set; } = 30;
    public bool PreferDeletingSentFirst { get; set; } = true;
    public int SentRetentionDays { get; set; } = 2;
    public bool EnableConfigSync { get; set; } = true;
    public bool EnableAdmissionControl { get; set; } = true;
    public bool RequireUploadLease { get; set; } = true;
    public bool RunOnce { get; set; }

    public static ShipperConfig Load(string path)
    {
        if (!File.Exists(path)) return new ShipperConfig();
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<ShipperConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new ShipperConfig();
    }
}

class ShipperState
{
    public Dictionary<string, FileCheckpoint> Files { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public string AgentConfigEtag { get; set; } = "";
    public string AgentConfigPolicyId { get; set; } = "";
    public int AgentConfigPolicyVersion { get; set; }
    public string AgentConfigSha256 { get; set; } = "";
    public string AgentConfigCachedJson { get; set; } = "";
    [JsonIgnore]
    public string PathOnDisk { get; private set; } = "";

    public static ShipperState Load(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!File.Exists(path)) return new ShipperState { PathOnDisk = path };
        var state = JsonSerializer.Deserialize<ShipperState>(File.ReadAllText(path)) ?? new ShipperState();
        state.PathOnDisk = path;
        return state;
    }

    public FileCheckpoint GetCheckpoint(string file)
    {
        var key = System.IO.Path.GetFullPath(file);
        if (!Files.TryGetValue(key, out var cp))
        {
            cp = new FileCheckpoint { LineOffset = 0, ByteOffset = 0 };
            Files[key] = cp;
        }
        return cp;
    }

    public void SetCheckpoint(string file, int lineOffset, long byteOffset)
    {
        var key = System.IO.Path.GetFullPath(file);
        Files[key] = new FileCheckpoint { LineOffset = lineOffset, ByteOffset = byteOffset, UpdatedAtUtc = DateTimeOffset.UtcNow };
    }

    public void Save()
    {
        File.WriteAllText(PathOnDisk, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

class FileCheckpoint
{
    public int LineOffset { get; set; }
    public long ByteOffset { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}

class FileLogger(string path)
{
    public void Info(string message) => Write("INFO", message);
    public void Warn(string message) => Write("WARN", message);
    public void Error(string message) => Write("ERROR", message);
    void Write(string level, string message)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss zzz} {level} {message}";
        File.AppendAllText(path, line + Environment.NewLine);
        Console.WriteLine(line);
    }
}

class GzipContent : HttpContent
{
    readonly HttpContent _inner;
    readonly MemoryStream _compressed;
    readonly int _maxUploadRateKbps;
    public long CompressedLength => _compressed.Length;

    GzipContent(HttpContent inner, MemoryStream compressed, int maxUploadRateKbps)
    {
        _inner = inner;
        _compressed = compressed;
        _maxUploadRateKbps = Math.Max(0, maxUploadRateKbps);
        Headers.ContentType = inner.Headers.ContentType;
        Headers.ContentEncoding.Add("gzip");
    }

    public static async Task<GzipContent> Create(HttpContent inner, int maxUploadRateKbps = 0)
    {
        var compressed = new MemoryStream();
        await using (var gzip = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true))
        {
            await inner.CopyToAsync(gzip);
        }
        compressed.Position = 0;
        return new GzipContent(inner, compressed, maxUploadRateKbps);
    }

    protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
    {
        _compressed.Position = 0;
        if (_maxUploadRateKbps <= 0)
        {
            await _compressed.CopyToAsync(stream);
            return;
        }

        var bytesPerSecond = Math.Max(1024L, _maxUploadRateKbps * 1024L);
        var buffer = new byte[8192];
        long sent = 0;
        var stopwatch = Stopwatch.StartNew();
        int read;
        while ((read = await _compressed.ReadAsync(buffer)) > 0)
        {
            await stream.WriteAsync(buffer.AsMemory(0, read));
            sent += read;
            var expectedElapsedMs = sent * 1000d / bytesPerSecond;
            var delayMs = expectedElapsedMs - stopwatch.Elapsed.TotalMilliseconds;
            if (delayMs > 1)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(delayMs));
            }
        }
    }
    protected override bool TryComputeLength(out long length)
    {
        length = _compressed.Length;
        return true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _inner.Dispose();
            _compressed.Dispose();
        }
        base.Dispose(disposing);
    }
}



