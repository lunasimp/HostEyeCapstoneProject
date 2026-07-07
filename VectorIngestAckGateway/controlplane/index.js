const { buildAgentConfig, configEtag } = require("../shared/config");

function createControlPlane(deps = {}, options = {}) {
  const now = deps.now || (() => new Date());
  const leaseStore = deps.leaseStore || requiredDependency("leaseStore");
  const clickhouseInsert = deps.clickhouseInsert || requiredDependency("clickhouseInsert");
  const collectors = new Map();
  let schedulerLock = Promise.resolve();

  const settings = {
    publicBaseUrl: String(options.publicBaseUrl || process.env.PUBLIC_BASE_URL || "https://hosteye.iahn.hanoi.vn").replace(/\/+$/, ""),
    defaultCollectorId: options.defaultCollectorId || process.env.DEFAULT_COLLECTOR_ID || "collector-a",
    defaultCollectorUrl: options.defaultCollectorUrl || process.env.DEFAULT_COLLECTOR_URL || "",
    maxActiveUploads: Number(options.maxActiveUploads || process.env.ADMISSION_MAX_ACTIVE_UPLOADS || 64),
    leaseTtlSeconds: Number(options.leaseTtlSeconds || process.env.ADMISSION_LEASE_TTL_SECONDS || 30),
    maxBatchMb: Number(options.maxBatchMb || process.env.ADMISSION_MAX_BATCH_MB || 5),
    maxUploadRateKbps: Number(options.maxUploadRateKbps || process.env.ADMISSION_MAX_UPLOAD_RATE_KBPS || 1024),
    sendAfterMs: Number(options.sendAfterMs || process.env.CONTROL_SEND_AFTER_MS || 0),
    defaultCollectorSlotMs: Number(options.defaultCollectorSlotMs || process.env.CONTROL_COLLECTOR_SLOT_MS || 1000),
    collectorStaleMs: Number(options.collectorStaleMs || process.env.COLLECTOR_STALE_MS || 30000),
    allowDefaultCollectorFallback: parseBoolean(options.allowDefaultCollectorFallback ?? process.env.ALLOW_DEFAULT_COLLECTOR_FALLBACK, false)
  };
  if (!settings.defaultCollectorUrl) {
    settings.defaultCollectorUrl = `${settings.publicBaseUrl}/api/v1/telemetry`;
  }

  function heartbeat(payload) {
    const incoming = normalizeCollector(payload, now());
    const collector = mergeCollectorHeartbeat(collectors.get(incoming.collector_id), incoming);
    collectors.set(collector.collector_id, collector);
    return {
      ok: true,
      collector_id: collector.collector_id,
      last_seen: collector.last_seen,
      capacity_score: collector.capacity_score,
      ready: collector.ready,
      next_available_at: collector.next_available_at,
      upload_slot_ms: collector.upload_slot_ms
    };
  }

  async function bootstrap(payload, headers = {}) {
    const decidedAt = now();
    const nextChunkSizeMb = Number(payload.next_chunk_size_mb ?? payload.queue_state?.next_chunk_size_mb ?? 0);
    let decision = "ok";
    let message = "upload lease granted";
    let retryAfterSeconds = 0;
    let lease = null;
    let collector = null;
    let schedule = buildSendSchedule(settings, decidedAt, decision, collector);

    if (nextChunkSizeMb > settings.maxBatchMb) {
      decision = "ng";
      message = "next chunk is larger than max allowed batch";
      retryAfterSeconds = 60;
      schedule = buildSendSchedule(settings, decidedAt, decision, null);
    } else {
      const allocation = await withSchedulerLock(async () => {
        const selectedCollector = selectCollector(decidedAt);
        if (!selectedCollector) return { collector: null, schedule: buildSendSchedule(settings, decidedAt, "ng", null), lease: null };

        const selectedSchedule = buildSendSchedule(settings, decidedAt, "ok", selectedCollector);
        reserveCollectorSlot(selectedCollector, selectedSchedule);

        try {
          const leaseTtlSeconds = leaseTtlForSchedule(settings, decidedAt, selectedSchedule);
          const issuedLease = await leaseStore.issueLease({
            collectorId: selectedCollector.collector_id,
            collectorUrl: selectedCollector.url,
            agentId: payload.agent_id,
            hostId: payload.host_id,
            computer: payload.computer,
            sendAfter: selectedSchedule.sendAfter,
            leaseTtlSeconds,
            maxBatchMb: settings.maxBatchMb,
            maxUploadRateKbps: settings.maxUploadRateKbps
          });
          return { collector: selectedCollector, schedule: selectedSchedule, lease: issuedLease };
        } catch (error) {
          rollbackCollectorSlot(selectedCollector, selectedSchedule);
          throw error;
        }
      });

      collector = allocation.collector;
      schedule = allocation.schedule;
      lease = allocation.lease;
      if (!collector) {
        decision = "ng";
        message = "no healthy collector available";
        retryAfterSeconds = 15;
      }
    }

    const row = buildAdmissionRow(payload, collector, decision, lease, retryAfterSeconds, message, settings, decidedAt);
    await clickhouseInsert("default.admission_decisions", row);

    const cfg = buildAgentConfig(process.env);
    const cfgEtag = configEtag(cfg);
    const configStatus = etagMatches(headers["if-none-match"] || payload.config_etag, cfgEtag) ? "unchanged" : "changed";
    const body = {
      admission: decision,
      config_status: configStatus,
      config_etag: cfgEtag,
      agent_config: cfg,
      collector_id: collector?.collector_id || "",
      collector_url: collector?.url || "",
      routing: {
        control_url: `${settings.publicBaseUrl}/api/v1/control/bootstrap`,
        admission_url: `${settings.publicBaseUrl}/api/v1/control/bootstrap`,
        telemetry_url: collector?.url || `${settings.publicBaseUrl}/api/v1/telemetry`,
        config_url: `${settings.publicBaseUrl}/api/v1/agent/config`
      },
      server_time: schedule.serverTime,
      send_after: schedule.sendAfter,
      send_not_before: schedule.sendAfter,
      send_delay_ms: schedule.sendDelayMs,
      schedule_reason: schedule.reason,
      collector_ready_at: schedule.collectorReadyAt,
      collector_reserved_until: schedule.collectorReservedUntil,
      collector_upload_slot_ms: schedule.collectorUploadSlotMs,
      lease_id: lease?.lease_id || "",
      lease_ttl_seconds: lease ? lease.lease_ttl_seconds : 0,
      lease_expires_at: lease?.expires_at || decidedAt.toISOString(),
      max_batch_mb: settings.maxBatchMb,
      max_upload_rate_kbps: settings.maxUploadRateKbps,
      retry_after_seconds: retryAfterSeconds,
      message
    };

    return {
      statusCode: decision === "ok" ? 200 : 429,
      headers: retryAfterSeconds > 0 ? { "retry-after": String(retryAfterSeconds) } : {},
      body
    };
  }

  function selectCollector(decidedAt = now()) {
    const cutoff = decidedAt.getTime() - settings.collectorStaleMs;
    const healthy = Array.from(collectors.values())
      .filter((collector) => collector.health === "healthy" && Date.parse(collector.last_seen) >= cutoff)
      .sort((left, right) => {
        const leftReadyAt = Date.parse(left.next_available_at || left.last_seen || decidedAt.toISOString());
        const rightReadyAt = Date.parse(right.next_available_at || right.last_seen || decidedAt.toISOString());
        if (leftReadyAt !== rightReadyAt) return leftReadyAt - rightReadyAt;
        return right.capacity_score - left.capacity_score;
      });
    if (healthy.length > 0) return healthy[0];
    if (!settings.allowDefaultCollectorFallback) return null;
    return {
      collector_id: settings.defaultCollectorId,
      url: settings.defaultCollectorUrl,
      health: "healthy",
      ready: true,
      active_uploads: 0,
      max_uploads: settings.maxActiveUploads,
      capacity_score: settings.maxActiveUploads,
      upload_slot_ms: settings.defaultCollectorSlotMs,
      next_available_at: decidedAt.toISOString(),
      heartbeat_next_available_at: decidedAt.toISOString(),
      control_reserved_until: "",
      last_seen: now().toISOString()
    };
  }

  function listCollectors() {
    return Array.from(collectors.values());
  }

  return {
    heartbeat,
    bootstrap,
    listCollectors
  };

  function withSchedulerLock(work) {
    const run = schedulerLock.then(work, work);
    schedulerLock = run.catch(() => {});
    return run;
  }
}

function buildSendSchedule(settings, decidedAt, decision, collector) {
  const configuredDelayMs = decision === "ok" ? Math.max(0, Number(settings.sendAfterMs || 0)) : 0;
  const baseSendAfterMs = decidedAt.getTime() + configuredDelayMs;
  const collectorReadyMs = collector ? parseDateMs(collector.next_available_at, decidedAt.getTime()) : decidedAt.getTime();
  const sendAfterMs = decision === "ok" ? Math.max(baseSendAfterMs, collectorReadyMs) : decidedAt.getTime();
  const sendAfter = new Date(sendAfterMs);
  const slotMs = Math.max(1, Number(collector?.upload_slot_ms || settings.defaultCollectorSlotMs || 1000));
  const reservedUntil = new Date(sendAfterMs + slotMs);
  const totalDelayMs = Math.max(0, sendAfterMs - decidedAt.getTime());
  const reason = scheduleReason(configuredDelayMs, collectorReadyMs, baseSendAfterMs, decidedAt.getTime(), decision);
  return {
    serverTime: decidedAt.toISOString(),
    sendAfter: sendAfter.toISOString(),
    sendDelayMs: totalDelayMs,
    reason,
    collectorReadyAt: new Date(collectorReadyMs).toISOString(),
    collectorReservedUntil: reservedUntil.toISOString(),
    collectorUploadSlotMs: slotMs
  };
}

function reserveCollectorSlot(collector, schedule) {
  if (!collector) return;
  collector.previous_next_available_at = collector.next_available_at;
  collector.previous_control_reserved_until = collector.control_reserved_until || "";
  collector.control_reserved_until = maxIsoDate(collector.control_reserved_until, schedule.collectorReservedUntil);
  collector.next_available_at = maxIsoDate(collector.heartbeat_next_available_at, collector.control_reserved_until);
  collector.ready = false;
  collector.reserved_until = schedule.collectorReservedUntil;
}

function rollbackCollectorSlot(collector, schedule) {
  if (!collector) return;
  collector.next_available_at = collector.previous_next_available_at || collector.heartbeat_next_available_at || schedule.collectorReadyAt;
  collector.control_reserved_until = collector.previous_control_reserved_until || "";
  collector.reserved_until = collector.control_reserved_until;
  collector.ready = parseDateMs(collector.next_available_at, Date.now()) <= Date.now();
  delete collector.previous_next_available_at;
  delete collector.previous_control_reserved_until;
}

function leaseTtlForSchedule(settings, decidedAt, schedule) {
  const sendDelaySeconds = Math.ceil(Math.max(0, Date.parse(schedule.sendAfter) - decidedAt.getTime()) / 1000);
  const slotSeconds = Math.ceil(Math.max(0, Number(schedule.collectorUploadSlotMs || 0)) / 1000);
  return Math.max(settings.leaseTtlSeconds, sendDelaySeconds + slotSeconds + 5);
}

function scheduleReason(configuredDelayMs, collectorReadyMs, baseSendAfterMs, decidedAtMs, decision) {
  if (decision !== "ok") return "not_admitted";
  if (collectorReadyMs > baseSendAfterMs) return "collector_next_available_at";
  if (configuredDelayMs > 0) return "configured_control_delay";
  if (baseSendAfterMs > decidedAtMs) return "scheduled";
  return "collector_ready_now";
}

function parseDateMs(value, fallbackMs) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? fallbackMs : parsed;
}

function normalizeCollector(payload, seenAt) {
  const activeUploads = Number(payload.active_uploads || 0);
  const maxUploads = Number(payload.max_uploads || payload.max_uploads || 64);
  const writeLatency = Number(payload.write_latency_ms || 0);
  const storageLag = Number(payload.storage_lag || 0);
  const uploadSlotMs = Math.max(1, Number(payload.upload_slot_ms || 1000));
  const nextAvailableAtMs = Math.max(seenAt.getTime(), parseDateMs(payload.next_available_at, seenAt.getTime()));
  const freeSlots = Math.max(0, maxUploads - activeUploads);
  return {
    collector_id: String(payload.collector_id || "collector-unknown"),
    url: String(payload.url || ""),
    health: payload.health || "healthy",
    ready: Boolean(payload.ready ?? (activeUploads < maxUploads && nextAvailableAtMs <= seenAt.getTime())),
    active_uploads: activeUploads,
    max_uploads: maxUploads,
    upload_slot_ms: uploadSlotMs,
    heartbeat_next_available_at: new Date(nextAvailableAtMs).toISOString(),
    control_reserved_until: "",
    next_available_at: new Date(nextAvailableAtMs).toISOString(),
    write_latency_ms: writeLatency,
    storage_lag: storageLag,
    storage_tag: String(payload.storage_tag || ""),
    capacity_score: freeSlots * 1000 - writeLatency - storageLag * 10,
    last_seen: seenAt.toISOString()
  };
}

function mergeCollectorHeartbeat(existing, incoming) {
  if (!existing) return incoming;
  const controlReservedUntil = maxIsoDate(existing.control_reserved_until, existing.reserved_until);
  const effectiveNextAvailableAt = maxIsoDate(incoming.heartbeat_next_available_at, controlReservedUntil);
  return {
    ...incoming,
    control_reserved_until: controlReservedUntil,
    reserved_until: controlReservedUntil,
    next_available_at: effectiveNextAvailableAt,
    ready: incoming.ready && parseDateMs(effectiveNextAvailableAt, Date.now()) <= Date.now()
  };
}

function maxIsoDate(...values) {
  const maxMs = values
    .map((value) => Date.parse(String(value || "")))
    .filter((value) => !Number.isNaN(value))
    .reduce((max, value) => Math.max(max, value), 0);
  return maxMs > 0 ? new Date(maxMs).toISOString() : "";
}

function buildAdmissionRow(payload, collector, decision, lease, retryAfterSeconds, message, settings, decidedAt) {
  return {
    decided_at: decidedAt.toISOString(),
    agent_id: String(payload.agent_id || ""),
    host_id: String(payload.host_id || ""),
    computer: String(payload.computer || ""),
    queue_used_mb: Number(payload.queue_used_mb ?? payload.queue_state?.queue_used_mb ?? 0),
    next_chunk_size_mb: Number(payload.next_chunk_size_mb ?? payload.queue_state?.next_chunk_size_mb ?? 0),
    retry_count: Number(payload.retry_count ?? payload.queue_state?.retry_count ?? 0),
    rank: 0,
    active_uploads: Number(collector?.active_uploads || 0),
    max_active_uploads: settings.maxActiveUploads,
    max_batch_mb: settings.maxBatchMb,
    max_upload_rate_kbps: settings.maxUploadRateKbps,
    decision,
    lease_id: String(lease?.lease_id || ""),
    lease_ttl_seconds: decision === "ok" ? Number(lease?.lease_ttl_seconds || 0) : 0,
    lease_expires_at: lease?.expires_at || decidedAt.toISOString(),
    retry_after_seconds: retryAfterSeconds,
    message: String(message || "")
  };
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).toLowerCase() === "true";
}

function etagMatches(headerValue, expectedEtag) {
  const normalize = (value) => String(value || "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  const expected = normalize(expectedEtag);
  return String(headerValue || "")
    .split(",")
    .map(normalize)
    .some((candidate) => candidate && candidate === expected);
}

function requiredDependency(name) {
  return async () => {
    throw new Error(`controlplane dependency is required: ${name}`);
  };
}

module.exports = {
  createControlPlane
};
