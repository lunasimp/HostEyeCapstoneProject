using System.Text.Json;

namespace SOCShipper.Models;

public class ShipperConfig
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
    public int StartupJitterWindowSeconds { get; set; } = 300;
    public int NormalJitterWindowSeconds { get; set; } = 120;
    public int RecoveryJitterWindowSeconds { get; set; } = 900;
    public int BaseBackoffSeconds { get; set; } = 2;
    public int MaxBackoffSeconds { get; set; } = 300;
    public long MaxSpoolSizeMB { get; set; } = 8192;
    public int LowWatermarkPercent { get; set; } = 85;
    public int SpoolCheckIntervalSeconds { get; set; } = 30;
    public int ConfigSyncIntervalSeconds { get; set; } = 1800;
    public int ConfigSyncJitterSeconds { get; set; } = 300;
    public bool PreferDeletingSentFirst { get; set; } = true;
    public int SentRetentionDays { get; set; } = 2;
    public bool EnableConfigSync { get; set; } = true;
    public bool EnableAdmissionControl { get; set; } = true;
    public bool RequireUploadLease { get; set; } = true;
    public bool RunOnce { get; set; }

    public static ShipperConfig Load(string path)
    {
        if (!System.IO.File.Exists(path)) return new ShipperConfig();
        var json = System.IO.File.ReadAllText(path);
        return JsonSerializer.Deserialize<ShipperConfig>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new ShipperConfig();
    }
}
