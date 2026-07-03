const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 8088);
const VECTOR_URL = process.env.VECTOR_URL || "http://vector-gateway-1:8686/";
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const REQUIRED_SCHEMA_VERSION = process.env.REQUIRED_SCHEMA_VERSION || "1.0.0";
const PROCESSING_VERSION = "server-processing-1.0.0";
const REQUIRED_EVENT_FIELDS = ["agent_id", "host_id", "computer", "timestamp", "channel", "event_id", "record_id"];
const RAW_CHUNK_DIR = process.env.RAW_CHUNK_DIR || "/var/lib/hosteye/raw_chunks";
const CONFIG_ARTIFACT_DIR = process.env.CONFIG_ARTIFACT_DIR || "/var/lib/hosteye/agent_config";
const CONFIG_VERSION = process.env.AGENT_CONFIG_VERSION || "1.0.0";
const ADMISSION_MAX_ACTIVE_UPLOADS = Number(process.env.ADMISSION_MAX_ACTIVE_UPLOADS || 64);
const ADMISSION_LEASE_TTL_SECONDS = Number(process.env.ADMISSION_LEASE_TTL_SECONDS || 30);
const ADMISSION_MAX_BATCH_MB = Number(process.env.ADMISSION_MAX_BATCH_MB || 5);
const ADMISSION_MAX_UPLOAD_RATE_KBPS = Number(process.env.ADMISSION_MAX_UPLOAD_RATE_KBPS || 1024);
const REQUIRE_UPLOAD_LEASE = String(process.env.REQUIRE_UPLOAD_LEASE || "true").toLowerCase() !== "false";
const activeLeases = new Map();
const CONFIG_ARTIFACT_FILES = new Set(["manifest.json", "manifest.json.sig", "vector.toml", "vector.toml.sig"]);

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      const encoding = String(req.headers["content-encoding"] || "").toLowerCase();
      if (encoding.includes("gzip")) body = zlib.gunzipSync(body);
      resolve(body.toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function escapeSql(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function isoDateOrNow(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

async function clickhouseQuery(sql) {
  const response = await fetch(`${CLICKHOUSE_URL}/?query=${encodeURIComponent(sql)}`, {
    method: "POST"
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse ${response.status}: ${text}`);
  }
  return text;
}

async function clickhouseInsertChunk(row) {
  await clickhouseInsert("default.ingest_chunks", row);
}

async function clickhouseInsert(table, row) {
  const query = `INSERT INTO ${table} FORMAT JSONEachRow`;
  const response = await fetch(`${CLICKHOUSE_URL}/?query=${encodeURIComponent(query)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(row) + "\n"
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse insert ${response.status}: ${text}`);
  }
}

async function getChunk(agentId, chunkId) {
  const sql = [
    "SELECT checksum, event_count, status",
    "FROM default.ingest_chunks FINAL",
    `WHERE agent_id='${escapeSql(agentId)}' AND chunk_id='${escapeSql(chunkId)}'`,
    "ORDER BY last_seen DESC",
    "LIMIT 1",
    "FORMAT JSONEachRow"
  ].join(" ");
  const text = (await clickhouseQuery(sql)).trim();
  if (!text) return null;
  return JSON.parse(text.split(/\r?\n/)[0]);
}

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

function buildChunkRow(payload, status, duplicate, message) {
  return {
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    chunk_id: String(payload.chunk_id || ""),
    sequence_number: Number(payload.sequence_number || 0),
    checksum: String(payload.checksum || ""),
    event_count: Number(payload.event_count || 0),
    lease_id: String(payload.lease_id || ""),
    lease_expires_at: isoDateOrNow(payload.lease_expires_at),
    max_batch_mb: Number(payload.max_batch_mb || 0),
    max_upload_rate_kbps: Number(payload.max_upload_rate_kbps || 0),
    status,
    duplicate: duplicate ? 1 : 0,
    attempts: 1,
    message: String(message || "")
  };
}

function registrationConfig() {
  return {
    config_version: CONFIG_VERSION,
    schema_version: REQUIRED_SCHEMA_VERSION,
    normal_jitter_window_ms: Number(process.env.AGENT_NORMAL_JITTER_WINDOW_MS || 30000),
    recovery_jitter_window_ms: Number(process.env.AGENT_RECOVERY_JITTER_WINDOW_MS || 300000),
    max_events: Number(process.env.AGENT_MAX_EVENTS || 500),
    max_bytes: Number(process.env.AGENT_MAX_BYTES || 524288),
    enabled: String(process.env.AGENT_ENABLED || "true").toLowerCase() !== "false"
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

function sendAgentConfig(req, res) {
  const cfg = registrationConfig();
  const etag = configEtag(cfg);
  res.setHeader("etag", etag);
  res.setHeader("cache-control", "no-cache");
  if (etagMatches(req.headers["if-none-match"], etag)) {
    res.writeHead(304);
    return res.end();
  }
  return sendJson(res, 200, cfg, { etag, "cache-control": "no-cache" });
}

function artifactContentType(fileName) {
  if (fileName.endsWith(".json")) return "application/json";
  if (fileName.endsWith(".toml")) return "application/toml; charset=utf-8";
  return "application/octet-stream";
}

async function sendConfigArtifact(req, res, fileName) {
  if (!CONFIG_ARTIFACT_FILES.has(fileName)) {
    return sendJson(res, 404, { message: "config artifact not found" });
  }

  const artifactPath = path.join(CONFIG_ARTIFACT_DIR, fileName);
  const normalizedRoot = path.resolve(CONFIG_ARTIFACT_DIR);
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

function safePathPart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

async function writeRawChunk(payload) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const agentId = safePathPart(payload.agent_id);
  const chunkId = safePathPart(payload.chunk_id);
  const dir = path.join(RAW_CHUNK_DIR, day, agentId);
  await fs.promises.mkdir(dir, { recursive: true });

  const canonical = JSON.stringify(payload);
  const raw = Buffer.from(canonical, "utf8");
  const compressed = zlib.gzipSync(raw);
  const filePath = path.join(dir, `${chunkId}.json.gz`);
  await fs.promises.writeFile(filePath, compressed, { flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
  });

  return {
    raw_path: filePath,
    raw_size_bytes: raw.length,
    compressed_size_bytes: compressed.length,
    compression: "gzip",
    raw_sha256: sha256Hex(canonical)
  };
}

function buildRawChunkRow(payload, rawMeta, status, message) {
  return {
    kafka_timestamp: new Date().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    chunk_id: String(payload.chunk_id || ""),
    checksum: String(payload.checksum || ""),
    event_count: Number(payload.event_count || 0),
    sequence_number: Number(payload.sequence_number || 0),
    schema_version: String(payload.schema_version || ""),
    lease_id: String(payload.lease_id || ""),
    lease_expires_at: isoDateOrNow(payload.lease_expires_at),
    max_batch_mb: Number(payload.max_batch_mb || 0),
    max_upload_rate_kbps: Number(payload.max_upload_rate_kbps || 0),
    raw_path: rawMeta.raw_path,
    raw_size_bytes: rawMeta.raw_size_bytes,
    compressed_size_bytes: rawMeta.compressed_size_bytes,
    compression: rawMeta.compression,
    raw_sha256: rawMeta.raw_sha256,
    status,
    message: String(message || "")
  };
}

function buildRegisteredAgentRow(payload, req, status, message) {
  const cfg = registrationConfig();
  return {
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    cert_serial: String(req.headers["x-client-cert-serial"] || ""),
    schema_version: String(payload.schema_version || ""),
    source_platform: String(payload.source_platform || "hosteye_windows_endpoint"),
    shipper_version: String(payload.shipper_version || ""),
    status: cfg.enabled ? "active" : "disabled",
    enrollment_status: "auto_registered",
    last_chunk_id: String(payload.chunk_id || ""),
    last_ack_status: String(payload.ack_status || status),
    last_event_count: Number(payload.event_count || payload.batch_size || 0),
    normal_jitter_window_ms: Number(payload.normal_jitter_window_ms || payload.jitter_window_ms || cfg.normal_jitter_window_ms),
    recovery_jitter_window_ms: Number(payload.recovery_jitter_window_ms || cfg.recovery_jitter_window_ms),
    max_events: Number(payload.max_events || cfg.max_events),
    max_bytes: Number(payload.max_bytes || cfg.max_bytes),
    message: String(message || "")
  };
}

async function upsertRegisteredAgent(payload, req, status, message) {
  if (isBlank(payload.agent_id) && isBlank(payload.host_id) && isBlank(payload.computer)) return null;
  const row = buildRegisteredAgentRow(payload, req, status, message);
  await clickhouseInsert("default.registered_agents", row);
  return row;
}

function pruneExpiredLeases() {
  const now = Date.now();
  for (const [leaseId, lease] of activeLeases.entries()) {
    if (lease.expiresAt <= now) activeLeases.delete(leaseId);
  }
}

function buildAdmissionRow(payload, decision, leaseId, retryAfterSeconds, message) {
  const lease = leaseId ? activeLeases.get(leaseId) : null;
  return {
    decided_at: new Date().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    queue_used_mb: Number(payload.queue_used_mb || 0),
    next_chunk_size_mb: Number(payload.next_chunk_size_mb || 0),
    retry_count: Number(payload.retry_count || 0),
    rank: Number(payload.rank || 0),
    active_uploads: activeLeases.size,
    max_active_uploads: ADMISSION_MAX_ACTIVE_UPLOADS,
    max_batch_mb: lease?.maxBatchMb ?? ADMISSION_MAX_BATCH_MB,
    max_upload_rate_kbps: lease?.maxUploadRateKbps ?? ADMISSION_MAX_UPLOAD_RATE_KBPS,
    decision,
    lease_id: String(leaseId || ""),
    lease_ttl_seconds: decision === "ok" ? ADMISSION_LEASE_TTL_SECONDS : 0,
    lease_expires_at: isoDateOrNow(lease?.expiresAtIso),
    retry_after_seconds: retryAfterSeconds,
    message: String(message || "")
  };
}

async function handleAdmission(payload, res) {
  pruneExpiredLeases();
  const nextChunkSizeMb = Number(payload.next_chunk_size_mb || 0);
  let decision = "ok";
  let message = "upload lease granted";
  let retryAfterSeconds = 0;
  let leaseId = "";

  if (nextChunkSizeMb > ADMISSION_MAX_BATCH_MB) {
    decision = "ng";
    message = "next chunk is larger than max allowed batch";
    retryAfterSeconds = 60;
  } else if (activeLeases.size >= ADMISSION_MAX_ACTIVE_UPLOADS) {
    decision = "ng";
    message = "receiver upload slots are full";
    retryAfterSeconds = 15;
  } else {
    leaseId = crypto.randomUUID();
    const now = Date.now();
    activeLeases.set(leaseId, {
      agentId: String(payload.agent_id || ""),
      hostId: String(payload.host_id || ""),
      computer: String(payload.computer || ""),
      issuedAt: now,
      expiresAt: now + ADMISSION_LEASE_TTL_SECONDS * 1000,
      expiresAtIso: new Date(now + ADMISSION_LEASE_TTL_SECONDS * 1000).toISOString(),
      maxBatchMb: ADMISSION_MAX_BATCH_MB,
      maxUploadRateKbps: ADMISSION_MAX_UPLOAD_RATE_KBPS,
      used: false
    });
  }

  const row = buildAdmissionRow(payload, decision, leaseId, retryAfterSeconds, message);
  await clickhouseInsert("default.admission_decisions", row);
  return sendJson(res, decision === "ok" ? 200 : 429, {
    admission: decision,
    lease_id: leaseId,
    lease_ttl_seconds: row.lease_ttl_seconds,
    lease_expires_at: row.lease_expires_at,
    max_batch_mb: ADMISSION_MAX_BATCH_MB,
    max_upload_rate_kbps: ADMISSION_MAX_UPLOAD_RATE_KBPS,
    retry_after_seconds: retryAfterSeconds,
    message
  }, retryAfterSeconds > 0 ? { "retry-after": String(retryAfterSeconds) } : {});
}

function payloadBatchMb(payload) {
  const batchBytes = Number(payload.batch_bytes || 0);
  if (batchBytes > 0) return batchBytes / 1024 / 1024;
  return Buffer.byteLength(JSON.stringify(payload.events || []), "utf8") / 1024 / 1024;
}

function validateAndConsumeUploadLease(payload) {
  if (!REQUIRE_UPLOAD_LEASE) {
    return { ok: true, status: "lease_not_required" };
  }

  pruneExpiredLeases();
  const leaseId = String(payload.lease_id || "");
  if (!leaseId) {
    return { ok: false, statusCode: 428, status: "lease_required", message: "upload lease_id is required" };
  }

  const lease = activeLeases.get(leaseId);
  if (!lease) {
    return { ok: false, statusCode: 409, status: "lease_invalid", message: "upload lease is missing or expired" };
  }
  if (lease.used) {
    return { ok: false, statusCode: 409, status: "lease_used", message: "upload lease was already used" };
  }
  if (lease.expiresAt <= Date.now()) {
    activeLeases.delete(leaseId);
    return { ok: false, statusCode: 409, status: "lease_expired", message: "upload lease expired" };
  }

  const agentId = String(payload.agent_id || "");
  const hostId = String(payload.host_id || "");
  const computer = String(payload.computer || "");
  if (lease.agentId && lease.agentId !== agentId) {
    return { ok: false, statusCode: 403, status: "lease_agent_mismatch", message: "upload lease agent mismatch" };
  }
  if (lease.hostId && lease.hostId !== hostId) {
    return { ok: false, statusCode: 403, status: "lease_host_mismatch", message: "upload lease host mismatch" };
  }
  if (lease.computer && lease.computer !== computer) {
    return { ok: false, statusCode: 403, status: "lease_computer_mismatch", message: "upload lease computer mismatch" };
  }

  const batchMb = payloadBatchMb(payload);
  if (lease.maxBatchMb > 0 && batchMb > lease.maxBatchMb) {
    return { ok: false, statusCode: 413, status: "lease_batch_too_large", message: `batch ${batchMb.toFixed(3)} MB exceeds lease max ${lease.maxBatchMb} MB` };
  }

  lease.used = true;
  lease.usedAt = Date.now();
  activeLeases.set(leaseId, lease);
  return { ok: true, status: "lease_consumed", lease };
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function validateEvent(event) {
  const errors = [];
  for (const field of REQUIRED_EVENT_FIELDS) {
    if (isBlank(event[field])) errors.push(`missing_${field}`);
  }

  const eventId = Number(event.event_id);
  if (!Number.isInteger(eventId) || eventId <= 0) errors.push("invalid_event_id");

  const recordId = Number(event.record_id);
  if (!Number.isInteger(recordId) || recordId <= 0) errors.push("invalid_record_id");

  if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) errors.push("invalid_timestamp");

  return errors;
}

function enrichEvents(payload) {
  return payload.events.map((event, index) => {
    const enriched = { ...event };
    const validationErrors = validateEvent(enriched);
    enriched.schema_version = String(payload.schema_version || "");
    enriched.parser_status = validationErrors.length === 0 ? "valid" : "invalid";
    enriched.parser_error = "";
    enriched.validation_errors = validationErrors.join(",");
    enriched.processing_version = PROCESSING_VERSION;
    enriched.chunk_id = String(payload.chunk_id || "");
    enriched.chunk_checksum = String(payload.checksum || "");
    enriched.sequence_number = Number(payload.sequence_number || 0);
    enriched.chunk_event_index = index;
    if (isBlank(enriched.idempotency_key)) {
      enriched.idempotency_key = sha256Hex([
        enriched.computer || payload.computer || "",
        enriched.channel || "",
        enriched.record_id || "",
        enriched.timestamp || "",
        enriched.event_id || ""
      ].join("|"));
    }
    return enriched;
  });
}

async function handleLegacyArray(payload, req, res) {
  const legacyPayload = payload.map((event, index) => ({
    ...event,
    schema_version: String(event.schema_version || "legacy"),
    parser_status: "legacy_unvalidated",
    parser_error: "",
    validation_errors: "legacy_payload_without_chunk_envelope",
    processing_version: PROCESSING_VERSION,
    chunk_event_index: index
  }));
  for (const event of legacyPayload) {
    await upsertRegisteredAgent(event, req, "legacy_checkin", "legacy payload check-in");
  }
  await forwardToVector(legacyPayload);
  sendJson(res, 200, {
    ack: true,
    commit: true,
    status: "forwarded_legacy_array",
    event_count: payload.length,
    agent_config: registrationConfig()
  });
}

async function handleChunk(payload, req, res) {
  if (!Array.isArray(payload.events)) {
    return sendJson(res, 400, { ack: false, commit: false, status: "invalid", message: "events must be an array" });
  }

  const eventsJson = JSON.stringify(payload.events);
  const checksum = sha256Hex(eventsJson);
  const eventCount = payload.events.length;
  const chunkId = String(payload.chunk_id || "");
  const agentId = String(payload.agent_id || "");
  const schemaVersion = String(payload.schema_version || "");

  if (schemaVersion !== REQUIRED_SCHEMA_VERSION) {
    return sendJson(res, 400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, message: `schema_version must be ${REQUIRED_SCHEMA_VERSION}` });
  }
  if (!chunkId || !agentId) {
    return sendJson(res, 400, { ack: false, commit: false, status: "invalid", message: "chunk_id and agent_id are required" });
  }
  if (Number(payload.event_count) !== eventCount) {
    return sendJson(res, 400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, message: "event_count mismatch" });
  }
  if (String(payload.checksum || "").toLowerCase() !== checksum) {
    return sendJson(res, 400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, event_count: eventCount, checksum, message: "checksum mismatch" });
  }

  await upsertRegisteredAgent(payload, req, "checkin", "chunk validated");

  const existing = await getChunk(agentId, chunkId);
  if (existing) {
    const sameChecksum = String(existing.checksum || "").toLowerCase() === checksum;
    const sameCount = Number(existing.event_count || 0) === eventCount;
    if (sameChecksum && sameCount) {
      await clickhouseInsertChunk(buildChunkRow(payload, "duplicate", true, "chunk already accepted"));
      await upsertRegisteredAgent(payload, req, "duplicate", "duplicate chunk acknowledged");
      return sendJson(res, 200, {
        ack: true,
        commit: true,
        status: "duplicate",
        chunk_id: chunkId,
        checksum,
        event_count: eventCount,
        sequence_number: Number(payload.sequence_number || 0),
        lease_id: String(payload.lease_id || ""),
        agent_config: registrationConfig()
      });
    }
    return sendJson(res, 409, { ack: false, commit: false, status: "conflict", chunk_id: chunkId, message: "chunk_id exists with different checksum or count" });
  }

  const leaseResult = validateAndConsumeUploadLease(payload);
  if (!leaseResult.ok) {
    await clickhouseInsertChunk(buildChunkRow(payload, leaseResult.status, false, leaseResult.message));
    return sendJson(res, leaseResult.statusCode, {
      ack: false,
      commit: false,
      status: leaseResult.status,
      chunk_id: chunkId,
      lease_id: String(payload.lease_id || ""),
      message: leaseResult.message
    });
  }

  const rawMeta = await writeRawChunk(payload);
  await clickhouseInsert("default.raw_chunk_vault", buildRawChunkRow(payload, rawMeta, "stored", "raw chunk stored before ACK"));
  await clickhouseInsertChunk(buildChunkRow(payload, "received", false, "chunk validated"));
  const enrichedEvents = enrichEvents(payload);
  const invalidEvents = enrichedEvents.filter((event) => event.parser_status === "invalid").length;
  await forwardToVector(enrichedEvents);
  await clickhouseInsertChunk(buildChunkRow(payload, "queued", false, "forwarded to vector gateway"));

  sendJson(res, 200, {
    ack: true,
    commit: true,
    status: "queued",
    chunk_id: chunkId,
    checksum,
    event_count: eventCount,
    invalid_event_count: invalidEvents,
    sequence_number: Number(payload.sequence_number || 0),
    lease_id: String(payload.lease_id || ""),
    agent_config: registrationConfig()
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && requestUrl.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "hosteye-ingest-ack-gateway" });
  }
  if (req.method === "GET" && (requestUrl.pathname === "/api/v1/agent/config" || requestUrl.pathname === "/api/v1/agent/config/")) {
    return sendAgentConfig(req, res);
  }
  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/v1/agent/config/")) {
    const fileName = decodeURIComponent(requestUrl.pathname.slice("/api/v1/agent/config/".length));
    return sendConfigArtifact(req, res, fileName);
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ack: false, commit: false, status: "method_not_allowed" });
  }

  try {
    const text = await readBody(req);
    const payload = JSON.parse(text);
    if (requestUrl.pathname === "/api/v1/admission/request") return await handleAdmission(payload, res);
    if (Array.isArray(payload)) return await handleLegacyArray(payload, req, res);
    if (payload && payload.protocol === "hosteye.telemetry.v1") return await handleChunk(payload, req, res);
    return await handleLegacyArray([payload], req, res);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode >= 400 && statusCode < 600 ? statusCode : 500, {
      ack: false,
      commit: false,
      status: "error",
      message: error.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HostEye ingest ACK gateway listening on ${PORT}, forwarding to ${VECTOR_URL}`);
});
