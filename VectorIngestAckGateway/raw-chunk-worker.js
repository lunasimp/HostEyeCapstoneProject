const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const zlib = require("zlib");
const { createDataPlane } = require("./dataplane");
const { createClickHouseClient } = require("./shared/clickhouse");
const { buildAgentConfig } = require("./shared/config");

const REDPANDA_PROXY_URL = (process.env.REDPANDA_PROXY_URL || "http://redpanda-broker:8082").replace(/\/+$/, "");
const RAW_CHUNK_TOPIC = process.env.RAW_CHUNK_TOPIC || "raw-chunk-jobs";
const WORKER_GROUP = process.env.RAW_WORKER_GROUP || "raw-chunk-worker";
const WORKER_INSTANCE = process.env.RAW_WORKER_INSTANCE || `${os.hostname()}-${process.pid}`;
const AUTO_OFFSET_RESET = process.env.RAW_WORKER_AUTO_OFFSET_RESET || "earliest";
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://clickhouse:8123";
const VECTOR_URL = process.env.VECTOR_URL || "http://vector-gateway-1:8686/";
const POLL_TIMEOUT_MS = Number(process.env.RAW_WORKER_POLL_TIMEOUT_MS || 1000);
const POLL_MAX_BYTES = Number(process.env.RAW_WORKER_POLL_MAX_BYTES || 1024 * 1024);
const RETRY_DELAY_MS = Number(process.env.RAW_WORKER_RETRY_DELAY_MS || 5000);

const clickhouse = createClickHouseClient(CLICKHOUSE_URL);
const dataplane = createDataPlane({
  clickhouseInsert: clickhouse.insert,
  getChunk: async () => null,
  forwardToVector,
  publishToBroker: null
}, {
  requireUploadLease: false,
  directVectorForward: false,
  agentConfig: buildAgentConfig(process.env)
});

let stopping = false;

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

main().catch((error) => {
  console.error(`raw-chunk-worker fatal: ${error.stack || error.message}`);
  process.exit(1);
});

async function main() {
  console.log(`raw-chunk-worker starting group=${WORKER_GROUP} instance=${WORKER_INSTANCE} topic=${RAW_CHUNK_TOPIC}`);
  await createConsumer();
  await subscribe();

  while (!stopping) {
    try {
      const records = await fetchRecords();
      if (!records.length) continue;
      for (const record of records) {
        await processRecord(record);
        await commitOffsets();
      }
    } catch (error) {
      console.error(`raw-chunk-worker loop error: ${error.stack || error.message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  await deleteConsumer().catch(() => {});
  console.log("raw-chunk-worker stopped");
}

async function createConsumer() {
  const response = await kafkaFetch(`/consumers/${encodeURIComponent(WORKER_GROUP)}`, {
    method: "POST",
    headers: {
      "content-type": "application/vnd.kafka.v2+json",
      "accept": "application/vnd.kafka.v2+json"
    },
    body: JSON.stringify({
      name: WORKER_INSTANCE,
      format: "json",
      "auto.offset.reset": AUTO_OFFSET_RESET,
      "auto.commit.enable": "false"
    })
  });

  if (response.status === 409) {
    await deleteConsumer().catch(() => {});
    return createConsumer();
  }
  await ensureOk(response, "create consumer");
}

async function subscribe() {
  const response = await kafkaFetch(`${consumerPath()}/subscription`, {
    method: "POST",
    headers: { "content-type": "application/vnd.kafka.v2+json" },
    body: JSON.stringify({ topics: [RAW_CHUNK_TOPIC] })
  });
  await ensureOk(response, "subscribe");
}

async function fetchRecords() {
  const response = await kafkaFetch(`${consumerPath()}/records?timeout=${POLL_TIMEOUT_MS}&max_bytes=${POLL_MAX_BYTES}`, {
    headers: { "accept": "application/vnd.kafka.json.v2+json" }
  });
  await ensureOk(response, "fetch records");
  return response.json();
}

async function commitOffsets() {
  const response = await kafkaFetch(`${consumerPath()}/offsets`, {
    method: "POST",
    headers: { "content-type": "application/vnd.kafka.v2+json" }
  });
  await ensureOk(response, "commit offsets");
}

async function deleteConsumer() {
  const response = await kafkaFetch(consumerPath(), {
    method: "DELETE",
    headers: { "content-type": "application/vnd.kafka.v2+json" }
  });
  if (![204, 404].includes(response.status)) {
    await ensureOk(response, "delete consumer");
  }
}

async function processRecord(record) {
  const job = record.value || {};
  if (job.protocol !== "hosteye.raw_chunk.v1" || job.event_type !== "raw_chunk_stored") {
    console.warn(`skip non raw chunk job offset=${record.offset}`);
    return;
  }

  const startedAt = new Date();
  try {
    const payload = await readRawPayload(job);
    verifyRawPayload(job, payload);
    const enrichedEvents = dataplane.enrichEvents(payload);
    await forwardToVector(enrichedEvents);
    await clickhouse.insert("default.ingest_chunks", buildWorkerChunkRow(payload, "worker_index_queued", 1, `raw worker forwarded via ${record.topic}/${record.partition}/${record.offset}`, startedAt));
    console.log(`processed chunk=${job.chunk_id} events=${enrichedEvents.length} offset=${record.offset}`);
  } catch (error) {
    const fallbackPayload = payloadFromJob(job);
    await clickhouse.insert("default.ingest_chunks", buildWorkerChunkRow(fallbackPayload, "worker_index_failed", 1, error.message, startedAt));
    throw error;
  }
}

async function readRawPayload(job) {
  const rawPath = String(job.raw_path || "");
  if (!rawPath) throw new Error("raw chunk job missing raw_path");
  const compressed = await fs.promises.readFile(rawPath);
  const raw = zlib.gunzipSync(compressed).toString("utf8");
  const actualSha = sha256Hex(raw);
  if (job.raw_sha256 && actualSha !== String(job.raw_sha256).toLowerCase()) {
    throw new Error(`raw_sha256 mismatch for ${job.chunk_id}`);
  }
  return JSON.parse(raw);
}

function verifyRawPayload(job, payload) {
  if (String(payload.chunk_id || "") !== String(job.chunk_id || "")) {
    throw new Error(`chunk_id mismatch job=${job.chunk_id} payload=${payload.chunk_id}`);
  }
  if (String(payload.checksum || "").toLowerCase() !== String(job.checksum || "").toLowerCase()) {
    throw new Error(`checksum mismatch for ${job.chunk_id}`);
  }
  if (Number(payload.event_count || 0) !== Number(job.event_count || 0)) {
    throw new Error(`event_count mismatch for ${job.chunk_id}`);
  }
}

async function forwardToVector(events) {
  const response = await fetch(VECTOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(events)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vector ${response.status}: ${text}`);
  }
}

function buildWorkerChunkRow(payload, status, attempts, message, at) {
  return {
    first_seen: at.toISOString(),
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
    duplicate: 0,
    attempts,
    message: String(message || "").slice(0, 1000)
  };
}

function payloadFromJob(job) {
  return {
    agent_id: job.agent_id,
    host_id: job.host_id,
    computer: job.computer,
    chunk_id: job.chunk_id,
    sequence_number: job.sequence_number,
    checksum: job.checksum,
    event_count: job.event_count,
    lease_id: job.lease_id,
    lease_expires_at: job.lease_expires_at
  };
}

function consumerPath() {
  return `/consumers/${encodeURIComponent(WORKER_GROUP)}/instances/${encodeURIComponent(WORKER_INSTANCE)}`;
}

async function kafkaFetch(path, options = {}) {
  return fetch(`${REDPANDA_PROXY_URL}${path}`, options);
}

async function ensureOk(response, action) {
  if (response.ok) return;
  const text = await response.text();
  throw new Error(`${action} failed: Redpanda ${response.status}: ${text}`);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isoDateOrNow(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
