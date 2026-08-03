import http from "node:http";
import { URL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

loadDotEnv();

const config = {
  port: intFromEnv("PORT", 5055),
  clickhouseUrl: process.env.CLICKHOUSE_URL || "http://localhost:8123",
  database: process.env.CLICKHOUSE_DATABASE || "default",
  username: process.env.CLICKHOUSE_USERNAME || "default",
  password: process.env.CLICKHOUSE_PASSWORD || "",
  corsOrigin: process.env.CORS_ORIGIN || "*",
  registrationUrl: process.env.HOSTEYE_REGISTRATION_URL || "http://localhost:5054",
  registrationAdminToken: process.env.HOSTEYE_REGISTRATION_ADMIN_TOKEN || "hosteye-admin-demo",
  dynamicConfigUrl: process.env.HOSTEYE_DYNAMIC_CONFIG_URL || "http://localhost:5063",
  dynamicConfigAdminToken: process.env.HOSTEYE_DYNAMIC_CONFIG_ADMIN_TOKEN || "hosteye-admin-demo",
};

const DYNAMIC_LOG_TYPES = Object.freeze([
  { id: "windows-application", name: "Windows Application", description: "Application events emitted by Windows services and applications.", channels: ["Application"] },
  { id: "windows-system", name: "Windows System", description: "Operating system, driver, service, and startup events.", channels: ["System"] },
  { id: "windows-security", name: "Windows Security", description: "Authentication, account, privilege, audit, and WFP security events.", channels: ["Security"] },
  { id: "sysmon", name: "Sysmon", description: "Process, file, registry, network, and DNS telemetry produced by Sysmon.", channels: ["Microsoft-Windows-Sysmon/Operational"], sensors: ["sysmon", "network"] },
  { id: "powershell", name: "PowerShell", description: "PowerShell operational and script block telemetry.", channels: ["Microsoft-Windows-PowerShell/Operational"], sensors: ["powershell"] },
  { id: "wmi", name: "WMI Activity", description: "Operational events from Windows Management Instrumentation.", channels: ["Microsoft-Windows-WMI-Activity/Operational"] },
  { id: "defender", name: "Microsoft Defender", description: "Microsoft Defender detections and operational health events.", channels: ["Microsoft-Windows-Windows Defender/Operational"] },
]);

const DYNAMIC_LOG_FIELDS = Object.freeze([
  { id: "timestamp", field: "timestamp", name: "Timestamp", description: "Event occurrence time.", required: true },
  { id: "hostname", field: "computer", name: "Hostname", description: "Normalized Windows computer name.", required: true },
  { id: "username", field: "user_name", name: "Username", description: "Account associated with the event." },
  { id: "process_name", field: "process_name", name: "Process name", description: "Executable name associated with process activity." },
  { id: "process_id", field: "process_id", name: "Process ID", description: "Numeric process identifier." },
  { id: "source_ip", field: "source_ip", name: "Source IP", description: "Source network address when available." },
  { id: "destination_ip", field: "destination_ip", name: "Destination IP", description: "Destination network address when available." },
  { id: "destination_port", field: "destination_port", name: "Port", description: "Destination network port when available." },
  { id: "event_id", field: "event_id", name: "Event ID", description: "Windows or Sysmon event identifier.", required: true },
  { id: "channel", field: "channel", name: "Channel", description: "Source Windows Event Log channel.", required: true },
  { id: "message", field: "message", name: "Message", description: "Human-readable event message." },
]);

const routes = [
  ["GET", /^\/api\/health$/, health],
  ["GET", /^\/api\/dashboard\/overview\/summary$/, overviewSummary],
  ["GET", /^\/api\/dashboard\/overview\/log-volume$/, overviewLogVolume],
  ["GET", /^\/api\/dashboard\/overview\/top-hosts$/, overviewTopHosts],
  ["GET", /^\/api\/dashboard\/overview\/event-types$/, overviewEventTypes],
  ["GET", /^\/api\/dashboard\/overview\/security-timeline$/, overviewSecurityTimeline],
  ["GET", /^\/api\/dashboard\/hosts\/summary$/, hostsSummary],
  ["GET", /^\/api\/dashboard\/agents\/registered$/, registeredAgents],
  ["GET", /^\/api\/dashboard\/jitter\/summary$/, jitterSummary],
  ["GET", /^\/api\/dashboard\/jitter\/hosts$/, jitterHosts],
  ["GET", /^\/api\/dashboard\/chunks\/summary$/, chunksSummary],
  ["GET", /^\/api\/dashboard\/chunks\/hosts$/, chunksHosts],
  ["GET", /^\/api\/dashboard\/process\/top-processes$/, processTopProcesses],
  ["GET", /^\/api\/dashboard\/process\/recent$/, processRecent],
  ["GET", /^\/api\/dashboard\/network\/top-destination-ips$/, networkTopDestinationIps],
  ["GET", /^\/api\/dashboard\/network\/recent$/, networkRecent],
  ["GET", /^\/api\/dashboard\/dns\/top-domains$/, dnsTopDomains],
  ["GET", /^\/api\/dashboard\/dns\/recent$/, dnsRecent],
  ["GET", /^\/api\/dashboard\/registry\/recent$/, registryRecent],
  ["GET", /^\/api\/dashboard\/file\/recent$/, fileRecent],
  ["GET", /^\/api\/dashboard\/process-access\/recent$/, processAccessRecent],
  ["GET", /^\/api\/dashboard\/powershell\/volume$/, powershellVolume],
  ["GET", /^\/api\/dashboard\/powershell\/recent$/, powershellRecent],
  ["GET", /^\/api\/dashboard\/hosts\/heatmap$/, hostsHeatmap],
  ["GET", /^\/api\/dashboard\/registrations\/summary$/, registrationsSummary],
  ["GET", /^\/api\/dashboard\/dynamic-config\/summary$/, dynamicConfigSummary],
  ["GET", /^\/api\/dashboard\/dynamic-config\/policies$/, dynamicConfigPolicies],
  ["GET", /^\/api\/dashboard\/dynamic-config\/agents$/, dynamicConfigAgents],
  ["GET", /^\/api\/dashboard\/dynamic-config\/audit$/, dynamicConfigAudit],
  ["GET", /^\/api\/dashboard\/dynamic-config\/catalog$/, dynamicConfigCatalog],
  ["POST", /^\/api\/dashboard\/dynamic-config\/preview$/, dynamicConfigPreview],
  ["POST", /^\/api\/dashboard\/dynamic-config\/policies$/, dynamicConfigUpsertPolicy],
  ["GET", /^\/api\/dashboard\/hosts\/heatmap\/cell$/, hostsHeatmapCell],
  ["GET", /^\/api\/logs\/search$/, logsSearch],
  ["GET", /^\/api\/alerts$/, alertsList],
  ["GET", /^\/api\/alerts\/([^/]+)$/, alertDetail],
  ["GET", /^\/api\/logs\/raw\/([^/]+)$/, logsRaw],
];

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const route = routes.find(([method, pattern]) => method === req.method && pattern.test(url.pathname));

  if (!route) {
    sendJson(res, 404, { message: "Route not found" });
    return;
  }

  try {
    const match = url.pathname.match(route[1]);
    await route[2]({ req, url, params: match?.slice(1) || [] }, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      message: error.message || "Internal server error",
      detail: process.env.NODE_ENV === "production" ? undefined : error.detail,
    });
  }
});

server.listen(config.port, () => {
  console.log(`HostEye Dashboard API listening on http://localhost:${config.port}`);
  console.log(`ClickHouse: ${config.clickhouseUrl} database=${config.database}`);
});

async function health(_ctx, res) {
  const result = await queryRows(`
    SELECT
      count() AS rows,
      min(kafka_timestamp) AS firstSeen,
      max(kafka_timestamp) AS lastSeen,
      dateDiff('second', max(kafka_timestamp), now()) AS dataAgeSeconds
    FROM default.windows_system_logs
  `);
  const row = result[0] || {};
  const rows = Number(row.rows || 0);
  const dataAgeSeconds = rows > 0 ? Math.max(0, Number(row.dataAgeSeconds || 0)) : null;
  sendJson(res, 200, {
    status: "ok",
    clickhouse: config.clickhouseUrl,
    database: config.database,
    rows,
    firstSeen: rows > 0 ? row.firstSeen || null : null,
    lastSeen: rows > 0 ? row.lastSeen || null : null,
    dataAgeSeconds,
    stale: dataAgeSeconds !== null && dataAgeSeconds > 24 * 60 * 60,
  });
}

async function overviewSummary(ctx, res) {
  const where = timeWhere(ctx.url);
  const rows = await queryRows(`
    SELECT
      count() AS totalEvents,
      uniqExact(computer) AS totalHosts,
      uniqExact(channel) AS totalChannels,
      uniqExact(event_id) AS totalEventIds,
      min(kafka_timestamp) AS firstSeen,
      max(kafka_timestamp) AS lastSeen
    FROM default.windows_system_logs
    ${where.sql}
  `);
  const row = rows[0] || {};
  const totalEvents = Number(row.totalEvents || 0);
  sendJson(res, 200, {
    totalEvents,
    totalHosts: Number(row.totalHosts || 0),
    totalChannels: Number(row.totalChannels || 0),
    totalEventIds: Number(row.totalEventIds || 0),
    firstSeen: totalEvents > 0 ? row.firstSeen || null : null,
    lastSeen: totalEvents > 0 ? row.lastSeen || null : null,
  });
}

async function overviewLogVolume(ctx, res) {
  const where = timeWhere(ctx.url);
  const bucket = bucketFunction(bucketParam(ctx.url));
  const rows = await queryRows(`
    SELECT
      ${bucket}(kafka_timestamp) AS time,
      count() AS events
    FROM default.windows_system_logs
    ${where.sql}
    GROUP BY time
    ORDER BY time ASC
  `);
  sendJson(res, 200, { items: rows });
}

async function overviewTopHosts(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 10, 100);
  const rows = await queryRows(`
    SELECT computer, count() AS events
    FROM default.windows_system_logs
    ${where.sql}
    GROUP BY computer
    ORDER BY events DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function overviewEventTypes(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT event_type AS eventType, count() AS volume
    FROM default.security_overview_events
    ${where.sql}
    GROUP BY eventType
    ORDER BY volume DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function overviewSecurityTimeline(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_type AS eventType,
      channel,
      event_id AS eventId,
      user_name AS userName,
      process_path AS processPath,
      source_ip AS sourceIp,
      destination_ip AS destinationIp,
      left(message, 300) AS message
    FROM default.security_overview_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function hostsSummary(ctx, res) {
  const limit = limitParam(ctx.url, 500, 5000);
  const logsWhere = timeWhere(ctx.url, ["computer != ''"]);
  const metricsWhere = operationalTimeWhere(ctx.url, "metric_timestamp", ["computer != ''"]);
  const host = ctx.url.searchParams.get("host");
  const agentPredicates = host ? `WHERE computer = ${sqlString(host)}` : "";

  const [logRows, agentRows, metricRows] = await Promise.all([
    queryRows(`
      SELECT
        computer,
        count() AS totalEvents,
        min(kafka_timestamp) AS firstSeen,
        max(kafka_timestamp) AS lastLogSeen,
        uniqExact(channel) AS channels,
        uniqExact(event_id) AS eventIds
      FROM default.windows_system_logs
      ${logsWhere.sql}
      GROUP BY computer
      ORDER BY lastLogSeen DESC
      LIMIT ${limit}
    `),
    queryRows(`
      SELECT
        agent_id AS agentId,
        host_id AS hostId,
        computer,
        min(first_seen) AS agentFirstSeen,
        max(last_seen) AS agentLastSeen,
        argMax(shipper_version, last_seen) AS shipperVersion,
        argMax(status, last_seen) AS agentStatus,
        argMax(enrollment_status, last_seen) AS enrollmentStatus,
        argMax(last_chunk_id, last_seen) AS registeredLastChunk,
        argMax(last_ack_status, last_seen) AS registeredLastAckStatus
      FROM default.registered_agents
      ${agentPredicates}
      GROUP BY agent_id, host_id, computer
      ORDER BY agentLastSeen DESC
      LIMIT ${limit}
    `),
    queryRows(`
      SELECT
        computer,
        argMax(agent_id, metric_timestamp) AS metricAgentId,
        argMax(host_id, metric_timestamp) AS metricHostId,
        argMax(shipper_version, metric_timestamp) AS metricShipperVersion,
        max(metric_timestamp) AS lastMetricSeen,
        argMax(chunk_id, metric_timestamp) AS metricLastChunk,
        argMax(spool_file, metric_timestamp) AS spoolFile,
        argMax(ack_status, metric_timestamp) AS metricLastAckStatus,
        argMax(status_code, metric_timestamp) AS statusCode,
        argMax(success, metric_timestamp) AS success,
        argMax(data_loss, metric_timestamp) AS dataLoss,
        argMax(spool_depth_bytes, metric_timestamp) AS spoolDepthBytes,
        argMax(pending_file_count, metric_timestamp) AS pendingFileCount,
        count() AS uploadSamples
      FROM default.shipper_runtime_metrics
      ${metricsWhere.sql}
      GROUP BY computer
      ORDER BY lastMetricSeen DESC
      LIMIT ${limit}
    `),
  ]);

  const byHost = new Map();
  const ensureHost = (row) => {
    const computer = String(row.computer || row.hostId || row.agentId || "").trim();
    if (!computer) return null;
    if (!byHost.has(computer)) {
      byHost.set(computer, {
        computer,
        agentId: "",
        hostId: "",
        shipperVersion: "",
        agentStatus: "",
        enrollmentStatus: "",
        agentFirstSeen: null,
        agentLastSeen: null,
        firstSeen: null,
        lastLogSeen: null,
        lastMetricSeen: null,
        lastSeen: null,
        lastChunk: "",
        lastAckStatus: "",
        statusCode: 0,
        success: null,
        dataLoss: false,
        spoolDepthBytes: 0,
        pendingFileCount: 0,
        uploadSamples: 0,
        totalEvents: 0,
        channels: 0,
        eventIds: 0,
      });
    }
    return byHost.get(computer);
  };

  for (const row of logRows) {
    const item = ensureHost(row);
    if (!item) continue;
    Object.assign(item, {
      firstSeen: row.firstSeen || null,
      lastLogSeen: row.lastLogSeen || null,
      totalEvents: Number(row.totalEvents || 0),
      channels: Number(row.channels || 0),
      eventIds: Number(row.eventIds || 0),
    });
  }

  for (const row of agentRows) {
    const item = ensureHost(row);
    if (!item) continue;
    if (!item.agentLastSeen || dateValue(row.agentLastSeen) >= dateValue(item.agentLastSeen)) {
      Object.assign(item, {
        agentId: row.agentId || item.agentId,
        hostId: row.hostId || item.hostId,
        shipperVersion: row.shipperVersion || item.shipperVersion,
        agentStatus: row.agentStatus || "",
        enrollmentStatus: row.enrollmentStatus || "",
        agentFirstSeen: row.agentFirstSeen || null,
        agentLastSeen: row.agentLastSeen || null,
        lastChunk: row.registeredLastChunk || item.lastChunk,
        lastAckStatus: row.registeredLastAckStatus || item.lastAckStatus,
      });
    }
  }

  for (const row of metricRows) {
    const item = ensureHost(row);
    if (!item) continue;
    Object.assign(item, {
      agentId: item.agentId || row.metricAgentId || "",
      hostId: item.hostId || row.metricHostId || "",
      shipperVersion: item.shipperVersion || row.metricShipperVersion || "",
      lastMetricSeen: row.lastMetricSeen || null,
      lastChunk: row.metricLastChunk || row.spoolFile || item.lastChunk,
      lastAckStatus: row.metricLastAckStatus || item.lastAckStatus,
      statusCode: Number(row.statusCode || 0),
      success: row.success === undefined || row.success === null ? null : Number(row.success) === 1,
      dataLoss: Number(row.dataLoss || 0) === 1,
      spoolDepthBytes: Number(row.spoolDepthBytes || 0),
      pendingFileCount: Number(row.pendingFileCount || 0),
      uploadSamples: Number(row.uploadSamples || 0),
    });
  }

  const hosts = [...byHost.values()]
    .map((item) => {
      item.lastSeen = latestDate(item.agentLastSeen, item.lastLogSeen, item.lastMetricSeen);
      const activity = hostStatus(item.lastSeen);
      const collection = collectionStatus(item, activity.level);
      return {
        ...item,
        statusLevel: activity.level,
        statusLabel: activity.label,
        ageSeconds: activity.ageSeconds,
        collectionLevel: collection.level,
        collectionLabel: collection.label,
      };
    })
    .sort((left, right) => dateValue(right.lastSeen) - dateValue(left.lastSeen))
    .slice(0, limit);

  const groups = ["online", "active", "delayed", "stale", "unknown"].map((level) => ({
    level,
    label: hostLevelLabel(level),
    count: hosts.filter((item) => item.statusLevel === level).length,
    hosts: hosts.filter((item) => item.statusLevel === level).slice(0, 20),
  }));
  const collectionGroups = ["ok", "delayed", "failed", "stale", "disabled", "unknown"].map((level) => ({
    level,
    label: collectionLevelLabel(level),
    count: hosts.filter((item) => item.collectionLevel === level).length,
  }));

  sendJson(res, 200, { hosts, groups, collectionGroups });
}

async function registeredAgents(ctx, res) {
  const limit = limitParam(ctx.url, 500, 5000);
  const rows = await queryRows(`
    SELECT
      agent_id AS agentId,
      host_id AS hostId,
      computer,
      argMax(cert_serial, last_seen) AS certSerial,
      min(first_seen) AS firstSeen,
      max(last_seen) AS lastSeen,
      argMaxIf(schema_version, last_seen, schema_version != 'legacy') AS schemaVersion,
      argMax(source_platform, last_seen) AS sourcePlatform,
      argMax(shipper_version, last_seen) AS shipperVersion,
      argMax(status, last_seen) AS status,
      argMax(enrollment_status, last_seen) AS enrollmentStatus,
      argMax(last_chunk_id, last_seen) AS lastChunkId,
      argMax(last_ack_status, last_seen) AS lastAckStatus,
      argMax(last_event_count, last_seen) AS lastEventCount,
      argMax(normal_jitter_window_ms, last_seen) AS normalJitterWindowMs,
      argMax(recovery_jitter_window_ms, last_seen) AS recoveryJitterWindowMs,
      argMax(max_events, last_seen) AS maxEvents,
      argMax(max_bytes, last_seen) AS maxBytes
    FROM default.registered_agents
    GROUP BY agent_id, host_id, computer
    ORDER BY lastSeen DESC
    LIMIT ${limit}
  `);

  sendJson(res, 200, {
    items: rows.map((row) => {
      const status = hostStatus(row.lastSeen);
      return {
        ...row,
        statusLevel: status.level,
        statusLabel: status.label,
        ageSeconds: status.ageSeconds,
      };
    }),
  });
}

async function jitterSummary(ctx, res) {
  const where = operationalTimeWhere(ctx.url, "metric_timestamp");
  const rows = await queryRows(`
    SELECT
      count() AS samples,
      uniqExact(computer) AS hosts,
      avg(planned_jitter_ms) AS avgJitterMs,
      quantile(0.95)(planned_jitter_ms) AS p95JitterMs,
      max(planned_jitter_ms) AS maxJitterMs,
      avg(batch_size) AS avgBatchSize,
      max(spool_depth_bytes) AS maxSpoolDepthBytes,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
  `);

  const worstRows = await queryRows(`
    SELECT
      computer,
      quantile(0.95)(planned_jitter_ms) AS p95JitterMs,
      max(spool_depth_bytes) AS spoolDepthBytes,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
    GROUP BY computer
    ORDER BY p95JitterMs DESC, spoolDepthBytes DESC
    LIMIT 1
  `);

  sendJson(res, 200, {
    ...(rows[0] || {}),
    worstHost: worstRows[0] || null,
  });
}

async function jitterHosts(ctx, res) {
  const where = operationalTimeWhere(ctx.url, "metric_timestamp");
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      computer,
      anyLast(agent_id) AS agentId,
      count() AS samples,
      avg(planned_jitter_ms) AS avgJitterMs,
      min(planned_jitter_ms) AS minJitterMs,
      max(planned_jitter_ms) AS maxJitterMs,
      quantile(0.95)(planned_jitter_ms) AS p95JitterMs,
      avg(batch_size) AS avgBatchSize,
      max(batch_size) AS maxBatchSize,
      max(spool_depth_bytes) AS spoolDepthBytes,
      max(pending_file_count) AS pendingFileCount,
      max(send_duration_ms) AS maxSendDurationMs,
      argMax(scheduled_send_at, metric_timestamp) AS scheduledSendAt,
      argMax(actual_send_at, metric_timestamp) AS actualSendAt,
      argMax(send_started_at, metric_timestamp) AS sendStartedAt,
      argMax(send_completed_at, metric_timestamp) AS sendCompletedAt,
      argMax(jitter_delay_ms, metric_timestamp) AS jitterDelayMs,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
    GROUP BY computer
    ORDER BY lastSeen DESC
    LIMIT ${limit}
  `);

  sendJson(res, 200, {
    items: rows.map((row) => ({
      ...row,
      statusLevel: jitterStatus(row),
      statusLabel: jitterStatusLabel(jitterStatus(row)),
    })),
  });
}

async function chunksSummary(ctx, res) {
  const where = operationalTimeWhere(ctx.url, "metric_timestamp");
  const rows = await queryRows(`
    SELECT
      count() AS chunks,
      uniqExact(computer) AS hosts,
      sum(batch_size) AS eventsSent,
      avg(batch_size) AS avgBatchSize,
      max(spool_depth_bytes) AS maxSpoolDepthBytes,
      sum(if(success = 1, 1, 0)) AS okChunks,
      sum(if(success = 0, 1, 0)) AS failedChunks,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
  `);

  const latestRows = await queryRows(`
    SELECT
      computer,
      argMax(spool_file, metric_timestamp) AS spoolFile,
      argMax(status_code, metric_timestamp) AS statusCode,
      argMax(success, metric_timestamp) AS success,
      argMax(batch_size, metric_timestamp) AS batchSize,
      argMax(spool_depth_bytes, metric_timestamp) AS spoolDepthBytes,
      argMax(planned_jitter_ms, metric_timestamp) AS plannedJitterMs,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
    GROUP BY computer
    ORDER BY lastSeen DESC
    LIMIT 1
  `);

  sendJson(res, 200, {
    ...(rows[0] || {}),
    latestChunk: latestRows[0] || null,
  });
}

async function chunksHosts(ctx, res) {
  const where = operationalTimeWhere(ctx.url, "metric_timestamp");
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      computer,
      argMax(agent_id, metric_timestamp) AS agentId,
      argMax(spool_file, metric_timestamp) AS lastChunk,
      argMax(line_offset, metric_timestamp) AS lineOffset,
      argMax(next_line_offset, metric_timestamp) AS nextLineOffset,
      argMax(byte_offset, metric_timestamp) AS byteOffset,
      argMax(next_byte_offset, metric_timestamp) AS nextByteOffset,
      argMax(batch_size, metric_timestamp) AS batchSize,
      argMax(batch_bytes, metric_timestamp) AS batchBytes,
      argMax(compressed_bytes, metric_timestamp) AS compressedBytes,
      argMax(status_code, metric_timestamp) AS statusCode,
      argMax(success, metric_timestamp) AS success,
      argMax(data_loss, metric_timestamp) AS dataLoss,
      argMax(planned_jitter_ms, metric_timestamp) AS plannedJitterMs,
      argMax(jitter_window_ms, metric_timestamp) AS jitterWindowMs,
      argMax(scheduled_send_at, metric_timestamp) AS scheduledSendAt,
      argMax(actual_send_at, metric_timestamp) AS actualSendAt,
      argMax(send_started_at, metric_timestamp) AS sendStartedAt,
      argMax(send_completed_at, metric_timestamp) AS sendCompletedAt,
      argMax(jitter_delay_ms, metric_timestamp) AS jitterDelayMs,
      argMax(backoff_delay_ms, metric_timestamp) AS backoffDelayMs,
      argMax(next_retry_at, metric_timestamp) AS nextRetryAt,
      argMax(lease_id, metric_timestamp) AS leaseId,
      argMax(lease_expires_at, metric_timestamp) AS leaseExpiresAt,
      argMax(lease_ttl_seconds, metric_timestamp) AS leaseTtlSeconds,
      argMax(max_batch_mb, metric_timestamp) AS maxBatchMb,
      argMax(max_upload_rate_kbps, metric_timestamp) AS maxUploadRateKbps,
      argMax(send_duration_ms, metric_timestamp) AS sendDurationMs,
      argMax(spool_depth_bytes, metric_timestamp) AS spoolDepthBytes,
      argMax(pending_file_count, metric_timestamp) AS pendingFileCount,
      count() AS chunks,
      sum(batch_size) AS eventsSent,
      max(metric_timestamp) AS lastSeen
    FROM default.shipper_runtime_metrics
    ${where.sql}
    GROUP BY computer
    ORDER BY lastSeen DESC
    LIMIT ${limit}
  `);

  sendJson(res, 200, {
    items: rows.map((row) => ({
      ...row,
      statusLevel: chunkStatus(row),
      statusLabel: chunkStatusLabel(chunkStatus(row)),
    })),
  });
}

async function processTopProcesses(ctx, res) {
  const where = timeWhere(ctx.url, ["process_path != ''"]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT process_path AS processPath, count() AS volume
    FROM default.process_events
    ${where.sql}
    GROUP BY processPath
    ORDER BY volume DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function processRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_type AS eventType,
      event_id AS eventId,
      user_name AS userName,
      process_path AS processPath,
      parent_process_path AS parentProcessPath,
      left(command_line, 800) AS commandLine,
      process_guid AS processGuid,
      parent_process_guid AS parentProcessGuid
    FROM default.process_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function networkTopDestinationIps(ctx, res) {
  const where = timeWhere(ctx.url, ["destination_ip != ''"]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT destination_ip AS destinationIp, count() AS volume
    FROM default.network_events
    ${where.sql}
    GROUP BY destinationIp
    ORDER BY volume DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function networkRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      user_name AS userName,
      process_guid AS processGuid,
      process_path AS processPath,
      source_ip AS sourceIp,
      source_port AS sourcePort,
      destination_ip AS destinationIp,
      destination_port AS destinationPort,
      protocol,
      initiated
    FROM default.network_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function dnsTopDomains(ctx, res) {
  const where = timeWhere(ctx.url, ["dns_query != ''"]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT dns_query AS domain, count() AS volume
    FROM default.dns_events
    ${where.sql}
    GROUP BY domain
    ORDER BY volume DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function dnsRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      user_name AS userName,
      process_guid AS processGuid,
      process_path AS processPath,
      dns_query AS dnsQuery,
      query_status AS queryStatus
    FROM default.dns_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function registryRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_type AS eventType,
      event_id AS eventId,
      user_name AS userName,
      process_path AS processPath,
      target_object AS targetObject,
      left(message, 300) AS message
    FROM default.registry_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function fileRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_type AS eventType,
      event_id AS eventId,
      user_name AS userName,
      process_path AS processPath,
      target_filename AS targetFilename,
      hashes,
      left(message, 300) AS message
    FROM default.file_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function processAccessRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_id AS eventId,
      user_name AS userName,
      process_path AS processPath,
      target_image AS targetImage,
      granted_access AS grantedAccess,
      call_trace AS callTrace,
      left(message, 300) AS message
    FROM default.process_access_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function powershellVolume(ctx, res) {
  const where = timeWhere(ctx.url);
  const bucket = bucketFunction(ctx.url.searchParams.get("bucket") || "minute");
  const rows = await queryRows(`
    SELECT ${bucket}(kafka_timestamp) AS time, count() AS events
    FROM default.powershell_events
    ${where.sql}
    GROUP BY time
    ORDER BY time ASC
  `);
  sendJson(res, 200, { items: rows });
}

async function powershellRecent(ctx, res) {
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      event_id AS eventId,
      level,
      user_name AS userName,
      left(command_line, 800) AS commandLine,
      left(script_block_text, 1200) AS scriptBlockText,
      left(message, 300) AS message
    FROM default.powershell_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function registrationsSummary(_ctx, res) {
  const started = Date.now();
  try {
    const devices = await registrationRequest("/api/v1/admin/devices");
    const rows = Array.isArray(devices) ? devices : [];
    const byStatus = new Map();
    for (const device of rows) {
      const status = String(device.status || "Unknown");
      byStatus.set(status, (byStatus.get(status) || 0) + 1);
    }

    const latest = [...rows]
      .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))
      .slice(0, 100)
      .map(mapRegistrationDevice);

    sendJson(res, 200, {
      status: "ok",
      latencyMs: Date.now() - started,
      totals: {
        devices: rows.length,
        pending: byStatus.get("Pending") || 0,
        active: byStatus.get("Active") || 0,
        revoked: byStatus.get("Revoked") || 0,
        expired: byStatus.get("Expired") || 0,
        quarantined: byStatus.get("Quarantined") || 0,
      },
      groups: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
      items: latest,
    });
  } catch (cause) {
    sendJson(res, 200, {
      status: "offline",
      message: cause.message || "Registration service is not reachable",
      totals: { devices: 0, pending: 0, active: 0, revoked: 0, expired: 0, quarantined: 0 },
      groups: [],
      items: [],
    });
  }
}

function mapRegistrationDevice(device) {
  return {
    deviceRecordId: device.deviceRecordId || "",
    agentId: device.agentId || "",
    hostId: device.hostId || "",
    staffId: device.staffId || "",
    deviceId: device.deviceId || "",
    owner: device.owner || "",
    expectedHostname: device.expectedHostname || "",
    actualHostname: device.actualHostname || "",
    policyId: device.policyId || "",
    agentVersion: device.agentVersion || "",
    status: device.status || "Unknown",
    certificateThumbprint: device.certificateThumbprint || "",
    certificateNotAfter: device.certificateNotAfter || null,
    createdAt: device.createdAt || null,
    updatedAt: device.updatedAt || null,
    enrolledAt: device.enrolledAt || null,
    tokenExpiresAt: device.enrollmentTokenExpiresAt || null,
  };
}

async function dynamicConfigSummary(_ctx, res) {
  const started = Date.now();
  try {
    const [policies, agents] = await Promise.all([
      dynamicConfigRequest("/api/v1/dynamic-config/policies", { admin: true }),
      dynamicConfigRequest("/api/v1/dynamic-config/agents", { admin: true }),
    ]);
    const policyRows = Array.isArray(policies) ? policies : [];
    const agentRows = Array.isArray(agents) ? agents : [];
    const activePolicies = policyRows.filter((policy) => policy.enabled !== false).length;
    const groups = countBy(agentRows, (agent) => agent.group_id || "unknown");
    sendJson(res, 200, {
      status: "ok",
      latencyMs: Date.now() - started,
      totals: {
        policies: policyRows.length,
        activePolicies,
        agents: agentRows.length,
        groups: groups.length,
      },
      groups,
      policies: policyRows,
      agents: agentRows,
    });
  } catch (cause) {
    sendJson(res, 200, {
      status: "offline",
      message: cause.message || "Dynamic Config service is not reachable",
      totals: { policies: 0, activePolicies: 0, agents: 0, groups: 0 },
      groups: [],
      policies: [],
      agents: [],
    });
  }
}

async function dynamicConfigPolicies(_ctx, res) {
  const policies = await dynamicConfigRequest("/api/v1/dynamic-config/policies", { admin: true });
  sendJson(res, 200, { items: Array.isArray(policies) ? policies : [] });
}

async function dynamicConfigAgents(_ctx, res) {
  const agents = await dynamicConfigRequest("/api/v1/dynamic-config/agents", { admin: true });
  sendJson(res, 200, { items: Array.isArray(agents) ? agents : [] });
}

async function dynamicConfigAudit(_ctx, res) {
  const audit = await dynamicConfigRequest("/api/v1/dynamic-config/audit", { admin: true });
  sendJson(res, 200, { items: Array.isArray(audit) ? audit : [] });
}

async function dynamicConfigCatalog(_ctx, res) {
  sendJson(res, 200, {
    items: DYNAMIC_LOG_TYPES.map((item) => ({ ...item })),
    defaults: ["windows-application", "windows-system", "windows-security", "sysmon", "powershell", "wmi"],
    fields: DYNAMIC_LOG_FIELDS.map((item) => ({ ...item })),
    fieldDefaults: DYNAMIC_LOG_FIELDS.map((item) => item.id),
    retainedInternalFields: ["agent_id", "host_id", "raw_log", "idempotency_key"],
  });
}

async function dynamicConfigPreview(ctx, res) {
  const body = await readJsonBody(ctx.req);
  const policy = buildDynamicPolicy({ ...body, draft: true });
  const selectedTypeIds = Array.isArray(body.logTypes)
    ? [...new Set(body.logTypes.map((item) => String(item || "").trim().toLowerCase()))]
    : [];
  const selectedLogTypes = DYNAMIC_LOG_TYPES
    .filter((item) => selectedTypeIds.includes(item.id))
    .map((item) => ({ id: item.id, name: item.name }));
  const selectedFields = policy.config.vector.selected_fields.map((field) => {
    const catalogField = DYNAMIC_LOG_FIELDS.find((item) => item.field === field);
    return {
      id: catalogField?.id || field,
      field,
      name: catalogField?.name || field,
      required: catalogField?.required === true,
    };
  });

  sendJson(res, 200, {
    previewOnly: true,
    summary: {
      name: policy.name,
      state: "disabled draft",
      target: policy.target,
      logTypes: selectedLogTypes,
      channels: policy.config.vector.channels,
      selectedFields,
      retainedInternalFields: ["agent_id", "host_id", "raw_log", "idempotency_key"],
      sensors: policy.config.sensors,
      rollout: policy.rollout,
    },
    policy,
  });
}

async function dynamicConfigUpsertPolicy(ctx, res) {
  const body = await readJsonBody(ctx.req);
  const policy = buildDynamicPolicy(body);
  const saved = await dynamicConfigRequest("/api/v1/dynamic-config/policies", {
    method: "POST",
    admin: true,
    body: policy,
  });
  sendJson(res, 200, saved);
}

function buildDynamicPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) badRequest("policy body must be a JSON object");
  const targetType = String(input.targetType || "default").trim().toLowerCase();
  if (!["default", "group", "agent"].includes(targetType)) {
    badRequest("targetType must be one of: default, group, agent");
  }
  const targetValue = optionalPolicyText(input.targetValue, "targetValue", 255);
  if ((targetType === "group" || targetType === "agent") && !targetValue) {
    badRequest("targetValue is required for group/agent policy");
  }

  const draft = input.draft === true;
  const policyId = optionalPolicyText(input.policyId, "policyId", 160)
    || `policy-${draft ? "draft" : targetType}-${targetValue || "default"}-${Date.now()}`;
  const requestedName = optionalPolicyText(input.name, "name", 200);
  if (draft && !requestedName) badRequest("name is required for a Dynamic Logs draft");
  const name = requestedName || policyId;
  const version = boundedPolicyInteger(input.version, "version", 1, Number.MAX_SAFE_INTEGER, 1);
  const target = targetType === "group"
    ? { type: "group", group_id: targetValue }
    : targetType === "agent"
      ? { type: "agent", agent_id: targetValue }
      : { type: "default" };

  const selection = dynamicLogSelection(input);
  const selectedFields = dynamicFieldSelection(input);
  return {
    policy_id: policyId,
    version,
    name,
    enabled: draft ? false : input.enabled !== false,
    target,
    rollout: {
      enabled: draft ? false : input.rolloutEnabled !== false,
      percent: clampNumber(input.rolloutPercent, 1, 100, 100),
      min_agent_version: String(input.minAgentVersion || "0.1.0"),
    },
    config: {
      config_schema_version: 1,
      vector: {
        enabled: input.vectorEnabled !== false,
        channels: selection.channels,
        selected_fields: selectedFields,
        batch_max_events: clampNumber(input.batchMaxEvents, 1, 50000, 1000),
        batch_timeout_secs: clampNumber(input.batchTimeoutSecs, 1, 3600, 10),
      },
      shipper: {
        enabled: input.shipperEnabled !== false,
        gateway_url: String(input.gatewayUrl || "https://hosteye.iahn.hanoi.vn/api/v1/telemetry"),
        normal_jitter_window_seconds: clampNumber(input.normalJitterWindowSeconds, 0, 86400, 300),
        recovery_jitter_window_seconds: clampNumber(input.recoveryJitterWindowSeconds, 0, 86400, 1800),
        base_backoff_seconds: clampNumber(input.baseBackoffSeconds, 1, 3600, 2),
        max_backoff_seconds: clampNumber(input.maxBackoffSeconds, 1, 86400, 300),
        max_spool_size_mb: clampNumber(input.maxSpoolSizeMb, 1, 102400, 8192),
      },
      sensors: {
        sysmon_enabled: selection.sensors.has("sysmon"),
        powershell_enabled: selection.sensors.has("powershell"),
        network_events_enabled: selection.sensors.has("network"),
      },
    },
    updated_at: new Date().toISOString(),
  };
}

function dynamicFieldSelection(input) {
  if (!Object.hasOwn(input, "selectedFields")) {
    return DYNAMIC_LOG_FIELDS.map((item) => item.field);
  }
  if (!Array.isArray(input.selectedFields)) {
    badRequest("selectedFields must be an array of supported field identifiers");
  }
  if (!input.selectedFields.length) {
    badRequest("selectedFields must contain at least one supported field");
  }

  const ids = [];
  for (const raw of input.selectedFields) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id) badRequest("selectedFields must not contain empty identifiers");
    if (ids.includes(id)) badRequest(`selectedFields must not contain duplicates: ${id}`);
    if (!DYNAMIC_LOG_FIELDS.some((item) => item.id === id)) {
      badRequest(`unsupported selected field: ${id}`);
    }
    ids.push(id);
  }

  const missingRequired = DYNAMIC_LOG_FIELDS
    .filter((item) => item.required && !ids.includes(item.id))
    .map((item) => item.id);
  if (missingRequired.length) {
    badRequest(`selectedFields must include required fields: ${missingRequired.join(", ")}`);
  }
  return ids.map((id) => DYNAMIC_LOG_FIELDS.find((item) => item.id === id).field);
}

function dynamicLogSelection(input) {
  if (Object.hasOwn(input, "logTypes") && !Array.isArray(input.logTypes)) {
    badRequest("logTypes must be an array of supported log type identifiers");
  }
  if (Array.isArray(input.logTypes)) {
    if (!input.logTypes.length) badRequest("logTypes must contain at least one supported log type");
    const ids = [];
    for (const raw of input.logTypes) {
      const id = String(raw || "").trim().toLowerCase();
      if (!id || ids.includes(id)) continue;
      if (!DYNAMIC_LOG_TYPES.some((item) => item.id === id)) {
        badRequest(`unsupported log type: ${id || "empty"}`);
      }
      ids.push(id);
    }
    if (!ids.length) badRequest("logTypes must contain at least one supported log type");
    const selected = DYNAMIC_LOG_TYPES.filter((item) => ids.includes(item.id));
    return {
      channels: [...new Set(selected.flatMap((item) => item.channels))],
      sensors: new Set(selected.flatMap((item) => item.sensors || [])),
    };
  }

  const channels = String(input.channels || "Application,System,Security,Microsoft-Windows-Sysmon/Operational,Microsoft-Windows-PowerShell/Operational,Microsoft-Windows-WMI-Activity/Operational")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!channels.length) badRequest("channels must contain at least one Windows Event Log channel");
  return {
    channels: [...new Set(channels)],
    sensors: new Set([
      ...(input.sysmonEnabled !== false ? ["sysmon"] : []),
      ...(input.powershellEnabled !== false ? ["powershell"] : []),
      ...(input.networkEventsEnabled !== false ? ["network"] : []),
    ]),
  };
}

function optionalPolicyText(value, name, maxLength) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  const text = String(value).trim();
  if (text.length > maxLength) badRequest(`${name} must be at most ${maxLength} characters`);
  return text;
}

function boundedPolicyInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) badRequest(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    badRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

async function dynamicConfigRequest(path, options = {}) {
  const base = config.dynamicConfigUrl.replace(/\/$/, "");
  const headers = { "content-type": "application/json" };
  if (options.admin) headers["x-hosteye-admin-token"] = config.dynamicConfigAdminToken;

  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    const error = new Error(`Dynamic Config service is not reachable: ${cause?.message || cause}`);
    error.statusCode = 503;
    throw error;
  }

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Dynamic Config service returned ${response.status}`);
    error.statusCode = response.status;
    error.detail = text;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries()).map(([key, count]) => ({ key, count }));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
async function registrationRequest(path) {
  const base = config.registrationUrl.replace(/\/$/, "");
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: { "x-hosteye-admin-token": config.registrationAdminToken },
    });
  } catch (cause) {
    const error = new Error(`Registration service is not reachable: ${cause?.message || cause}`);
    error.statusCode = 503;
    throw error;
  }

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`Registration service returned ${response.status}`);
    error.statusCode = response.status;
    error.detail = text;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}
async function hostsHeatmap(ctx, res) {
  const top = limitParam(ctx.url, 10, 25, "top");
  const bucket = bucketFunction(ctx.url.searchParams.get("bucket") || "minute");
  const where = timeWhere(ctx.url);

  const hosts = await queryRows(`
    SELECT computer, count() AS totalEvents
    FROM default.windows_system_logs
    ${where.sql}
    GROUP BY computer
    ORDER BY totalEvents DESC
    LIMIT ${top}
  `);

  const hostNames = hosts.map((row) => row.computer).filter(Boolean);
  if (hostNames.length === 0) {
    sendJson(res, 200, { hosts: [], cells: [] });
    return;
  }

  const hostFilter = `computer IN (${hostNames.map(sqlString).join(", ")})`;
  const cellWhere = timeWhere(ctx.url, [hostFilter]);
  const cells = await queryRows(`
    SELECT
      computer,
      ${bucket}(kafka_timestamp) AS bucketTime,
      count() AS events
    FROM default.windows_system_logs
    ${cellWhere.sql}
    GROUP BY computer, bucketTime
    ORDER BY computer, bucketTime
  `);

  const maxEvents = Math.max(1, ...cells.map((cell) => Number(cell.events || 0)));
  const mappedHosts = hosts.map((host, index) => ({
    rank: index + 1,
    alias: `C${index + 1}`,
    computer: host.computer,
    totalEvents: Number(host.totalEvents || 0),
  }));
  const aliasByHost = new Map(mappedHosts.map((host) => [host.computer, host.alias]));

  sendJson(res, 200, {
    hosts: mappedHosts,
    cells: cells.map((cell) => ({
      alias: aliasByHost.get(cell.computer),
      computer: cell.computer,
      bucketTime: cell.bucketTime,
      events: Number(cell.events || 0),
      level: heatLevel(Number(cell.events || 0), maxEvents),
    })),
  });
}

async function hostsHeatmapCell(ctx, res) {
  const host = requiredString(ctx.url, "host");
  const time = requiredTimeString(ctx.url, "time");
  const bucket = ctx.url.searchParams.get("bucket") || "minute";
  const interval = bucketInterval(bucket);
  const startExpr = `parseDateTime64BestEffort(${sqlString(time)}, 3)`;
  const endExpr = `${startExpr} + INTERVAL 1 ${interval}`;
  const predicates = [
    `computer = ${sqlString(host)}`,
    `kafka_timestamp >= ${startExpr}`,
    `kafka_timestamp < ${endExpr}`,
  ];
  const where = `WHERE ${predicates.join(" AND ")}`;
  const limit = limitParam(ctx.url, 200, 500);

  const [summaryRows, byChannel, byEventId, byEventType, recentLogs] = await Promise.all([
    queryRows(`SELECT count() AS totalEvents FROM default.windows_system_logs ${where}`),
    queryRows(`
      SELECT channel, count() AS events
      FROM default.windows_system_logs
      ${where}
      GROUP BY channel
      ORDER BY events DESC
      LIMIT 20
    `),
    queryRows(`
      SELECT event_id AS eventId, count() AS events
      FROM default.windows_system_logs
      ${where}
      GROUP BY eventId
      ORDER BY events DESC
      LIMIT 20
    `),
    queryRows(`
      SELECT ${eventTypeExpression()} AS eventType, count() AS events
      FROM default.windows_system_logs
      ${where}
      GROUP BY eventType
      ORDER BY events DESC
      LIMIT 20
    `),
    queryRows(`
      SELECT
        kafka_timestamp AS time,
        computer,
        channel,
        event_id AS eventId,
        ${eventTypeExpression()} AS eventType,
        user_name AS userName,
        process_path AS processPath,
        left(command_line, 800) AS commandLine,
        source_ip AS sourceIp,
        destination_ip AS destinationIp,
        dns_query AS dnsQuery,
        target_filename AS targetFilename,
        target_object AS targetObject,
        left(message, 500) AS message
      FROM default.windows_system_logs
      ${where}
      ORDER BY kafka_timestamp DESC
      LIMIT ${limit}
    `),
  ]);

  sendJson(res, 200, {
    computer: host,
    bucketStart: time,
    bucketEndExpression: `${time} + 1 ${interval.toLowerCase()}`,
    totalEvents: Number(summaryRows[0]?.totalEvents || 0),
    breakdown: {
      byChannel,
      byEventId,
      byEventType,
    },
    recentLogs,
  });
}

async function alertsList(ctx, res) {
  const limit = limitParam(ctx.url, 100, 500);
  const offset = offsetParam(ctx.url, 100000);
  const fetchLimit = Math.min(limit + offset, 5000);
  const filters = alertListFilters(ctx.url);
  const eventPredicates = [`(${eventAlertPredicate()})`];
  const failedPredicates = ["channel = 'Security'", "event_id = 4625"];
  if (filters.severity) eventPredicates.push(`(${eventAlertSeverityExpr()}) = ${sqlString(filters.severity)}`);
  if (filters.status && filters.status !== "new") {
    eventPredicates.push("0");
    failedPredicates.push("0");
  }
  if (filters.q) {
    eventPredicates.push(alertEventKeywordPredicate(filters.q));
    failedPredicates.push(alertFailedLogonKeywordPredicate(filters.q));
  }
  const failedSeverityHaving = alertFailedLogonSeverityHaving(filters.severity);
  const eventWhere = alertTimeWhere(ctx.url, eventPredicates);
  const failedWhere = alertTimeWhere(ctx.url, failedPredicates);

  const [eventRows, eventSummaryRows, failedRows, failedSummaryRows] = await Promise.all([
    queryRows(`
      SELECT
        concat('event:', idempotency_key) AS alertId,
        kafka_timestamp AS detectedAt,
        ${eventAlertSeverityExpr()} AS severity,
        ${eventAlertRuleExpr()} AS ruleId,
        ${eventAlertTitleExpr()} AS title,
        'new' AS status,
        computer,
        agent_id AS agentId,
        host_id AS hostId,
        channel,
        event_id AS eventId,
        user_name AS userName,
        source_ip AS sourceIp,
        process_path AS processPath,
        left(message, 500) AS message,
        1 AS evidenceCount,
        idempotency_key AS idempotencyKey
      FROM default.windows_system_logs
      ${eventWhere.sql}
      ORDER BY detectedAt DESC
      LIMIT ${fetchLimit}
    `),
    queryRows(`
      SELECT ${eventAlertSeverityExpr()} AS severity, count() AS total
      FROM default.windows_system_logs
      ${eventWhere.sql}
      GROUP BY severity
    `),
    queryRows(`
      SELECT
        concat(
          'HE-AUTH-001:',
          hex(cityHash64(concat(computer, '|', toString(windowStart), '|', user_name, '|', source_ip)))
        ) AS alertId,
        max(kafka_timestamp) AS detectedAt,
        if(count() >= 20, 'high', 'medium') AS severity,
        'HE-AUTH-001' AS ruleId,
        'Repeated failed logons' AS title,
        'new' AS status,
        computer,
        anyLast(agent_id) AS agentId,
        anyLast(host_id) AS hostId,
        'Security' AS channel,
        4625 AS eventId,
        user_name AS userName,
        source_ip AS sourceIp,
        '' AS processPath,
        concat(toString(count()), ' failed logons within 5 minutes') AS message,
        count() AS evidenceCount,
        '' AS idempotencyKey
      FROM
      (
        SELECT *, toStartOfFiveMinutes(kafka_timestamp) AS windowStart
        FROM default.windows_system_logs
        ${failedWhere.sql}
      )
      GROUP BY windowStart, computer, user_name, source_ip
      HAVING evidenceCount >= 5${failedSeverityHaving}
      ORDER BY detectedAt DESC
      LIMIT ${fetchLimit}
    `),
    queryRows(`
      SELECT severity, count() AS total
      FROM
      (
        SELECT if(count() >= 20, 'high', 'medium') AS severity
        FROM
        (
          SELECT *, toStartOfFiveMinutes(kafka_timestamp) AS windowStart
          FROM default.windows_system_logs
          ${failedWhere.sql}
        )
        GROUP BY windowStart, computer, user_name, source_ip
        HAVING count() >= 5${failedSeverityHaving}
      )
      GROUP BY severity
    `),
  ]);

  const summary = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of [...eventSummaryRows, ...failedSummaryRows]) {
    const severity = String(row.severity || "low").toLowerCase();
    const count = Number(row.total || 0);
    if (Object.hasOwn(summary, severity)) summary[severity] += count;
    summary.total += count;
  }

  const items = [...eventRows, ...failedRows]
    .map((row) => ({
      ...row,
      eventId: Number(row.eventId || 0),
      evidenceCount: Number(row.evidenceCount || 0),
    }))
    .sort((left, right) => dateValue(right.detectedAt) - dateValue(left.detectedAt))
    .slice(offset, offset + limit);

  sendJson(res, 200, {
    items,
    summary,
    total: summary.total,
    limit,
    offset,
    hasMore: offset + items.length < summary.total,
    filters: {
      q: filters.q || "",
      severity: filters.severity || "",
      status: filters.status || "",
      host: filters.host || "",
      from: eventWhere.from.toISOString(),
      to: eventWhere.to.toISOString(),
    },
  });
}


async function alertDetail(ctx, res) {
  let alertId;
  try { alertId = decodeURIComponent(ctx.params[0] || ""); }
  catch { badRequest("alertId must be URL encoded"); }
  if (!alertId || alertId.length > 512) badRequest("alertId is invalid");
  const limit = limitParam(ctx.url, 50, 200);

  if (alertId.startsWith("event:")) {
    const key = alertId.slice(6);
    const rows = await queryRows(`
      SELECT concat('event:', idempotency_key) AS alertId, kafka_timestamp AS detectedAt,
        ${eventAlertSeverityExpr()} AS severity, ${eventAlertRuleExpr()} AS ruleId,
        ${eventAlertTitleExpr()} AS title, 'new' AS status,
        computer, agent_id AS agentId, host_id AS hostId, channel, event_id AS eventId,
        provider_name AS providerName, level, user_name AS userName, user_id AS userId,
        source_ip AS sourceIp, destination_ip AS destinationIp, process_path AS processPath,
        left(command_line, 2000) AS commandLine, left(script_block_text, 4000) AS scriptBlockText,
        hashes, left(message, 2000) AS message, left(raw_log, 4000) AS rawLog,
        left(event_data_json, 4000) AS eventDataJson, 1 AS evidenceCount,
        idempotency_key AS idempotencyKey
      FROM default.windows_system_logs
      WHERE idempotency_key = ${sqlString(key)} AND (${eventAlertPredicate()})
      ORDER BY kafka_timestamp DESC LIMIT 1
    `);
    if (!rows.length) return sendJson(res, 404, { message: "Alert not found" });
    const alert = normalizeAlertDetail(rows[0]);
    const evidence = await queryRows(`
      SELECT if(idempotency_key = ${sqlString(key)}, 'primary', 'context') AS relation,
        kafka_timestamp AS time, idempotency_key AS idempotencyKey, computer,
        agent_id AS agentId, host_id AS hostId, channel, event_id AS eventId,
        provider_name AS providerName, level, user_name AS userName, source_ip AS sourceIp,
        destination_ip AS destinationIp, process_path AS processPath,
        left(command_line, 1200) AS commandLine, left(message, 1200) AS message,
        left(raw_log, 3000) AS rawLog
      FROM default.windows_system_logs
      WHERE computer = ${sqlString(alert.computer)}
        AND kafka_timestamp >= ${sqlClickHouseDate(alert.detectedAt)} - INTERVAL 5 MINUTE
        AND kafka_timestamp <= ${sqlClickHouseDate(alert.detectedAt)} + INTERVAL 5 MINUTE
      ORDER BY relation = 'primary' DESC,
        abs(dateDiff('millisecond', kafka_timestamp, ${sqlClickHouseDate(alert.detectedAt)})) ASC
      LIMIT ${limit}
    `);
    return sendJson(res, 200, { alert, evidence: evidence.map(normalizeAlertEvidence),
      evidenceTotal: evidence.length, context: { type: "event", windowMinutes: 5 } });
  }

  if (alertId.startsWith("HE-AUTH-001:")) {
    const where = alertTimeWhere(ctx.url, ["channel = 'Security'", "event_id = 4625"]);
    const rows = await queryRows(`
      SELECT * FROM (
        SELECT concat('HE-AUTH-001:', hex(cityHash64(concat(computer, '|', toString(windowStart),
          '|', user_name, '|', source_ip)))) AS alertId,
          windowStart, windowStart + INTERVAL 5 MINUTE AS windowEnd,
          min(kafka_timestamp) AS firstSeen, max(kafka_timestamp) AS detectedAt,
          if(count() >= 20, 'high', 'medium') AS severity, 'HE-AUTH-001' AS ruleId,
          'Repeated failed logons' AS title, 'new' AS status, computer,
          anyLast(agent_id) AS agentId, anyLast(host_id) AS hostId, 'Security' AS channel,
          4625 AS eventId, anyLast(provider_name) AS providerName, anyLast(level) AS level,
          user_name AS userName, anyLast(user_id) AS userId, source_ip AS sourceIp,
          concat(toString(count()), ' failed logons within 5 minutes') AS message,
          count() AS evidenceCount, '' AS idempotencyKey
        FROM (SELECT *, toStartOfFiveMinutes(kafka_timestamp) AS windowStart
          FROM default.windows_system_logs ${where.sql})
        GROUP BY windowStart, computer, user_name, source_ip HAVING evidenceCount >= 5
      ) WHERE alertId = ${sqlString(alertId)} LIMIT 1
    `);
    if (!rows.length) return sendJson(res, 404, { message: "Alert not found" });
    const alert = normalizeAlertDetail(rows[0]);
    const evidence = await queryRows(`
      SELECT 'evidence' AS relation, kafka_timestamp AS time, idempotency_key AS idempotencyKey,
        computer, agent_id AS agentId, host_id AS hostId, channel, event_id AS eventId,
        provider_name AS providerName, level, user_name AS userName, source_ip AS sourceIp,
        destination_ip AS destinationIp, process_path AS processPath,
        left(command_line, 1200) AS commandLine, left(message, 1200) AS message,
        left(raw_log, 3000) AS rawLog
      FROM default.windows_system_logs WHERE channel = 'Security' AND event_id = 4625
        AND computer = ${sqlString(alert.computer)} AND user_name = ${sqlString(alert.userName)}
        AND source_ip = ${sqlString(alert.sourceIp)}
        AND kafka_timestamp >= ${sqlClickHouseDate(alert.windowStart)}
        AND kafka_timestamp < ${sqlClickHouseDate(alert.windowEnd)}
      ORDER BY kafka_timestamp ASC LIMIT ${limit}
    `);
    return sendJson(res, 200, { alert, evidence: evidence.map(normalizeAlertEvidence),
      evidenceTotal: Number(alert.evidenceCount || evidence.length),
      context: { type: "failed-logon-window", windowMinutes: 5 } });
  }
  sendJson(res, 404, { message: "Alert not found" });
}

function normalizeAlertDetail(row) {
  return { ...row, eventId: Number(row.eventId || 0), evidenceCount: Number(row.evidenceCount || 0) };
}
function normalizeAlertEvidence(row) {
  return { ...row, eventId: Number(row.eventId || 0) };
}

function eventAlertPredicate() {
  return `
    (channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id IN (8, 25))
    OR (channel = 'Security' AND event_id IN (4720, 4726))
    OR (
      channel = 'Microsoft-Windows-PowerShell/Operational'
      AND event_id = 4104
      AND (
        positionCaseInsensitive(script_block_text, 'encodedcommand') > 0
        OR positionCaseInsensitive(script_block_text, 'downloadstring') > 0
        OR positionCaseInsensitive(script_block_text, 'invoke-expression') > 0
        OR positionCaseInsensitive(script_block_text, 'frombase64string') > 0
      )
    )
    OR (
      positionCaseInsensitive(channel, 'Defender') > 0
      AND level IN ('Critical', 'Error', 'Warning')
    )
  `;
}

function eventAlertSeverityExpr() {
  return `
    multiIf(
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 25, 'critical',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 8, 'high',
      channel = 'Security' AND event_id = 4726, 'high',
      channel = 'Security' AND event_id = 4720, 'medium',
      channel = 'Microsoft-Windows-PowerShell/Operational' AND event_id = 4104, 'high',
      level = 'Critical', 'critical',
      level = 'Error', 'high',
      'medium'
    )
  `;
}

function eventAlertRuleExpr() {
  return `
    multiIf(
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 25, 'HE-PROC-001',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 8, 'HE-PROC-002',
      channel = 'Security' AND event_id = 4720, 'HE-ID-001',
      channel = 'Security' AND event_id = 4726, 'HE-ID-002',
      channel = 'Microsoft-Windows-PowerShell/Operational' AND event_id = 4104, 'HE-PS-001',
      'HE-DEF-001'
    )
  `;
}

function eventAlertTitleExpr() {
  return `
    multiIf(
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 25, 'Process tampering detected',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 8, 'Remote thread creation detected',
      channel = 'Security' AND event_id = 4720, 'User account created',
      channel = 'Security' AND event_id = 4726, 'User account deleted',
      channel = 'Microsoft-Windows-PowerShell/Operational' AND event_id = 4104, 'Suspicious PowerShell content',
      'Microsoft Defender detection'
    )
  `;
}


function alertListFilters(url) {
  return {
    q: optionalString(url, "q", 200),
    host: optionalString(url, "host", 255),
    severity: optionalEnum(url, "severity", ["critical", "high", "medium", "low"]),
    status: optionalEnum(url, "status", ["new", "acknowledged", "resolved"]),
  };
}

function alertEventKeywordPredicate(q) {
  const value = sqlString(q);
  return `(
    positionCaseInsensitive(${eventAlertRuleExpr()}, ${value}) > 0
    OR positionCaseInsensitive(${eventAlertTitleExpr()}, ${value}) > 0
    OR positionCaseInsensitive(computer, ${value}) > 0
    OR positionCaseInsensitive(user_name, ${value}) > 0
    OR positionCaseInsensitive(source_ip, ${value}) > 0
    OR positionCaseInsensitive(process_path, ${value}) > 0
    OR positionCaseInsensitive(message, ${value}) > 0
  )`;
}

function alertFailedLogonKeywordPredicate(q) {
  return `positionCaseInsensitive(concat(
    computer, ' ', user_name, ' ', source_ip,
    ' HE-AUTH-001 Repeated failed logons failed logons within 5 minutes'
  ), ${sqlString(q)}) > 0`;
}

function alertFailedLogonSeverityHaving(severity) {
  if (severity === "high") return " AND count() >= 20";
  if (severity === "medium") return " AND count() < 20";
  if (severity === "critical" || severity === "low") return " AND 0";
  return "";
}

async function logsSearch(ctx, res) {
  const q = optionalString(ctx.url, "q", 200);
  const keywordPredicate = q ? [`(
    positionCaseInsensitive(message, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(command_line, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(process_path, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(raw_log, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(user_name, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(dns_query, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(target_filename, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(target_object, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(source_ip, ${sqlString(q)}) > 0
    OR positionCaseInsensitive(destination_ip, ${sqlString(q)}) > 0
  )`] : [];
  const where = timeWhere(ctx.url, keywordPredicate);
  const limit = limitParam(ctx.url, 100, 500);
  const offset = offsetParam(ctx.url, 100000);

  const [countRows, rows] = await Promise.all([
    queryRows(`
      SELECT count() AS total
      FROM default.windows_system_logs
      ${where.sql}
    `),
    queryRows(`
      SELECT
        kafka_timestamp AS time,
        computer,
        channel,
        event_id AS eventId,
        level,
        provider_name AS providerName,
        user_name AS userName,
        process_path AS processPath,
        left(command_line, 800) AS commandLine,
        source_ip AS sourceIp,
        destination_ip AS destinationIp,
        dns_query AS dnsQuery,
        target_filename AS targetFilename,
        target_object AS targetObject,
        left(message, 500) AS message,
        idempotency_key AS idempotencyKey
      FROM default.windows_system_logs
      ${where.sql}
      ORDER BY kafka_timestamp DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `),
  ]);

  const total = Number(countRows[0]?.total || 0);
  sendJson(res, 200, {
    items: rows,
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    filters: {
      q: q || "",
      host: ctx.url.searchParams.get("host") || "",
      channel: ctx.url.searchParams.get("channel") || "",
      eventId: ctx.url.searchParams.get("eventId") || "",
      from: where.from.toISOString(),
      to: where.to.toISOString(),
    },
  });
}

async function logsRaw(ctx, res) {
  const key = decodeURIComponent(ctx.params[0] || "");
  const rows = await queryRows(`
    SELECT *
    FROM default.windows_system_logs
    WHERE idempotency_key = ${sqlString(key)}
    ORDER BY kafka_timestamp DESC
    LIMIT 1
  `);
  if (rows.length === 0) {
    sendJson(res, 404, { message: "Log not found" });
    return;
  }
  sendJson(res, 200, rows[0]);
}

async function queryRows(sql) {
  const body = `${sql.trim().replace(/;$/, "")} FORMAT JSONEachRow`;
  const headers = {
    "content-type": "text/plain; charset=utf-8",
  };

  if (config.username || config.password) {
    headers.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }

  let response;
  try {
    response = await fetch(config.clickhouseUrl, {
      method: "POST",
      headers,
      body,
    });
  } catch (cause) {
    const error = new Error("ClickHouse is not reachable");
    error.statusCode = 503;
    error.detail = `${config.clickhouseUrl} - ${cause?.message || cause}`;
    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    const error = new Error("ClickHouse query failed");
    error.statusCode = 502;
    error.detail = text;
    throw error;
  }

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function timeWhere(url, extraPredicates = []) {
  const from = dateParam(url, "from", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = dateParam(url, "to", new Date());
  if (from > to) badRequest("from must be earlier than or equal to to");
  const host = url.searchParams.get("host");
  const channel = url.searchParams.get("channel");
  const eventId = url.searchParams.get("eventId");
  const predicates = [
    `kafka_timestamp >= ${sqlDate(from)}`,
    `kafka_timestamp <= ${sqlDate(to)}`,
    ...extraPredicates,
  ];

  if (host) predicates.push(`computer = ${sqlString(host)}`);
  if (channel) predicates.push(`channel = ${sqlString(channel)}`);
  if (eventId) predicates.push(`event_id = ${uintParam(eventId, "eventId")}`);

  return { sql: `WHERE ${predicates.join(" AND ")}`, from, to };
}

function eventTypeExpression() {
  return `
    multiIf(
      channel = 'Security' AND event_id = 4624, 'Security: Successful Logon',
      channel = 'Security' AND event_id = 4625, 'Security: Failed Logon',
      channel = 'Security' AND event_id = 4634, 'Security: Logoff',
      channel = 'Security' AND event_id = 4648, 'Security: Explicit Credentials Logon',
      channel = 'Security' AND event_id = 4672, 'Security: Special Privileges Assigned',
      channel = 'Security' AND event_id = 4688, 'Security: Process Created',
      channel = 'Security' AND event_id = 4689, 'Security: Process Exited',
      channel = 'Security' AND event_id = 4720, 'Security: User Created',
      channel = 'Security' AND event_id = 4726, 'Security: User Deleted',
      channel = 'Security' AND event_id = 4732, 'Security: User Added To Group',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 1, 'Sysmon: Process Create',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 3, 'Sysmon: Network Connection',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 5, 'Sysmon: Process Terminated',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 7, 'Sysmon: Image Loaded',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 8, 'Sysmon: CreateRemoteThread',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 10, 'Sysmon: Process Access',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 11, 'Sysmon: File Create',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 12, 'Sysmon: Registry Object Created/Deleted',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 13, 'Sysmon: Registry Value Set',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 14, 'Sysmon: Registry Key/Value Renamed',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 15, 'Sysmon: FileCreateStreamHash',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 22, 'Sysmon: DNS Query',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 23, 'Sysmon: File Delete',
      channel = 'Microsoft-Windows-Sysmon/Operational' AND event_id = 25, 'Sysmon: Process Tampering',
      channel = 'Microsoft-Windows-PowerShell/Operational' AND event_id = 4104, 'PowerShell: Script Block',
      concat(channel, ': Event ', toString(event_id))
    )
  `;
}

function bucketFunction(bucket) {
  if (bucket === "hour") return "toStartOfHour";
  if (bucket === "day") return "toStartOfDay";
  if (bucket === "second") return "toStartOfSecond";
  return "toStartOfMinute";
}

function bucketParam(url, fallback = "second") {
  const value = url.searchParams.get("bucket") || fallback;
  if (!["second", "minute", "hour", "day"].includes(value)) {
    badRequest("bucket must be one of: second, minute, hour, day");
  }
  return value;
}

function bucketDurationMs(bucket) {
  if (bucket === "hour") return 60 * 60 * 1000;
  if (bucket === "day") return 24 * 60 * 60 * 1000;
  if (bucket === "second") return 1000;
  return 60 * 1000;
}

function bucketInterval(bucket) {
  if (bucket === "hour") return "HOUR";
  if (bucket === "day") return "DAY";
  if (bucket === "second") return "SECOND";
  return "MINUTE";
}

function heatLevel(value, max) {
  if (value <= 0) return 0;
  const ratio = value / Math.max(1, max);
  if (ratio >= 0.8) return 5;
  if (ratio >= 0.55) return 4;
  if (ratio >= 0.3) return 3;
  if (ratio >= 0.1) return 2;
  return 1;
}

function alertTimeWhere(url, extraPredicates = []) {
  const from = dateParam(url, "from", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = dateParam(url, "to", new Date());
  if (from > to) badRequest("from must be earlier than or equal to to");
  const predicates = [
    `kafka_timestamp >= ${sqlDate(from)}`,
    `kafka_timestamp <= ${sqlDate(to)}`,
    ...extraPredicates,
  ];
  const host = optionalString(url, "host", 255);
  if (host) predicates.push(`computer = ${sqlString(host)}`);
  return { sql: `WHERE ${predicates.join(" AND ")}`, from, to };
}

function operationalTimeWhere(url, timestampColumn, extraPredicates = []) {
  const from = dateParam(url, "from", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = dateParam(url, "to", new Date());
  if (from > to) badRequest("from must be earlier than or equal to to");
  const predicates = [
    `${timestampColumn} >= ${sqlDate(from)}`,
    `${timestampColumn} <= ${sqlDate(to)}`,
    ...extraPredicates,
  ];
  const host = url.searchParams.get("host");
  if (host) predicates.push(`computer = ${sqlString(host)}`);
  return { sql: `WHERE ${predicates.join(" AND ")}`, from, to };
}

function dateValue(value) {
  if (!value) return 0;
  const normalized = String(value).includes("T") ? String(value) : String(value).replace(" ", "T");
  const parsed = new Date(normalized).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function latestDate(...values) {
  let latest = null;
  let latestValue = 0;
  for (const value of values) {
    const timestamp = dateValue(value);
    if (timestamp >= latestValue && timestamp > 0) {
      latest = value;
      latestValue = timestamp;
    }
  }
  return latest;
}

function hostStatus(lastSeen) {
  const timestamp = dateValue(lastSeen);
  if (!timestamp) return { level: "unknown", label: hostLevelLabel("unknown"), ageSeconds: null };
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds <= 5 * 60) return { level: "online", label: hostLevelLabel("online"), ageSeconds };
  if (ageSeconds <= 60 * 60) return { level: "active", label: hostLevelLabel("active"), ageSeconds };
  if (ageSeconds <= 24 * 60 * 60) return { level: "delayed", label: hostLevelLabel("delayed"), ageSeconds };
  return { level: "stale", label: hostLevelLabel("stale"), ageSeconds };
}

function hostLevelLabel(level) {
  if (level === "online") return "Online <= 5m";
  if (level === "active") return "Active <= 1h";
  if (level === "delayed") return "Delayed <= 24h";
  if (level === "stale") return "Stale > 24h";
  return "Unknown";
}

function collectionStatus(row, activityLevel) {
  const lifecycle = `${row.agentStatus || ""} ${row.enrollmentStatus || ""}`.toLowerCase();
  if (/disabled|revoked|decommissioned/.test(lifecycle)) {
    return { level: "disabled", label: collectionLevelLabel("disabled") };
  }

  const ack = String(row.lastAckStatus || "").toLowerCase();
  const statusCode = Number(row.statusCode || 0);
  const uploadFailed = statusCode >= 400
    || (statusCode > 0 && row.success === false)
    || row.dataLoss === true
    || /fail|reject|denied|invalid/.test(ack);
  if (uploadFailed) return { level: "failed", label: collectionLevelLabel("failed") };

  if (Number(row.spoolDepthBytes || 0) >= 1024 * 1024 * 1024 || Number(row.pendingFileCount || 0) >= 20) {
    return { level: "delayed", label: collectionLevelLabel("delayed") };
  }

  const hasCollectionSignal = Boolean(row.lastLogSeen || row.lastMetricSeen || row.lastChunk || Number(row.totalEvents || 0));
  if (!hasCollectionSignal) return { level: "unknown", label: collectionLevelLabel("unknown") };
  if (activityLevel === "stale") return { level: "stale", label: collectionLevelLabel("stale") };
  if (activityLevel === "unknown") return { level: "unknown", label: collectionLevelLabel("unknown") };
  return { level: "ok", label: collectionLevelLabel("ok") };
}

function collectionLevelLabel(level) {
  if (level === "ok") return "Healthy";
  if (level === "delayed") return "Backlogged";
  if (level === "failed") return "Upload failed";
  if (level === "stale") return "No recent activity";
  if (level === "disabled") return "Disabled";
  return "No collection data";
}

function jitterStatus(row) {
  const age = hostStatus(row.lastSeen).ageSeconds;
  if (age === null || age > 30 * 60) return "silent";
  const p95 = Number(row.p95JitterMs || 0);
  const spool = Number(row.spoolDepthBytes || 0);
  const pending = Number(row.pendingFileCount || 0);
  if (spool >= 1024 * 1024 * 1024 || pending >= 20) return "delayed";
  if (p95 >= 45000) return "bursty";
  return "stable";
}

function jitterStatusLabel(level) {
  if (level === "stable") return "Stable";
  if (level === "bursty") return "Bursty";
  if (level === "delayed") return "Delayed";
  return "Silent";
}

function chunkStatus(row) {
  const statusCode = Number(row.statusCode || 0);
  if (statusCode >= 400 || (statusCode > 0 && Number(row.success || 0) !== 1)) return "failed";
  if (Number(row.dataLoss || 0) === 1) return "failed";
  if (Number(row.spoolDepthBytes || 0) >= 1024 * 1024 * 1024 || Number(row.pendingFileCount || 0) >= 20) return "delayed";
  if (!row.lastSeen) return "silent";
  return "ok";
}

function chunkStatusLabel(level) {
  if (level === "ok") return "OK";
  if (level === "failed") return "Failed";
  if (level === "delayed") return "Delayed";
  return "Silent";
}

function dateParam(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (!value) return fallback;
  return parseDate(value, name);
}

function requiredDate(url, name) {
  const value = url.searchParams.get(name);
  if (!value) badRequest(`${name} is required`);
  return parseDate(value, name).toISOString();
}

function requiredTimeString(url, name) {
  const value = url.searchParams.get(name);
  if (!value || !value.trim()) badRequest(`${name} is required`);
  const trimmed = value.trim();
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  if (Number.isNaN(new Date(normalized).getTime())) {
    badRequest(`${name} must be a valid date`);
  }
  return trimmed;
}

function parseDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) badRequest(`${name} must be a valid date`);
  return date;
}

function optionalString(url, name, maxLength) {
  const raw = url.searchParams.get(name);
  if (raw === null || !raw.trim()) return null;
  const value = raw.trim();
  if (value.length > maxLength) badRequest(`${name} must be at most ${maxLength} characters`);
  return value;
}


function optionalEnum(url, name, values) {
  const raw = optionalString(url, name, 64);
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (!values.includes(value)) badRequest(`${name} must be one of: ${values.join(", ")}`);
  return value;
}

function offsetParam(url, max) {
  const raw = url.searchParams.get("offset");
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) badRequest("offset must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    badRequest(`offset must be between 0 and ${max}`);
  }
  return value;
}

function requiredString(url, name) {
  const value = url.searchParams.get(name);
  if (!value || !value.trim()) badRequest(`${name} is required`);
  return value.trim();
}

function limitParam(url, fallback, max, name = "limit") {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) badRequest(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) badRequest(`${name} must be a positive integer`);
  return Math.min(value, max);
}

function uintParam(value, name) {
  if (!/^\d+$/.test(String(value))) badRequest(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) badRequest(`${name} must be a non-negative integer`);
  return parsed;
}

function sqlClickHouseDate(value) {
  return `parseDateTime64BestEffort(${sqlString(value)}, 3)`;
}

function sqlDate(date) {
  const iso = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  return `parseDateTime64BestEffort(${sqlString(iso)}, 3)`;
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}


async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) badRequest("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (_error) {
    badRequest("Request body must be valid JSON");
  }
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, jsonReplacer);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", config.corsOrigin);
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;

  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}







