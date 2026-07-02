const http = require("http");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 8088);
const VECTOR_URL = process.env.VECTOR_URL || "http://vector-gateway-1:8686/";
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);
const REQUIRED_SCHEMA_VERSION = process.env.REQUIRED_SCHEMA_VERSION || "1.0.0";
const PROCESSING_VERSION = "server-processing-1.0.0";
const REQUIRED_EVENT_FIELDS = ["agent_id", "host_id", "computer", "timestamp", "channel", "event_id", "record_id"];

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function escapeSql(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  const query = "INSERT INTO default.ingest_chunks FORMAT JSONEachRow";
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
    status,
    duplicate: duplicate ? 1 : 0,
    attempts: 1,
    message: String(message || "")
  };
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
    return enriched;
  });
}

async function handleLegacyArray(payload, res) {
  const legacyPayload = payload.map((event, index) => ({
    ...event,
    schema_version: String(event.schema_version || "legacy"),
    parser_status: "legacy_unvalidated",
    parser_error: "",
    validation_errors: "legacy_payload_without_chunk_envelope",
    processing_version: PROCESSING_VERSION,
    chunk_event_index: index
  }));
  await forwardToVector(legacyPayload);
  sendJson(res, 200, {
    ack: true,
    commit: true,
    status: "forwarded_legacy_array",
    event_count: payload.length
  });
}

async function handleChunk(payload, res) {
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

  const existing = await getChunk(agentId, chunkId);
  if (existing) {
    const sameChecksum = String(existing.checksum || "").toLowerCase() === checksum;
    const sameCount = Number(existing.event_count || 0) === eventCount;
    if (sameChecksum && sameCount) {
      await clickhouseInsertChunk(buildChunkRow(payload, "duplicate", true, "chunk already accepted"));
      return sendJson(res, 200, {
        ack: true,
        commit: true,
        status: "duplicate",
        chunk_id: chunkId,
        checksum,
        event_count: eventCount,
        sequence_number: Number(payload.sequence_number || 0)
      });
    }
    return sendJson(res, 409, { ack: false, commit: false, status: "conflict", chunk_id: chunkId, message: "chunk_id exists with different checksum or count" });
  }

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
    sequence_number: Number(payload.sequence_number || 0)
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, service: "hosteye-ingest-ack-gateway" });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ack: false, commit: false, status: "method_not_allowed" });
  }

  try {
    const text = await readBody(req);
    const payload = JSON.parse(text);
    if (Array.isArray(payload)) return await handleLegacyArray(payload, res);
    if (payload && payload.protocol === "hosteye.telemetry.v1") return await handleChunk(payload, res);
    return await handleLegacyArray([payload], res);
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
