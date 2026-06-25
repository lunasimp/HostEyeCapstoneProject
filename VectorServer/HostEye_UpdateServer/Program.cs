var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var contentRoot = AppContext.BaseDirectory;
var masterConfigPath = Path.Combine(contentRoot, "master-vector.toml");
var masterSignaturePath = Path.Combine(contentRoot, "master-vector.toml.sig");
var manifestPath = Path.Combine(contentRoot, "manifest.json");
var manifestSignaturePath = Path.Combine(contentRoot, "manifest.json.sig");

IResult SendFileIfExists(string path, string contentType, string downloadName)
{
    if (!File.Exists(path))
    {
        return Results.NotFound(new { message = $"{downloadName} not found." });
    }

    return Results.File(File.ReadAllBytes(path), contentType, downloadName);
}

app.MapGet("/api/v1/agent/config/vector.toml", () =>
    SendFileIfExists(masterConfigPath, "application/toml", "vector.toml"));

app.MapGet("/api/v1/agent/config/vector.toml.sig", () =>
    SendFileIfExists(masterSignaturePath, "application/octet-stream", "vector.toml.sig"));

app.MapGet("/api/v1/agent/config/manifest.json", () =>
    SendFileIfExists(manifestPath, "application/json", "manifest.json"));

app.MapGet("/api/v1/agent/config/manifest.json.sig", () =>
    SendFileIfExists(manifestSignaturePath, "application/octet-stream", "manifest.json.sig"));

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.Run("http://0.0.0.0:5053");
