using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
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
            var sentAny = await ProcessSpoolOnce(config, state, http, logger, endpointSeed);
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
            logger.Error($"Unhandled shipper error: {ex.Message}; delaying {delay.TotalSeconds:F0}s attempt={attempt}.");
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

static async Task<bool> ProcessSpoolOnce(ShipperConfig config, ShipperState state, HttpClient http, FileLogger logger, string endpointSeed)
{
    var files = Directory.GetFiles(config.SpoolDirectory, "*.ndjson")
        .OrderBy(File.GetCreationTimeUtc)
        .ThenBy(Path.GetFileName, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    foreach (var file in files)
    {
        var checkpoint = state.GetCheckpoint(file);
        var batch = await ReadBatch(file, checkpoint.LineOffset, config.MaxEvents, config.MaxBytes);
        if (batch.Lines.Count == 0)
        {
            TryArchiveEmptyOrFullyReadFile(file, checkpoint.LineOffset, logger);
            continue;
        }

        var jitterWindow = checkpoint.LineOffset == 0 ? config.NormalJitterWindowSeconds : Math.Min(config.RecoveryJitterWindowSeconds, Math.Max(config.NormalJitterWindowSeconds, config.RecoveryJitterWindowSeconds));
        var jitter = StableJitterSeconds(endpointSeed + ":" + Path.GetFileName(file) + ":" + checkpoint.LineOffset, jitterWindow);
        if (jitter > 0)
        {
            logger.Info($"Applying deterministic send jitter {jitter}s for {Path.GetFileName(file)} offset={checkpoint.LineOffset}.");
            await Task.Delay(TimeSpan.FromSeconds(jitter));
        }

        var payload = "[" + string.Join(",", batch.Lines) + "]";
        using var content = new StringContent(payload, Encoding.UTF8, "application/json");
        content.Headers.ContentEncoding.Add("gzip");
        using var gzipped = await GzipContent.Create(content);
        using var req = new HttpRequestMessage(HttpMethod.Post, config.GatewayUri) { Content = gzipped };
        req.Headers.UserAgent.ParseAdd("HostEyeShipper/1.0");

        logger.Info($"Sending file={Path.GetFileName(file)} offset={checkpoint.LineOffset} events={batch.Lines.Count} bytes={Encoding.UTF8.GetByteCount(payload)}.");
        using var resp = await http.SendAsync(req);
        if ((int)resp.StatusCode == 429 || resp.StatusCode == HttpStatusCode.ServiceUnavailable)
        {
            var retryAfter = resp.Headers.RetryAfter?.Delta?.TotalSeconds;
            throw new BackpressureException((int)resp.StatusCode, retryAfter is null ? null : (int)Math.Ceiling(retryAfter.Value));
        }
        if (!resp.IsSuccessStatusCode)
        {
            throw new Exception($"Gateway returned {(int)resp.StatusCode} {resp.ReasonPhrase}");
        }

        state.SetCheckpoint(file, checkpoint.LineOffset + batch.Lines.Count);
        state.Save();
        logger.Info($"Sent OK file={Path.GetFileName(file)} new_offset={checkpoint.LineOffset + batch.Lines.Count}.");
        TryArchiveEmptyOrFullyReadFile(file, checkpoint.LineOffset + batch.Lines.Count, logger);
        return true;
    }

    return false;
}

static async Task<Batch> ReadBatch(string file, int skipLines, int maxEvents, int maxBytes)
{
    var lines = new List<string>();
    var bytes = 2;
    var index = 0;
    using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
    while (await reader.ReadLineAsync() is { } line)
    {
        if (index++ < skipLines) continue;
        if (string.IsNullOrWhiteSpace(line)) continue;
        using (JsonDocument.Parse(line)) { }
        var lineBytes = Encoding.UTF8.GetByteCount(line) + (lines.Count > 0 ? 1 : 0);
        if (lines.Count > 0 && (lines.Count >= maxEvents || bytes + lineBytes > maxBytes)) break;
        lines.Add(line);
        bytes += lineBytes;
        if (lines.Count >= maxEvents || bytes >= maxBytes) break;
    }
    return new Batch(lines);
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

static void TryArchiveEmptyOrFullyReadFile(string file, int lineOffset, FileLogger logger)
{
    try
    {
        var total = File.ReadLines(file).Count(l => !string.IsNullOrWhiteSpace(l));
        if (total == 0 || lineOffset >= total)
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
    var handler = new HttpClientHandler();
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
            using var customChain = new X509Chain();
            customChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            customChain.ChainPolicy.CustomTrustStore.Add(trustedRoot);
            customChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            customChain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            return customChain.Build(new X509Certificate2(cert));
        };
        logger.Info($"Loaded custom CA trust: {config.CaCertificateFile}");
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

record Batch(List<string> Lines);
record QuotaFile(string FullName, bool IsSent);

class BackpressureException(int statusCode, int? retryAfterSeconds) : Exception($"Backpressure {statusCode}")
{
    public int StatusCode { get; } = statusCode;
    public int? RetryAfterSeconds { get; } = retryAfterSeconds;
}

class ShipperConfig
{
    public string GatewayUri { get; set; } = "https://soc-gateway.yourcorporate.com/api/v1/telemetry";
    public string SpoolDirectory { get; set; } = "C:\\ProgramData\\HostEye\\spool";
    public string StateDirectory { get; set; } = "C:\\ProgramData\\HostEye\\shipper_state";
    public string LogDirectory { get; set; } = "C:\\ProgramData\\HostEye\\logs";
    public string ClientCertificateFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\client.crt";
    public string ClientKeyFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\client.key";
    public string CaCertificateFile { get; set; } = "C:\\Program Files\\HostEye\\certs\\company_ca.crt";
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
            cp = new FileCheckpoint { LineOffset = 0 };
            Files[key] = cp;
        }
        return cp;
    }

    public void SetCheckpoint(string file, int lineOffset)
    {
        var key = System.IO.Path.GetFullPath(file);
        Files[key] = new FileCheckpoint { LineOffset = lineOffset, UpdatedAtUtc = DateTimeOffset.UtcNow };
    }

    public void Save()
    {
        File.WriteAllText(PathOnDisk, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

class FileCheckpoint
{
    public int LineOffset { get; set; }
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

    GzipContent(HttpContent inner, MemoryStream compressed)
    {
        _inner = inner;
        _compressed = compressed;
        Headers.ContentType = inner.Headers.ContentType;
        Headers.ContentEncoding.Add("gzip");
    }

    public static async Task<GzipContent> Create(HttpContent inner)
    {
        var compressed = new MemoryStream();
        await using (var gzip = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionLevel.Fastest, leaveOpen: true))
        {
            await inner.CopyToAsync(gzip);
        }
        compressed.Position = 0;
        return new GzipContent(inner, compressed);
    }

    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => _compressed.CopyToAsync(stream);
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



