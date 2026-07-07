const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DEFAULTS = Object.freeze({
  requiredSchemaVersion: "1.0.0",
  processingVersion: "server-processing-1.0.0",
  requiredEventFields: ["agent_id", "host_id", "computer", "timestamp", "channel", "event_id", "record_id"],
  requireUploadLease: true,
  maxActiveUploads: 64,
  leaseTtlSeconds: 30,
  maxBatchMb: 5,
  maxUploadRateKbps: 1024,
  agentConfig: Object.freeze({
    config_version: "1.0.0",
    schema_version: "1.0.0",
    normal_jitter_window_ms: 30000,
    recovery_jitter_window_ms: 300000,
    max_events: 500,
    max_bytes: 524288,
    enabled: true
  })
});

function createDataPlane(deps = {}, options = {}) {
  const state = {
    options: mergeOptions(DEFAULTS, options),
    activeLeases: deps.activeLeases || new Map(),
    now: deps.now || (() => new Date()),
    randomUUID: deps.randomUUID || (() => crypto.randomUUID()),
    clickhouseInsert: deps.clickhouseInsert || missingDependency("clickhouseInsert"),
    getChunk: deps.getChunk || missingDependency("getChunk"),
    forwardToVector: deps.forwardToVector || missingDependency("forwardToVector"),
    validateAndConsumeUploadLease: deps.validateAndConsumeUploadLease || null
  };

  return {
    handleAdmission(payload) {
      return handleAdmission(state, payload);
    },
    handleTelemetry(payload, context = {}) {
      if (Array.isArray(payload)) return handleLegacyArray(state, payload, context);
      if (payload && payload.protocol === "hosteye.telemetry.v1") return handleChunk(state, payload, context);
      return handleLegacyArray(state, [payload], context);
    },
    enrichEvents(payload) {
      return enrichEvents(state, payload);
    },
    validateEvent(event) {
      return validateEvent(state, event);
    },
    validateAndConsumeUploadLease(payload) {
      return validateAndConsumeUploadLease(state, payload);
    },
    pruneExpiredLeases() {
      return pruneExpiredLeases(state);
    },
    getActiveLeaseCount() {
      pruneExpiredLeases(state);
      return state.activeLeases.size;
    }
  };
}

async function handleAdmission(state, payload) {
  pruneExpiredLeases(state);
  const nextChunkSizeMb = Number(payload.next_chunk_size_mb || 0);
  let decision = "ok";
  let message = "upload lease granted";
  let retryAfterSeconds = 0;
  let leaseId = "";

  if (nextChunkSizeMb > state.options.maxBatchMb) {
    decision = "ng";
    message = "next chunk is larger than max allowed batch";
    retryAfterSeconds = 60;
  } else if (state.activeLeases.size >= state.options.maxActiveUploads) {
    decision = "ng";
    message = "receiver upload slots are full";
    retryAfterSeconds = 15;
  } else {
    leaseId = state.randomUUID();
    const nowMs = state.now().getTime();
    const expiresAt = new Date(nowMs + state.options.leaseTtlSeconds * 1000);
    state.activeLeases.set(leaseId, {
      agentId: String(payload.agent_id || ""),
      hostId: String(payload.host_id || ""),
      computer: String(payload.computer || ""),
      issuedAt: nowMs,
      expiresAt: expiresAt.getTime(),
      expiresAtIso: expiresAt.toISOString(),
      maxBatchMb: state.options.maxBatchMb,
      maxUploadRateKbps: state.options.maxUploadRateKbps,
      used: false
    });
  }

  const row = buildAdmissionRow(state, payload, decision, leaseId, retryAfterSeconds, message);
  await state.clickhouseInsert("default.admission_decisions", row);

  return {
    statusCode: decision === "ok" ? 200 : 429,
    headers: retryAfterSeconds > 0 ? { "retry-after": String(retryAfterSeconds) } : {},
    body: {
      admission: decision,
      lease_id: leaseId,
      lease_ttl_seconds: row.lease_ttl_seconds,
      lease_expires_at: row.lease_expires_at,
      max_batch_mb: state.options.maxBatchMb,
      max_upload_rate_kbps: state.options.maxUploadRateKbps,
      retry_after_seconds: retryAfterSeconds,
      message
    }
  };
}

async function handleLegacyArray(state, payload, context) {
  const legacyPayload = payload.map((event, index) => ({
    ...event,
    schema_version: String(event.schema_version || "legacy"),
    parser_status: "legacy_unvalidated",
    parser_error: "",
    validation_errors: "legacy_payload_without_chunk_envelope",
    processing_version: state.options.processingVersion,
    chunk_event_index: index
  }));

  for (const event of legacyPayload) {
    await upsertRegisteredAgent(state, event, context, "legacy_checkin", "legacy payload check-in");
  }
  await state.forwardToVector(legacyPayload);

  return {
    statusCode: 200,
    body: {
      ack: true,
      commit: true,
      status: "forwarded_legacy_array",
      event_count: payload.length,
      agent_config: state.options.agentConfig
    }
  };
}

async function handleChunk(state, payload, context) {
  const validation = validateChunkEnvelope(state, payload);
  if (!validation.ok) {
    return { statusCode: validation.statusCode, body: validation.body };
  }

  await upsertRegisteredAgent(state, payload, context, "checkin", "chunk validated");

  const existing = await state.getChunk(validation.agentId, validation.chunkId);
  if (existing) {
    return handleExistingChunk(state, payload, context, validation, existing);
  }

  const leaseResult = state.validateAndConsumeUploadLease
    ? await state.validateAndConsumeUploadLease(payload, context)
    : validateAndConsumeUploadLease(state, payload);
  if (!leaseResult.ok) {
    await state.clickhouseInsert("default.ingest_chunks", buildChunkRow(state, payload, leaseResult.status, false, leaseResult.message));
    return {
      statusCode: leaseResult.statusCode,
      body: {
        ack: false,
        commit: false,
        status: leaseResult.status,
        chunk_id: validation.chunkId,
        lease_id: String(payload.lease_id || ""),
        message: leaseResult.message
      }
    };
  }

  const enrichedEvents = enrichEvents(state, payload);
  const invalidEvents = enrichedEvents.filter((event) => event.parser_status === "invalid").length;
  let indexStatus = "index_queued";
  let indexMessage = "forwarded to vector gateway";
  try {
    await state.forwardToVector(enrichedEvents);
    await state.clickhouseInsert("default.ingest_chunks", buildChunkRow(state, payload, indexStatus, false, indexMessage));
  } catch (error) {
    indexStatus = "index_failed";
    indexMessage = `vector forward failed: ${error?.message || String(error)}`;
    await state.clickhouseInsert("default.ingest_chunks", buildChunkRow(state, payload, indexStatus, false, indexMessage));
  }

  return {
    statusCode: 200,
    body: {
      ack: true,
      commit: true,
      status: "raw_stored",
      index_status: indexStatus,
      index_message: indexMessage,
      chunk_id: validation.chunkId,
      checksum: validation.checksum,
      event_count: validation.eventCount,
      invalid_event_count: invalidEvents,
      sequence_number: Number(payload.sequence_number || 0),
      lease_id: String(payload.lease_id || ""),
      agent_config: state.options.agentConfig
    }
  };
}


async function handleExistingChunk(state, payload, context, validation, existing) {
  const sameChecksum = String(existing.checksum || "").toLowerCase() === validation.checksum;
  const sameCount = Number(existing.event_count || 0) === validation.eventCount;

  if (!sameChecksum || !sameCount) {
    return {
      statusCode: 409,
      body: {
        ack: false,
        commit: false,
        status: "conflict",
        chunk_id: validation.chunkId,
        message: "chunk_id exists with different checksum or count"
      }
    };
  }

  await state.clickhouseInsert("default.ingest_chunks", buildChunkRow(state, payload, "duplicate", true, "chunk already accepted"));
  await upsertRegisteredAgent(state, payload, context, "duplicate", "duplicate chunk acknowledged");

  return {
    statusCode: 200,
    body: {
      ack: true,
      commit: true,
      status: "duplicate",
      index_status: indexStatusFromChunkStatus(existing.status),
      chunk_id: validation.chunkId,
      checksum: validation.checksum,
      event_count: validation.eventCount,
      sequence_number: Number(payload.sequence_number || 0),
      lease_id: String(payload.lease_id || ""),
      agent_config: state.options.agentConfig
    }
  };
}

function indexStatusFromChunkStatus(status) {
  const normalized = String(status || "");
  if (normalized === "index_queued" || normalized === "index_failed") {
    return normalized;
  }
  if (normalized === "queued") {
    return "index_queued";
  }
  if (normalized === "raw_stored" || normalized === "received") {
    return "not_indexed";
  }
  return normalized || "duplicate";
}

function validateChunkEnvelope(state, payload) {
  if (!Array.isArray(payload.events)) {
    return invalidChunk(400, { ack: false, commit: false, status: "invalid", message: "events must be an array" });
  }

  const eventsJson = JSON.stringify(payload.events);
  const checksum = sha256Hex(eventsJson);
  const eventCount = payload.events.length;
  const chunkId = String(payload.chunk_id || "");
  const agentId = String(payload.agent_id || "");
  const schemaVersion = String(payload.schema_version || "");

  if (schemaVersion !== state.options.requiredSchemaVersion) {
    return invalidChunk(400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, message: `schema_version must be ${state.options.requiredSchemaVersion}` });
  }
  if (!chunkId || !agentId) {
    return invalidChunk(400, { ack: false, commit: false, status: "invalid", message: "chunk_id and agent_id are required" });
  }
  if (Number(payload.event_count) !== eventCount) {
    return invalidChunk(400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, message: "event_count mismatch" });
  }
  if (String(payload.checksum || "").toLowerCase() !== checksum) {
    return invalidChunk(400, { ack: false, commit: false, status: "invalid", chunk_id: chunkId, event_count: eventCount, checksum, message: "checksum mismatch" });
  }

  return { ok: true, checksum, eventCount, chunkId, agentId };
}

function invalidChunk(statusCode, body) {
  return { ok: false, statusCode, body };
}

function validateAndConsumeUploadLease(state, payload) {
  if (!state.options.requireUploadLease) {
    return { ok: true, status: "lease_not_required" };
  }

  pruneExpiredLeases(state);
  const leaseId = String(payload.lease_id || "");
  if (!leaseId) {
    return { ok: false, statusCode: 428, status: "lease_required", message: "upload lease_id is required" };
  }

  const lease = state.activeLeases.get(leaseId);
  if (!lease) {
    return { ok: false, statusCode: 409, status: "lease_invalid", message: "upload lease is missing or expired" };
  }
  if (lease.used) {
    return { ok: false, statusCode: 409, status: "lease_used", message: "upload lease was already used" };
  }
  if (lease.expiresAt <= state.now().getTime()) {
    state.activeLeases.delete(leaseId);
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
  lease.usedAt = state.now().getTime();
  state.activeLeases.set(leaseId, lease);
  return { ok: true, status: "lease_consumed", lease };
}

function enrichEvents(state, payload) {
  return payload.events.map((event, index) => {
    const enriched = { ...event };
    const validationErrors = validateEvent(state, enriched);
    enriched.schema_version = String(payload.schema_version || "");
    enriched.parser_status = validationErrors.length === 0 ? "valid" : "invalid";
    enriched.parser_error = "";
    enriched.validation_errors = validationErrors.join(",");
    enriched.processing_version = state.options.processingVersion;
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

function validateEvent(state, event) {
  const errors = [];
  for (const field of state.options.requiredEventFields) {
    if (isBlank(event[field])) errors.push(`missing_${field}`);
  }

  const eventId = Number(event.event_id);
  if (!Number.isInteger(eventId) || eventId <= 0) errors.push("invalid_event_id");

  const recordId = Number(event.record_id);
  if (!Number.isInteger(recordId) || recordId <= 0) errors.push("invalid_record_id");

  if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) errors.push("invalid_timestamp");
  return errors;
}

async function upsertRegisteredAgent(state, payload, context, status, message) {
  if (isBlank(payload.agent_id) && isBlank(payload.host_id) && isBlank(payload.computer)) return null;
  const row = buildRegisteredAgentRow(state, payload, context, status, message);
  await state.clickhouseInsert("default.registered_agents", row);
  return row;
}

function buildRegisteredAgentRow(state, payload, context, status, message) {
  const cfg = state.options.agentConfig;
  const headers = context.headers || {};
  return {
    first_seen: state.now().toISOString(),
    last_seen: state.now().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    cert_serial: String(headers["x-client-cert-serial"] || ""),
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


function buildAdmissionRow(state, payload, decision, leaseId, retryAfterSeconds, message) {
  const lease = leaseId ? state.activeLeases.get(leaseId) : null;
  return {
    decided_at: state.now().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    queue_used_mb: Number(payload.queue_used_mb || 0),
    next_chunk_size_mb: Number(payload.next_chunk_size_mb || 0),
    retry_count: Number(payload.retry_count || 0),
    rank: Number(payload.rank || 0),
    active_uploads: state.activeLeases.size,
    max_active_uploads: state.options.maxActiveUploads,
    max_batch_mb: lease?.maxBatchMb ?? state.options.maxBatchMb,
    max_upload_rate_kbps: lease?.maxUploadRateKbps ?? state.options.maxUploadRateKbps,
    decision,
    lease_id: String(leaseId || ""),
    lease_ttl_seconds: decision === "ok" ? state.options.leaseTtlSeconds : 0,
    lease_expires_at: isoDateOrNow(state, lease?.expiresAtIso),
    retry_after_seconds: retryAfterSeconds,
    message: String(message || "")
  };
}

function buildChunkRow(state, payload, status, duplicate, message) {
  return {
    first_seen: state.now().toISOString(),
    last_seen: state.now().toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    chunk_id: String(payload.chunk_id || ""),
    sequence_number: Number(payload.sequence_number || 0),
    checksum: String(payload.checksum || ""),
    event_count: Number(payload.event_count || 0),
    lease_id: String(payload.lease_id || ""),
    lease_expires_at: isoDateOrNow(state, payload.lease_expires_at),
    max_batch_mb: Number(payload.max_batch_mb || 0),
    max_upload_rate_kbps: Number(payload.max_upload_rate_kbps || 0),
    status,
    duplicate: duplicate ? 1 : 0,
    attempts: 1,
    message: String(message || "")
  };
}


function pruneExpiredLeases(state) {
  const now = state.now().getTime();
  let removed = 0;
  for (const [leaseId, lease] of state.activeLeases.entries()) {
    if (lease.expiresAt <= now) {
      state.activeLeases.delete(leaseId);
      removed++;
    }
  }
  return removed;
}

function payloadBatchMb(payload) {
  const batchBytes = Number(payload.batch_bytes || 0);
  if (batchBytes > 0) return batchBytes / 1024 / 1024;
  return Buffer.byteLength(JSON.stringify(payload.events || []), "utf8") / 1024 / 1024;
}

function safePathPart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

function isoDateOrNow(state, value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? state.now().toISOString() : new Date(parsed).toISOString();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function mergeOptions(defaults, options) {
  return {
    ...defaults,
    ...options,
    requiredEventFields: options.requiredEventFields || defaults.requiredEventFields,
    agentConfig: { ...defaults.agentConfig, ...(options.agentConfig || {}) }
  };
}

function missingDependency(name) {
  return async () => {
    throw new Error(`dataplane dependency is required: ${name}`);
  };
}

module.exports = {
  DEFAULTS,
  createDataPlane,
  validateEvent,
  enrichEvents,
  validateAndConsumeUploadLease,
  buildChunkRow,
  buildRawChunkRow,
  sha256Hex
};
