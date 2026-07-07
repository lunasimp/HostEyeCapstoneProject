const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CONFIG_ARTIFACT_FILES = new Set(["manifest.json", "manifest.json.sig", "vector.toml", "vector.toml.sig"]);

function buildAgentConfig(env = process.env) {
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || "https://hosteye.iahn.hanoi.vn").replace(/\/+$/, "");
  return {
    config_version: env.AGENT_CONFIG_VERSION || "1.0.0",
    schema_version: env.REQUIRED_SCHEMA_VERSION || "1.0.0",
    normal_jitter_window_ms: Number(env.AGENT_NORMAL_JITTER_WINDOW_MS || 30000),
    recovery_jitter_window_ms: Number(env.AGENT_RECOVERY_JITTER_WINDOW_MS || 300000),
    max_events: Number(env.AGENT_MAX_EVENTS || 500),
    max_bytes: Number(env.AGENT_MAX_BYTES || 524288),
    enabled: String(env.AGENT_ENABLED || "true").toLowerCase() !== "false",
    routing: {
      control_url: `${publicBaseUrl}/api/v1/control/bootstrap`,
      admission_url: `${publicBaseUrl}/api/v1/control/bootstrap`,
      telemetry_url: `${publicBaseUrl}/api/v1/telemetry`,
      config_url: `${publicBaseUrl}/api/v1/agent/config`
    },
    limits: {
      max_events: Number(env.AGENT_MAX_EVENTS || 500),
      max_bytes: Number(env.AGENT_MAX_BYTES || 524288)
    },
    jitter: {
      normal_jitter_window_ms: Number(env.AGENT_NORMAL_JITTER_WINDOW_MS || 30000),
      recovery_jitter_window_ms: Number(env.AGENT_RECOVERY_JITTER_WINDOW_MS || 300000)
    }
  };
}

function configEtag(config) {
  return `"${sha256Hex(JSON.stringify(config)).slice(0, 24)}"`;
}

function etagMatches(headerValue, expectedEtag) {
  const normalize = (value) => String(value || "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const expected = normalize(expectedEtag);
  return String(headerValue || "")
    .split(",")
    .map(normalize)
    .some((candidate) => candidate && candidate === expected);
}

function sendAgentConfig(req, res, sendJson, env = process.env) {
  const cfg = buildAgentConfig(env);
  const etag = configEtag(cfg);
  res.setHeader("etag", etag);
  res.setHeader("cache-control", "no-cache");
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304);
    return res.end();
  }
  return sendJson(res, 200, cfg, { etag, "cache-control": "no-cache" });
}

async function sendConfigArtifact(req, res, sendJson, fileName, artifactDir) {
  if (!CONFIG_ARTIFACT_FILES.has(fileName)) {
    return sendJson(res, 404, { message: "config artifact not found" });
  }

  const artifactPath = path.join(artifactDir, fileName);
  const normalizedRoot = path.resolve(artifactDir);
  const normalizedPath = path.resolve(artifactPath);
  if (!normalizedPath.startsWith(normalizedRoot + path.sep)) {
    return sendJson(res, 403, { message: "invalid config artifact path" });
  }
  if (!fs.existsSync(normalizedPath)) {
    return sendJson(res, 404, { message: "config artifact not found", file: fileName });
  }

  const body = await fs.promises.readFile(normalizedPath);
  const etag = `"${sha256Buffer(body).slice(0, 32)}"`;
  const headers = {
    "content-type": artifactContentType(fileName),
    "content-length": String(body.length),
    "etag": etag,
    "cache-control": "no-cache"
  };
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  return res.end(body);
}

function artifactContentType(fileName) {
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".toml")) return "application/toml; charset=utf-8";
  return "application/octet-stream";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

module.exports = {
  buildAgentConfig,
  configEtag,
  etagMatches,
  sendAgentConfig,
  sendConfigArtifact,
  sha256Hex
};
