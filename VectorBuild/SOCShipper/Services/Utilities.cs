using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using SOCShipper.Models;

namespace SOCShipper.Services;

public static class Utilities
{
    public static HttpClient BuildHttpClient(ShipperConfig config, FileLogger logger)
    {
        var handler = new HttpClientHandler
        {
            UseProxy = false
        };
        if (System.IO.File.Exists(config.ClientCertificateFile) && System.IO.File.Exists(config.ClientKeyFile))
        {
            var cert = X509Certificate2.CreateFromPemFile(config.ClientCertificateFile, config.ClientKeyFile);
            handler.ClientCertificates.Add(new X509Certificate2(cert.Export(X509ContentType.Pkcs12)));
            logger.Info($"Loaded client certificate: {config.ClientCertificateFile}");
        }
        else
        {
            logger.Info("WARNING: client certificate/key missing; mTLS request will likely fail.");
        }

        if (System.IO.File.Exists(config.CaCertificateFile))
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

    public static string Sha256Hex(string value)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static string HmacSha256Hex(string key, string value)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
        return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    }

    public static bool FixedTimeEqualsHex(string left, string right)
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

    public static string DeriveEndpointUri(string gatewayUri, string path)
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

    public static bool TryGetInt(JsonElement root, string name, out int value)
    {
        value = 0;
        if (!root.TryGetProperty(name, out var property)) return false;
        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value)) return true;
        return property.ValueKind == JsonValueKind.String && int.TryParse(property.GetString(), out value);
    }

    public static int GetJsonInt(JsonElement root, string name)
    {
        return TryGetInt(root, name, out var value) ? value : 0;
    }

    public static double GetJsonDouble(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var property)) return 0;
        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var value)) return value;
        return property.ValueKind == JsonValueKind.String && double.TryParse(property.GetString(), out value) ? value : 0;
    }

    public static string GetJsonString(JsonElement root, string name)
    {
        return root.TryGetProperty(name, out var property) ? property.GetString() ?? "" : "";
    }

    public static DateTimeOffset? GetJsonDateTimeOffset(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var property)) return null;
        var value = property.GetString();
        return DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
    }

    public static int MillisecondsToSeconds(int value)
    {
        return value <= 0 ? 0 : Math.Max(1, (int)Math.Ceiling(value / 1000d));
    }

    public static string GetEndpointComputerName()
    {
        return Environment.GetEnvironmentVariable("HOSTEYE_COMPUTER_NAME")
            ?? Environment.GetEnvironmentVariable("COMPUTERNAME")
            ?? Environment.MachineName
            ?? "";
    }

    public static string GetAgentId()
    {
        return Environment.GetEnvironmentVariable("HOSTEYE_AGENT_ID")
            ?? Environment.GetEnvironmentVariable("VECTOR_AGENT_ID")
            ?? Environment.MachineName
            ?? "unknown-agent";
    }

    public static string GetHostId()
    {
        return Environment.GetEnvironmentVariable("HOSTEYE_HOST_ID")
            ?? Environment.GetEnvironmentVariable("VECTOR_HOST_ID")
            ?? Environment.MachineName
            ?? "unknown-host";
    }
}

public class GzipContent : HttpContent
{
    private readonly HttpContent _inner;
    private readonly MemoryStream _compressed;
    private readonly int _maxUploadRateKbps;
    public long CompressedLength => _compressed.Length;

    private GzipContent(HttpContent inner, MemoryStream compressed, int maxUploadRateKbps)
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
