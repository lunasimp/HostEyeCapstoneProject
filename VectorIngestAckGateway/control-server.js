const http = require("http");
const { createControlPlane } = require("./controlplane");
const { createClickHouseClient } = require("./shared/clickhouse");
const { sendAgentConfig, sendConfigArtifact } = require("./shared/config");
const { createFileLeaseStore } = require("./shared/file-lease-store");
const { readJson, sendJson } = require("./shared/http");

const PORT = Number(process.env.CONTROL_PORT || process.env.PORT || 8080);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const CONFIG_ARTIFACT_DIR = process.env.CONFIG_ARTIFACT_DIR || "/var/lib/hosteye/agent_config";

const clickhouse = createClickHouseClient(CLICKHOUSE_URL);
const leaseStore = createFileLeaseStore();
const controlPlane = createControlPlane({
  leaseStore,
  clickhouseInsert: clickhouse.insert
});

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "hosteye-control-plane" });
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/v1/control/collectors") {
      return sendJson(res, 200, { collectors: controlPlane.listCollectors() });
    }
    if (req.method === "GET" && (requestUrl.pathname === "/api/v1/agent/config" || requestUrl.pathname === "/api/v1/agent/config/")) {
      return sendAgentConfig(req, res, sendJson);
    }
    if (req.method === "GET" && requestUrl.pathname.startsWith("/api/v1/agent/config/")) {
      const fileName = decodeURIComponent(requestUrl.pathname.slice("/api/v1/agent/config/".length));
      return sendConfigArtifact(req, res, sendJson, fileName, CONFIG_ARTIFACT_DIR);
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { status: "method_not_allowed" });
    }

    const payload = await readJson(req, MAX_BODY_BYTES);
    if (requestUrl.pathname === "/api/v1/control/collector/heartbeat") {
      return sendJson(res, 200, controlPlane.heartbeat(payload));
    }
    if (requestUrl.pathname === "/api/v1/control/bootstrap") {
      const result = await controlPlane.bootstrap(payload, req.headers);
      return sendJson(res, result.statusCode, result.body, result.headers);
    }
    if (requestUrl.pathname === "/api/v1/admission/request") {
      const result = await controlPlane.bootstrap(payload, req.headers);
      return sendJson(res, result.statusCode, toLegacyAdmissionResponse(result.body), result.headers);
    }

    return sendJson(res, 404, { status: "not_found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return sendJson(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, {
      status: "error",
      message: error.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HostEye control plane listening on ${PORT}`);
});

function toLegacyAdmissionResponse(body) {
  return {
    admission: body.admission,
    lease_id: body.lease_id,
    lease_ttl_seconds: body.lease_ttl_seconds,
    lease_expires_at: body.lease_expires_at,
    max_batch_mb: body.max_batch_mb,
    max_upload_rate_kbps: body.max_upload_rate_kbps,
    retry_after_seconds: body.retry_after_seconds,
    message: body.message
  };
}
