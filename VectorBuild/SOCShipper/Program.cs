using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;
using System.Collections.Generic;
using SOCShipper.Services;

// ----------------------------------------------------------------------
// PHẦN KHỞI TẠO CẤU HÌNH VÀ THƯ MỤC CƠ SỞ
// ----------------------------------------------------------------------
var configPath = args.Length > 0 ? args[0] : Path.Combine(AppContext.BaseDirectory, "shipper-config.json");
var config = ShipperConfig.Load(configPath);
Directory.CreateDirectory(config.SpoolDirectory);
Directory.CreateDirectory(config.StateDirectory);
Directory.CreateDirectory(config.LogDirectory);
var logger = new FileLogger(Path.Combine(config.LogDirectory, "shipper.log"));

// Phần quản lý Checkpoint cũ (Không thay đổi thiết kế)
var state = ShipperState.Load(Path.Combine(config.StateDirectory, "shipper-state.json"));
var endpointSeed = Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID")
    ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID")
    ?? Environment.MachineName
    ?? Guid.NewGuid().ToString("n");

logger.Info($"HostEyeShipper starting Phase 3. Config={configPath} Spool={config.SpoolDirectory}");
using var http = BuildHttpClient(config, logger);
using var cleanupCts = new CancellationTokenSource();
var cleanupTask = config.MaxSpoolSizeMB > 0
    ? RunSpoolQuotaLoop(config, logger, cleanupCts.Token)
    : Task.CompletedTask;

// Khởi tạo các Module Phase 3 theo đúng chuẩn SRP (Tách biệt Control Plane và Data Plane)
var jitterScheduler = new JitterScheduler();

// Khởi tạo ConfigSynchronizer với địa chỉ Control Plane
var configSync = new ConfigSynchronizer(http, config.ControlPlaneUri, configPath);

// Khởi tạo AdmissionClient và TransportManager truyền configSync vào để chúng tự lấy Routing Data Plane động
var admissionClient = new AdmissionClient(http, configSync, endpointSeed, jitterScheduler);
var transportManager = new TransportManager(admissionClient, http, config.SpoolDirectory, configSync, state);

// ----------------------------------------------------------------------
// VÒNG LẶP CHÍNH CỦA CHƯƠNG TRÌNH
// ----------------------------------------------------------------------
try
{
    // BƯỚC 0: ĐỒNG BỘ LẦN ĐẦU TIÊN KHI VỪA BẬT MÁY ĐỂ LẤY DATA PLANE URI
    logger.Info($"[Main] Đang lấy Data Plane Routing từ Control Plane: {config.ControlPlaneUri}");
    await configSync.SyncConfigAsync();

    // BƯỚC 1: STARTUP JITTER (Chống hiệu ứng bầy đàn khi khởi động)
    var startupDelay = jitterScheduler.GetStartupDelay(300); // Tối đa 5 phút
    logger.Info($"[Main] Áp dụng Startup Jitter. Chương trình sẽ ngủ đông {startupDelay.TotalSeconds} giây...");
    await Task.Delay(startupDelay);

    DateTime lastConfigSync = DateTime.MinValue;

    while (true)
    {
        try
        {
            // BƯỚC 2: ĐỒNG BỘ CẤU HÌNH ETAG (Có Periodic Jitter)
            // Định kỳ đồng bộ 30 phút, cộng thêm nhiễu ngẫu nhiên
            if (DateTime.UtcNow - lastConfigSync > TimeSpan.FromMinutes(30))
            {
                var periodicJitter = jitterScheduler.GetPeriodicDelay(baseSeconds: 1800, jitterSeconds: 300);
                if (DateTime.UtcNow - lastConfigSync > periodicJitter)
                {
                    logger.Info("[Main] Tiến hành đồng bộ cấu hình ETag...");
                    await configSync.SyncConfigAsync();
                    lastConfigSync = DateTime.UtcNow;
                }
            }

            // BƯỚC 3: XỬ LÝ QUEUE VÀ GỬI LÊN SERVER
            // Mọi nghiệp vụ Checkpoint, Xin phép Lease, Gắn Chunk Metadata đều nằm gọn trong này
            bool sentAny = await transportManager.ProcessSpoolOnceAsync();
            
            if (sentAny)
            {
                if (config.RunOnce)
                {
                    logger.Info("RunOnce mode: Đã hoàn tất gửi 1 lượt. Đang tắt chương trình.");
                    return 0;
                }
            }
            else if (config.RunOnce)
            {
                logger.Info("RunOnce mode: Spool trống, không có gì để gửi.");
                return 0;
            }
            else
            {
                // Queue đang rỗng, nghỉ 5 giây rồi kiểm tra lại ổ cứng
                await Task.Delay(TimeSpan.FromSeconds(5)); 
            }
        }
        catch (Exception ex)
        {
            logger.Error($"[Main] Lỗi vòng lặp chính: {ex.Message}");
            // Mọi lỗi mạng (Exception) sẽ tự động kích hoạt Retry Jitter bên trong các Module 
            // Nếu thoát ra tới đây, ta chỉ cần chờ ngắn và chạy lại vòng lặp.
            await Task.Delay(TimeSpan.FromSeconds(5)); 
        }
    }
}
finally
{
    await StopCleanupLoop(cleanupCts, cleanupTask, logger);
}


// ----------------------------------------------------------------------
// CÁC HÀM QUẢN LÝ DUNG LƯỢNG Ổ CỨNG (SPOOL POLICY) GIỮ NGUYÊN
// ----------------------------------------------------------------------
static async Task RunSpoolQuotaLoop(ShipperConfig config, FileLogger logger, CancellationToken token)
{
    logger.Info($"Spool quota loop enabled. MaxSpoolSizeMB={config.MaxSpoolSizeMB}");
    while (!token.IsCancellationRequested)
    {
        try { EnforceSpoolPolicy(config, logger); }
        catch (Exception ex) { logger.Warn($"Spool quota check failed: {ex.Message}"); }

        try { await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, config.SpoolCheckIntervalSeconds)), token); }
        catch (OperationCanceledException) { break; }
    }
}

static async Task StopCleanupLoop(CancellationTokenSource cleanupCts, Task cleanupTask, FileLogger logger)
{
    try { cleanupCts.Cancel(); await cleanupTask; } catch { }
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

        logger.Info($"Spool size {totalBytes} bytes exceeds max; trimming to {targetBytes} bytes.");
        foreach (var file in GetDeletionCandidates(config))
        {
            if (totalBytes <= targetBytes) break;
            try
            {
                var length = new FileInfo(file.FullName).Length;
                File.Delete(file.FullName);
                totalBytes -= length;
            }
            catch { }
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
            if (info.LastWriteTimeUtc <= cutoffUtc.UtcDateTime) info.Delete();
        }
        catch { }
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
        foreach (var file in Directory.EnumerateFiles(sentDir, "*", SearchOption.TopDirectoryOnly).OrderBy(File.GetLastWriteTimeUtc))
            yield return new QuotaFile(file, true);
    }
    if (!Directory.Exists(config.SpoolDirectory)) yield break;
    foreach (var file in Directory.EnumerateFiles(config.SpoolDirectory, "*.ndjson", SearchOption.TopDirectoryOnly).OrderBy(File.GetCreationTimeUtc))
        yield return new QuotaFile(file, false);
}

static HttpClient BuildHttpClient(ShipperConfig config, FileLogger logger)
{
    var handler = new HttpClientHandler();
    if (File.Exists(config.ClientCertificateFile) && File.Exists(config.ClientKeyFile))
    {
        var cert = X509Certificate2.CreateFromPemFile(config.ClientCertificateFile, config.ClientKeyFile);
        handler.ClientCertificates.Add(new X509Certificate2(cert.Export(X509ContentType.Pkcs12)));
    }
    if (File.Exists(config.CaCertificateFile))
    {
        var trustedRoot = new X509Certificate2(config.CaCertificateFile);
        handler.ServerCertificateCustomValidationCallback = (_, cert, chain, errors) =>
        {
            if (cert is null) return false;
            using var customChain = new X509Chain();
            customChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            customChain.ChainPolicy.CustomTrustStore.Add(trustedRoot);
            customChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            customChain.ChainPolicy.VerificationFlags = X509VerificationFlags.NoFlag;
            return customChain.Build(new X509Certificate2(cert));
        };
    }
    return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(60) };
}

record QuotaFile(string FullName, bool IsSent);

// ----------------------------------------------------------------------
// CONFIGURATION VÀ CHECKPOINT MODELS ĐƯỢC GIỮ NGUYÊN (KHÔNG ĐỤNG CHẠM)
// ----------------------------------------------------------------------
public class ShipperConfig
{
    // Địa chỉ của Tổng công ty (Control Plane) dùng để đồng bộ ETag và lấy Routing Data Plane
    public string ControlPlaneUri { get; set; } = "https://controlplane.yourcorporate.com/api/v1/agent/config";
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

public class ShipperState
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

public class FileCheckpoint
{
    public int LineOffset { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}

public class FileLogger
{
    private readonly string path;
    public FileLogger(string path) { this.path = path; }
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
