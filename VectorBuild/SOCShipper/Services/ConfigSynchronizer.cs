using System.Net;
using System.Text;
using System.Text.Json;
using SOCShipper.Models;

namespace SOCShipper.Services;

public class ConfigSynchronizer
{
    private readonly ShipperConfig _config;
    private readonly HttpClient _http;
    private readonly ShipperState _state;
    private readonly FileLogger _logger;
    private readonly JitterScheduler _jitter;

    public ConfigSynchronizer(ShipperConfig config, HttpClient http, ShipperState state, FileLogger logger, JitterScheduler jitter)
    {
        _config = config;
        _http = http;
        _state = state;
        _logger = logger;
        _jitter = jitter;
    }

    public async Task TrySyncAgentConfigAsync()
    {
        if (!_config.EnableConfigSync) return;
        var configUri = string.IsNullOrWhiteSpace(_config.ConfigUri)
            ? Utilities.DeriveEndpointUri(_config.GatewayUri, "/api/v1/agent/config")
            : _config.ConfigUri;

        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Get, configUri);
            AddAgentConfigHeaders(req);
            if (!string.IsNullOrWhiteSpace(_state.AgentConfigEtag))
            {
                req.Headers.TryAddWithoutValidation("If-None-Match", _state.AgentConfigEtag);
            }
            using var resp = await _http.SendAsync(req);
            if (resp.StatusCode == HttpStatusCode.NotModified)
            {
                _logger.Info($"Agent config unchanged etag={_state.AgentConfigEtag}.");
                return;
            }
            if (!resp.IsSuccessStatusCode)
            {
                _logger.Warn($"Agent config sync skipped: {(int)resp.StatusCode} {resp.ReasonPhrase}.");
                return;
            }

            var body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var ackStatus = "applied";
            var ackMessage = "legacy config applied";
            if (root.TryGetProperty("signed_policy", out var signedPolicy))
            {
                var verify = VerifySignedPolicy(signedPolicy);
                if (!verify.Valid)
                {
                    _logger.Error($"Agent config signature verification failed: {verify.Message}");
                    await TryAckAgentConfigAsync(root, "verify_failed", verify.Message);
                    return;
                }

                if (signedPolicy.TryGetProperty("config", out var signedConfig))
                {
                    ApplyServerConfig(signedConfig);
                }
                ApplyServerConfig(root);
                _state.AgentConfigPolicyId = Utilities.GetJsonString(signedPolicy, "policy_id");
                _state.AgentConfigPolicyVersion = Utilities.GetJsonInt(signedPolicy, "version");
                _state.AgentConfigSha256 = Utilities.GetJsonString(signedPolicy, "config_sha256");
                _state.AgentConfigCachedJson = signedPolicy.GetRawText();
                ackMessage = "signed policy verified and applied";
            }
            else
            {
                ApplyServerConfig(root);
                _state.AgentConfigPolicyId = Utilities.GetJsonString(root, "policy_id");
                _state.AgentConfigPolicyVersion = Utilities.GetJsonInt(root, "policy_version");
                _state.AgentConfigCachedJson = root.GetRawText();
            }
            if (resp.Headers.ETag is not null)
            {
                _state.AgentConfigEtag = resp.Headers.ETag.Tag;
            }
            await TryAckAgentConfigAsync(root, ackStatus, ackMessage);
            _logger.Info($"Agent config synced from {configUri}; etag={_state.AgentConfigEtag}; MaxEvents={_config.MaxEvents}; MaxBytes={_config.MaxBytes}; NormalJitter={_config.NormalJitterWindowSeconds}s; RecoveryJitter={_config.RecoveryJitterWindowSeconds}s.");
        }
        catch (Exception ex)
        {
            _logger.Warn($"Agent config sync skipped: {ex.Message}");
        }
    }

    private void ApplyServerConfig(JsonElement root)
    {
        if (Utilities.TryGetInt(root, "max_events", out var maxEvents) && maxEvents > 0) _config.MaxEvents = maxEvents;
        if (Utilities.TryGetInt(root, "max_bytes", out var maxBytes) && maxBytes > 0) _config.MaxBytes = maxBytes;
        if (Utilities.TryGetInt(root, "normal_jitter_window_ms", out var normalJitterMs)) _config.NormalJitterWindowSeconds = Utilities.MillisecondsToSeconds(normalJitterMs);
        if (Utilities.TryGetInt(root, "recovery_jitter_window_ms", out var recoveryJitterMs)) _config.RecoveryJitterWindowSeconds = Utilities.MillisecondsToSeconds(recoveryJitterMs);

        if (root.TryGetProperty("routing", out var routing))
        {
            var telemetryUrl = Utilities.GetJsonString(routing, "telemetry_url");
            var admissionUrl = Utilities.GetJsonString(routing, "admission_url");
            var configUrl = Utilities.GetJsonString(routing, "config_url");
            if (Uri.TryCreate(telemetryUrl, UriKind.Absolute, out _)) _config.GatewayUri = telemetryUrl;
            if (Uri.TryCreate(admissionUrl, UriKind.Absolute, out _)) _config.AdmissionUri = admissionUrl;
            if (Uri.TryCreate(configUrl, UriKind.Absolute, out _)) _config.ConfigUri = configUrl;
        }

        if (root.TryGetProperty("limits", out var limits))
        {
            if (Utilities.TryGetInt(limits, "max_events", out maxEvents) && maxEvents > 0) _config.MaxEvents = maxEvents;
            if (Utilities.TryGetInt(limits, "max_bytes", out maxBytes) && maxBytes > 0) _config.MaxBytes = maxBytes;
        }

        if (root.TryGetProperty("jitter", out var jitter))
        {
            if (Utilities.TryGetInt(jitter, "normal_jitter_window_ms", out normalJitterMs)) _config.NormalJitterWindowSeconds = Utilities.MillisecondsToSeconds(normalJitterMs);
            if (Utilities.TryGetInt(jitter, "recovery_jitter_window_ms", out recoveryJitterMs)) _config.RecoveryJitterWindowSeconds = Utilities.MillisecondsToSeconds(recoveryJitterMs);
        }
    }

    private (bool Valid, string Message) VerifySignedPolicy(JsonElement signedPolicy)
    {
        var algorithm = Utilities.GetJsonString(signedPolicy, "signature_algorithm");
        if (!string.Equals(algorithm, "hmac-sha256", StringComparison.OrdinalIgnoreCase))
        {
            return (false, $"unsupported signature_algorithm={algorithm}");
        }
        if (!signedPolicy.TryGetProperty("config", out var policyConfig))
        {
            return (false, "signed policy missing config");
        }

        var expectedHash = Utilities.GetJsonString(signedPolicy, "config_sha256");
        var actualHash = Utilities.Sha256Hex(policyConfig.GetRawText());
        if (!string.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
        {
            return (false, "config_sha256 mismatch");
        }

        var signature = Utilities.GetJsonString(signedPolicy, "signature");
        var expectedSignature = Utilities.HmacSha256Hex(_config.AgentConfigSigningKey, SignedPolicyText(signedPolicy));
        if (!Utilities.FixedTimeEqualsHex(signature, expectedSignature))
        {
            return (false, "signature mismatch");
        }

        _logger.Info($"Verified signed policy id={Utilities.GetJsonString(signedPolicy, "policy_id")} version={Utilities.GetJsonInt(signedPolicy, "version")} key_id={Utilities.GetJsonString(signedPolicy, "key_id")}.");
        return (true, "ok");
    }

    private string SignedPolicyText(JsonElement envelope)
    {
        return string.Join("\n", new[]
        {
            "HOSTEYE_DYNAMIC_CONFIG_V1",
            Utilities.GetJsonString(envelope, "signature_algorithm"),
            Utilities.GetJsonString(envelope, "key_id"),
            Utilities.GetJsonString(envelope, "policy_id"),
            Utilities.GetJsonInt(envelope, "version").ToString(),
            Utilities.GetJsonString(envelope, "issued_at"),
            Utilities.GetJsonString(envelope, "expires_at"),
            Utilities.GetJsonString(envelope, "agent_id"),
            Utilities.GetJsonString(envelope, "host_id"),
            Utilities.GetJsonString(envelope, "group_id"),
            Utilities.GetJsonString(envelope, "config_sha256")
        });
    }

    private async Task TryAckAgentConfigAsync(JsonElement root, string status, string message)
    {
        try
        {
            var ackUri = Utilities.DeriveEndpointUri(string.IsNullOrWhiteSpace(_config.ConfigUri) ? _config.GatewayUri : _config.ConfigUri, "/api/v1/agent/config/ack");
            var policy = root.TryGetProperty("signed_policy", out var signedPolicy) ? signedPolicy : root;
            var payload = new Dictionary<string, object?>
            {
                ["agent_id"] = Utilities.GetAgentId(),
                ["host_id"] = Utilities.GetHostId(),
                ["computer"] = Utilities.GetEndpointComputerName(),
                ["source_platform"] = "hosteye_windows_endpoint",
                ["policy_id"] = Utilities.GetJsonString(policy, "policy_id"),
                ["version"] = Utilities.GetJsonInt(policy, "version") == 0 ? Utilities.GetJsonInt(root, "policy_version") : Utilities.GetJsonInt(policy, "version"),
                ["status"] = status,
                ["message"] = message,
                ["applied_at"] = DateTimeOffset.UtcNow.ToString("O")
            };
            using var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
            using var req = new HttpRequestMessage(HttpMethod.Post, ackUri) { Content = content };
            AddAgentConfigHeaders(req);
            using var resp = await _http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                _logger.Warn($"Agent config ACK returned {(int)resp.StatusCode} {resp.ReasonPhrase}.");
            }
        }
        catch (Exception ex)
        {
            _logger.Warn($"Agent config ACK skipped: {ex.Message}");
        }
    }

    private void AddAgentConfigHeaders(HttpRequestMessage req)
    {
        req.Headers.TryAddWithoutValidation("x-hosteye-agent-id", Utilities.GetAgentId());
        req.Headers.TryAddWithoutValidation("x-hosteye-host-id", Utilities.GetHostId());
        req.Headers.TryAddWithoutValidation("x-hosteye-group-id", _config.GroupId);
    }
}
