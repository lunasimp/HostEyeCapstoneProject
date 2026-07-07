const http = require("http");
const { createDataPlane } = require("./dataplane");
const { createClickHouseClient } = require("./shared/clickhouse");
const { buildAgentConfig } = require("./shared/config");
const { createFileLeaseStore } = require("./shared/file-lease-store");
const { readJson, sendJson } = require("./shared/http");

const PORT = Number(process.env.DATA_PORT || process.env.PORT || 8088);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const VECTOR_URL = process.env.VECTOR_URL || "http://vector-gateway-1:8686/";

const COLLECTOR_ID = process.env.COLLECTOR_ID || "collector-a";
const COLLECTOR_PUBLIC_URL = process.env.COLLECTOR_PUBLIC_URL || "";
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || "";
const COLLECTOR_UPLOAD_SLOT_MS = Math.max(1, Number(process.env.COLLECTOR_UPLOAD_SLOT_MS || 1000));
let activeTelemetryUploads = 0;
let collectorBusyUntilMs = Date.now();

const clickhouse = createClickHouseClient(CLICKHOUSE_URL);
const leaseStore = createFileLeaseStore();

async function forwardToVector(events) {
  const response = await fetch(VECTOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events)
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`Vector ${response.status}: ${text}`);
    err.statusCode = response.status;
    throw err;
  }
}



const dataplane = createDataPlane({
  clickhouseInsert: clickhouse.insert,
  getChunk: clickhouse.getChunk,
  forwardToVector,
  validateAndConsumeUploadLease: async (payload) => leaseStore.validateAndConsume(payload, COLLECTOR_ID)
}, {
  requiredSchemaVersion: process.env.REQUIRED_SCHEMA_VERSION || "1.0.0",
  rawChunkDir: process.env.RAW_CHUNK_DIR || "/var/lib/hosteye/raw_chunks",
  requireUploadLease: String(process.env.REQUIRE_UPLOAD_LEASE || "true").toLowerCase() !== "false",
  maxActiveUploads: Number(process.env.ADMISSION_MAX_ACTIVE_UPLOADS || 64),
  leaseTtlSeconds: Number(process.env.ADMISSION_LEASE_TTL_SECONDS || 30),
  maxBatchMb: Number(process.env.ADMISSION_MAX_BATCH_MB || 5),
  maxUploadRateKbps: Number(process.env.ADMISSION_MAX_UPLOAD_RATE_KBPS || 1024),
  agentConfig: buildAgentConfig(process.env)
});

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "hosteye-data-plane",
        collector_id: COLLECTOR_ID,
        active_leases: 0,
        active_uploads: activeTelemetryUploads,
        ready: isCollectorReady(),
        next_available_at: collectorNextAvailableAt().toISOString(),
        upload_slot_ms: COLLECTOR_UPLOAD_SLOT_MS
      });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { ack: false, commit: false, status: "method_not_allowed" });
    }

    const payload = await readJson(req, MAX_BODY_BYTES);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/api/v1/telemetry" || requestUrl.pathname === `/api/v1/telemetry/${COLLECTOR_ID}`) {
      activeTelemetryUploads++;
      reserveLocalUploadSlot();
      try {
        const result = await dataplane.handleTelemetry(payload, { headers: req.headers, collector_id: COLLECTOR_ID });
        return sendJson(res, result.statusCode, result.body, result.headers);
      } finally {
        activeTelemetryUploads = Math.max(0, activeTelemetryUploads - 1);
        reserveLocalUploadSlot();
      }
    }

    return sendJson(res, 404, { ack: false, commit: false, status: "not_found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return sendJson(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, {
      ack: false,
      commit: false,
      status: "error",
      message: error.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HostEye data plane ${COLLECTOR_ID} listening on ${PORT}, forwarding to ${VECTOR_URL}`);
});

function reserveLocalUploadSlot() {
  const nowMs = Date.now();
  const queuedSlots = Math.max(0, activeTelemetryUploads) * COLLECTOR_UPLOAD_SLOT_MS;
  collectorBusyUntilMs = Math.max(collectorBusyUntilMs, nowMs + queuedSlots);
}

function collectorNextAvailableAt() {
  return new Date(Math.max(Date.now(), collectorBusyUntilMs));
}

function isCollectorReady() {
  return activeTelemetryUploads === 0 && collectorBusyUntilMs <= Date.now();
}

async function sendHeartbeat() {
  if (!CONTROL_PLANE_URL) return;
  try {
    await fetch(`${CONTROL_PLANE_URL.replace(/\/+$/, "")}/api/v1/control/collector/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collector_id: COLLECTOR_ID,
        url: COLLECTOR_PUBLIC_URL || `/api/v1/telemetry/${COLLECTOR_ID}`,
        health: "healthy",
        ready: isCollectorReady(),
        active_uploads: activeTelemetryUploads,
        active_leases: 0,
        max_uploads: Number(process.env.ADMISSION_MAX_ACTIVE_UPLOADS || 64),
        next_available_at: collectorNextAvailableAt().toISOString(),
        upload_slot_ms: COLLECTOR_UPLOAD_SLOT_MS,
        write_latency_ms: 0,
        storage_lag: 0
      })
    });
  } catch (error) {
    console.warn(`collector heartbeat failed: ${error.message}`);
  }
}

if (CONTROL_PLANE_URL) {
  sendHeartbeat();
  setInterval(sendHeartbeat, Number(process.env.COLLECTOR_HEARTBEAT_MS || 5000)).unref();
}
