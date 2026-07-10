using System.Text.Json;
using System.Text.Json.Serialization;

namespace SOCShipper.Models;

public class ShipperState
{
    public Dictionary<string, FileCheckpoint> Files { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public string AgentConfigEtag { get; set; } = "";
    public string AgentConfigPolicyId { get; set; } = "";
    public int AgentConfigPolicyVersion { get; set; }
    public string AgentConfigSha256 { get; set; } = "";
    public string AgentConfigCachedJson { get; set; } = "";
    public DateTimeOffset? LastSuccessTime { get; set; }
    [JsonIgnore]
    public string PathOnDisk { get; private set; } = "";

    public static ShipperState Load(string path)
    {
        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        if (!System.IO.File.Exists(path)) return new ShipperState { PathOnDisk = path };
        var state = JsonSerializer.Deserialize<ShipperState>(System.IO.File.ReadAllText(path)) ?? new ShipperState();
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
        System.IO.File.WriteAllText(PathOnDisk, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

public class FileCheckpoint
{
    public int LineOffset { get; set; }
    public long ByteOffset { get; set; }
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
