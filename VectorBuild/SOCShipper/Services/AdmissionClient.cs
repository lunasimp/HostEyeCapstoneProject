using System.Net;
using System.Text;
using System.Text.Json;
using SOCShipper.Models;

namespace SOCShipper.Services;

public class AdmissionClient
{
    private readonly ShipperConfig _config;
    private readonly HttpClient _http;
    private readonly FileLogger _logger;
    private readonly ShipperState _state;

    public AdmissionClient(ShipperConfig config, HttpClient http, FileLogger logger, ShipperState state)
    {
        _config = config;
        _http = http;
        _logger = logger;
        _state = state;
    }

    public async Task<UploadLease> TryRequestAdmissionAsync(double nextChunkSizeMb, SpoolStats spoolStats, int retryAttempt)
    {
        if (!_config.EnableAdmissionControl) return UploadLease.Disabled();
        var admissionUri = string.IsNullOrWhiteSpace(_config.AdmissionUri)
            ? Utilities.DeriveEndpointUri(_config.GatewayUri, "/api/v1/admission/request")
            : _config.AdmissionUri;

        var request = new Dictionary<string, object?>
        {
            ["agent_id"] = Utilities.GetAgentId(),
            ["host_id"] = Utilities.GetHostId(),
            ["computer"] = Utilities.GetEndpointComputerName(),
            ["queue_used_mb"] = Math.Round(spoolStats.Bytes / 1024d / 1024d, 3),
            ["next_chunk_size_mb"] = Math.Round(nextChunkSizeMb, 3),
            ["retry_count"] = retryAttempt,
            ["rank"] = Math.Max(0, retryAttempt),
            ["last_success_time"] = _state.LastSuccessTime?.ToString("O")
        };

        try
        {
            using var content = new StringContent(JsonSerializer.Serialize(request), Encoding.UTF8, "application/json");
            using var resp = await _http.PostAsync(admissionUri, content);
            var body = await resp.Content.ReadAsStringAsync();
            if (resp.StatusCode == HttpStatusCode.NotFound || resp.StatusCode == HttpStatusCode.MethodNotAllowed)
            {
                if (_config.RequireUploadLease)
                {
                    throw new BackpressureException(503, 30);
                }
                _logger.Warn($"Admission endpoint unavailable at {admissionUri}; continuing without enforced lease.");
                return UploadLease.Disabled();
            }
            if ((int)resp.StatusCode == 429 || resp.StatusCode == HttpStatusCode.ServiceUnavailable)
            {
                var retryAfter = resp.Headers.RetryAfter?.Delta?.TotalSeconds;
                throw new BackpressureException((int)resp.StatusCode, retryAfter is null ? 15 : (int)Math.Ceiling(retryAfter.Value));
            }
            if (!resp.IsSuccessStatusCode)
            {
                if (_config.RequireUploadLease)
                {
                    throw new Exception($"Admission request failed: {(int)resp.StatusCode} {resp.ReasonPhrase}; body={body}");
                }
                _logger.Warn($"Admission request returned {(int)resp.StatusCode} {resp.ReasonPhrase}; continuing without enforced lease. Body={body}");
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
            var ttlSeconds = Utilities.GetJsonInt(doc.RootElement, "lease_ttl_seconds");
            var expiresAt = Utilities.GetJsonDateTimeOffset(doc.RootElement, "lease_expires_at") ?? issuedAt.AddSeconds(Math.Max(1, ttlSeconds));
            var lease = new UploadLease(
                LeaseId: Utilities.GetJsonString(doc.RootElement, "lease_id"),
                IssuedAtUtc: issuedAt,
                ExpiresAtUtc: expiresAt,
                LeaseTtlSeconds: ttlSeconds,
                MaxBatchMb: Utilities.GetJsonDouble(doc.RootElement, "max_batch_mb"),
                MaxUploadRateKbps: Utilities.GetJsonInt(doc.RootElement, "max_upload_rate_kbps"),
                Required: _config.RequireUploadLease);

            var collectorUrl = Utilities.GetJsonString(doc.RootElement, "collector_url");
            if (string.IsNullOrWhiteSpace(collectorUrl) &&
                doc.RootElement.TryGetProperty("routing", out var routing))
            {
                collectorUrl = Utilities.GetJsonString(routing, "telemetry_url");
            }
            if (Uri.TryCreate(collectorUrl, UriKind.Absolute, out _))
            {
                _config.GatewayUri = collectorUrl;
            }

            if (_config.RequireUploadLease && string.IsNullOrWhiteSpace(lease.LeaseId))
            {
                throw new Exception("Admission response did not include lease_id.");
            }

            EnsureUploadLeaseUsable(lease);
            var sendAfter = Utilities.GetJsonDateTimeOffset(doc.RootElement, "send_after");
            if (sendAfter is not null && sendAfter.Value > DateTimeOffset.UtcNow)
            {
                var delay = sendAfter.Value - DateTimeOffset.UtcNow;
                _logger.Info($"Admission send_after={sendAfter.Value:O}; delaying {delay.TotalSeconds:F0}s before upload.");
                await Task.Delay(delay);
                EnsureUploadLeaseUsable(lease);
            }
            _logger.Info($"Admission OK lease={lease.LeaseId} collector_url={_config.GatewayUri} ttl={lease.LeaseTtlSeconds}s max_batch_mb={lease.MaxBatchMb:F3} max_upload_rate_kbps={lease.MaxUploadRateKbps}.");
            return lease;
        }
        catch (BackpressureException)
        {
            throw;
        }
        catch (Exception ex)
        {
            if (_config.RequireUploadLease)
            {
                throw;
            }
            _logger.Warn($"Admission request skipped: {ex.Message}");
            return UploadLease.Disabled();
        }
    }

    public void EnsureUploadLeaseUsable(UploadLease lease)
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
    }
}
