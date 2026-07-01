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
};

const routes = [
  ["GET", /^\/api\/health$/, health],
  ["GET", /^\/api\/dashboard\/overview\/summary$/, overviewSummary],
  ["GET", /^\/api\/dashboard\/overview\/log-volume$/, overviewLogVolume],
  ["GET", /^\/api\/dashboard\/overview\/top-hosts$/, overviewTopHosts],
  ["GET", /^\/api\/dashboard\/overview\/event-types$/, overviewEventTypes],
  ["GET", /^\/api\/dashboard\/overview\/security-timeline$/, overviewSecurityTimeline],
  ["GET", /^\/api\/dashboard\/hosts\/summary$/, hostsSummary],
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
  ["GET", /^\/api\/dashboard\/jitter\/summary$/, jitterSummary],
  ["GET", /^\/api\/dashboard\/jitter\/hosts$/, jitterHosts],
  ["GET", /^\/api\/dashboard\/chunks\/summary$/, chunksSummary],
  ["GET", /^\/api\/dashboard\/chunks\/hosts$/, chunksHosts],
  ["GET", /^\/api\/dashboard\/hosts\/heatmap$/, hostsHeatmap],
  ["GET", /^\/api\/dashboard\/hosts\/heatmap\/cell$/, hostsHeatmapCell],
  ["GET", /^\/api\/logs\/search$/, logsSearch],
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
    await route[2]({ url, params: match?.slice(1) || [] }, res);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      message: error.message || "Internal server error",
      detail: process.env.NODE_ENV === "production" ? undefined : error.detail,
    });
  }
});

server.listen(config.port, () => {
  console.log(`Vector Dashboard API listening on http://localhost:${config.port}`);
  console.log(`ClickHouse: ${config.clickhouseUrl} database=${config.database}`);
});

async function health(_ctx, res) {
  const rows = await queryRows("SELECT count() AS rows FROM default.windows_system_logs");
  sendJson(res, 200, {
    status: "ok",
    clickhouse: config.clickhouseUrl,
    database: config.database,
    rows: Number(rows[0]?.rows || 0),
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
  sendJson(res, 200, rows[0] || {});
}

async function overviewLogVolume(ctx, res) {
  const where = timeWhere(ctx.url);
  const bucket = bucketFunction(ctx.url.searchParams.get("bucket") || "second");
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
  const rows = await queryRows(`
    SELECT
      computer,
      count() AS totalEvents,
      min(kafka_timestamp) AS firstSeen,
      max(kafka_timestamp) AS lastSeen,
      uniqExact(channel) AS channels,
      uniqExact(event_id) AS eventIds
    FROM default.windows_system_logs
    WHERE computer != ''
    GROUP BY computer
    ORDER BY lastSeen DESC
    LIMIT ${limit}
  `);

  const hosts = rows.map((row) => {
    const status = hostStatus(row.lastSeen);
    return {
      computer: row.computer,
      totalEvents: Number(row.totalEvents || 0),
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      channels: Number(row.channels || 0),
      eventIds: Number(row.eventIds || 0),
      statusLevel: status.level,
      statusLabel: status.label,
      ageSeconds: status.ageSeconds,
    };
  });

  const groups = ["online", "active", "delayed", "stale", "unknown"].map((level) => {
    const members = hosts.filter((host) => host.statusLevel === level);
    return {
      level,
      label: hostLevelLabel(level),
      count: members.length,
      hosts: members.slice(0, 20),
    };
  });

  sendJson(res, 200, { hosts, groups });
}

async function processTopProcesses(ctx, res) {
  const processPath = processImageExpr();
  const where = timeWhere(ctx.url, [`${processPath} != ''`]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT ${processPath} AS processPath, count() AS volume
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
      ${processImageExpr()} AS processPath,
      ${fieldExpr('parent_process_path', 'ParentImage')} AS parentProcessPath,
      left(${fieldExpr('command_line', 'CommandLine')}, 800) AS commandLine,
      ${fieldExpr('process_guid', 'ProcessGuid')} AS processGuid,
      ${fieldExpr('parent_process_guid', 'ParentProcessGuid')} AS parentProcessGuid
    FROM default.process_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function networkTopDestinationIps(ctx, res) {
  const destinationIp = fieldExpr("destination_ip", "DestinationIp");
  const where = timeWhere(ctx.url, [`${destinationIp} != ''`]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT ${destinationIp} AS destinationIp, count() AS volume
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
      ${fieldExpr('user_name', 'User')} AS userName,
      ${fieldExpr('process_guid', 'ProcessGuid')} AS processGuid,
      ${processImageExpr()} AS processPath,
      ${fieldExpr('source_ip', 'SourceIp')} AS sourceIp,
      ${uintFieldExpr("source_port", "SourcePort")} AS sourcePort,
      ${fieldExpr('destination_ip', 'DestinationIp')} AS destinationIp,
      ${uintFieldExpr("destination_port", "DestinationPort")} AS destinationPort,
      ${fieldExpr('protocol', 'Protocol')} AS protocol,
      ${fieldExpr('initiated', 'Initiated')} AS initiated
    FROM default.network_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function dnsTopDomains(ctx, res) {
  const dnsQuery = fieldExpr("dns_query", "QueryName");
  const where = timeWhere(ctx.url, [`${dnsQuery} != ''`]);
  const limit = limitParam(ctx.url, 50, 200);
  const rows = await queryRows(`
    SELECT ${dnsQuery} AS domain, count() AS volume
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
      ${fieldExpr('user_name', 'User')} AS userName,
      ${fieldExpr('process_guid', 'ProcessGuid')} AS processGuid,
      ${processImageExpr()} AS processPath,
      ${fieldExpr('dns_query', 'QueryName')} AS dnsQuery,
      ${fieldExpr('query_status', 'QueryStatus')} AS queryStatus
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
      ${fieldExpr('user_name', 'User')} AS userName,
      ${processImageExpr()} AS processPath,
      ${fieldExpr('target_object', 'TargetObject')} AS targetObject,
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
      ${fieldExpr('user_name', 'User')} AS userName,
      ${processImageExpr()} AS processPath,
      ${fieldExpr('target_filename', 'TargetFilename')} AS targetFilename,
      ${fieldExpr('hashes', 'Hashes')} AS hashes,
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
      ${fieldExpr('user_name', 'User')} AS userName,
      ${fieldExpr('process_path', 'SourceImage', 'Image')} AS processPath,
      ${fieldExpr('target_image', 'TargetImage')} AS targetImage,
      ${fieldExpr('granted_access', 'GrantedAccess')} AS grantedAccess,
      ${fieldExpr('call_trace', 'CallTrace')} AS callTrace,
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
      ${fieldExpr('user_name', 'User')} AS userName,
      left(${fieldExpr('command_line', 'CommandLine')}, 800) AS commandLine,
      left(${fieldExpr('script_block_text', 'ScriptBlockText')}, 1200) AS scriptBlockText,
      left(message, 300) AS message
    FROM default.powershell_events
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
}

async function jitterSummary(ctx, res) {
  const where = timeWhere(ctx.url);
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
  const where = timeWhere(ctx.url);
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
  const where = timeWhere(ctx.url);
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
  const where = timeWhere(ctx.url);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      computer,
      argMax(agent_id, metric_timestamp) AS agentId,
      argMax(spool_file, metric_timestamp) AS lastChunk,
      argMax(line_offset, metric_timestamp) AS lineOffset,
      argMax(next_line_offset, metric_timestamp) AS nextLineOffset,
      argMax(batch_size, metric_timestamp) AS batchSize,
      argMax(batch_bytes, metric_timestamp) AS batchBytes,
      argMax(compressed_bytes, metric_timestamp) AS compressedBytes,
      argMax(status_code, metric_timestamp) AS statusCode,
      argMax(success, metric_timestamp) AS success,
      argMax(data_loss, metric_timestamp) AS dataLoss,
      argMax(planned_jitter_ms, metric_timestamp) AS plannedJitterMs,
      argMax(jitter_window_ms, metric_timestamp) AS jitterWindowMs,
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

async function hostsHeatmap(ctx, res) {
  const top = limitParam(ctx.url, 10, 25, "top");
  const bucket = bucketFunction(ctx.url.searchParams.get("bucket") || "minute");
  const where = timeWhere(ctx.url, ["computer != ''"]);

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

  const channel = ctx.url.searchParams.get("channel");
  const eventId = ctx.url.searchParams.get("eventId");
  const q = ctx.url.searchParams.get("q");
  if (channel) predicates.push(`channel = ${sqlString(channel)}`);
  if (eventId) predicates.push(`event_id = ${uintParam(eventId, "eventId")}`);
  if (q) {
    const search = sqlString(q);
    predicates.push(`(
      positionCaseInsensitive(message, ${search}) > 0
      OR positionCaseInsensitive(command_line, ${search}) > 0
      OR positionCaseInsensitive(process_path, ${search}) > 0
      OR positionCaseInsensitive(raw_log, ${search}) > 0
    )`);
  }

  const where = `WHERE ${predicates.join(" AND ")}`;
  const limit = limitParam(ctx.url, 200, 500);

  const chunkWhere = `WHERE computer = ${sqlString(host)} AND metric_timestamp >= ${startExpr} AND metric_timestamp < ${endExpr}`;

  const [summaryRows, byChannel, byEventId, byEventType, recentLogs, chunks] = await Promise.all([
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
        ${fieldExpr('user_name', 'User')} AS userName,
        ${processImageExpr()} AS processPath,
        left(${fieldExpr('command_line', 'CommandLine')}, 800) AS commandLine,
        ${fieldExpr('source_ip', 'SourceIp')} AS sourceIp,
        ${fieldExpr('destination_ip', 'DestinationIp')} AS destinationIp,
        ${fieldExpr('dns_query', 'QueryName')} AS dnsQuery,
        ${fieldExpr('target_filename', 'TargetFilename')} AS targetFilename,
        ${fieldExpr('target_object', 'TargetObject')} AS targetObject,
        left(message, 500) AS message
      FROM default.windows_system_logs
      ${where}
      ORDER BY kafka_timestamp DESC
      LIMIT ${limit}
    `),
    queryRows(`
      SELECT
        metric_timestamp AS sentAt,
        agent_id AS agentId,
        spool_file AS spoolFile,
        line_offset AS lineOffset,
        next_line_offset AS nextLineOffset,
        batch_size AS batchSize,
        batch_bytes AS batchBytes,
        compressed_bytes AS compressedBytes,
        planned_jitter_ms AS plannedJitterMs,
        jitter_window_ms AS jitterWindowMs,
        retry_attempt AS retryAttempt,
        planned_backoff_ms AS plannedBackoffMs,
        spool_depth_bytes AS spoolDepthBytes,
        spool_file_count AS spoolFileCount,
        pending_file_count AS pendingFileCount,
        status_code AS statusCode,
        send_duration_ms AS sendDurationMs,
        success,
        data_loss AS dataLoss,
        message
      FROM default.shipper_runtime_metrics
      ${chunkWhere}
      ORDER BY metric_timestamp DESC
      LIMIT 100
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
    chunks,
  });
}

async function logsSearch(ctx, res) {
  const q = requiredString(ctx.url, "q");
  const where = timeWhere(ctx.url, [
    `(
      positionCaseInsensitive(message, ${sqlString(q)}) > 0
      OR positionCaseInsensitive(command_line, ${sqlString(q)}) > 0
      OR positionCaseInsensitive(process_path, ${sqlString(q)}) > 0
      OR positionCaseInsensitive(raw_log, ${sqlString(q)}) > 0
    )`,
  ]);
  const limit = limitParam(ctx.url, 100, 500);
  const rows = await queryRows(`
    SELECT
      kafka_timestamp AS time,
      computer,
      channel,
      event_id AS eventId,
      level,
      ${fieldExpr('user_name', 'User')} AS userName,
      ${processImageExpr()} AS processPath,
      left(${fieldExpr('command_line', 'CommandLine')}, 800) AS commandLine,
      left(message, 500) AS message,
      idempotency_key AS idempotencyKey
    FROM default.windows_system_logs
    ${where.sql}
    ORDER BY kafka_timestamp DESC
    LIMIT ${limit}
  `);
  sendJson(res, 200, { items: rows });
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

  const response = await fetch(config.clickhouseUrl, {
    method: "POST",
    headers,
    body,
  });
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

function fieldExpr(column, ...jsonKeys) {
  const fallbacks = jsonKeys.map((key) => `nullIf(JSONExtractString(event_data_json, ${sqlString(key)}), '')`);
  return `coalesce(nullIf(${column}, ''), ${fallbacks.join(", ")}, '')`;
}

function processImageExpr() {
  return fieldExpr("process_path", "Image", "NewProcessName", "ApplicationPath", "SourceImage");
}

function uintFieldExpr(column, jsonKey) {
  return `if(${column} != 0, ${column}, toUInt32OrZero(JSONExtractString(event_data_json, ${sqlString(jsonKey)})))`;
}

function timeWhere(url, extraPredicates = []) {
  const from = dateParam(url, "from", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = dateParam(url, "to", new Date());
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

function hostStatus(lastSeen) {
  if (!lastSeen) return { level: "unknown", label: hostLevelLabel("unknown"), ageSeconds: null };
  const normalized = String(lastSeen).includes("T") ? lastSeen : String(lastSeen).replace(" ", "T");
  const time = new Date(normalized).getTime();
  if (Number.isNaN(time)) return { level: "unknown", label: hostLevelLabel("unknown"), ageSeconds: null };

  const ageSeconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
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
  if (Number(row.success || 0) !== 1 || Number(row.statusCode || 0) >= 400) return "failed";
  if (Number(row.dataLoss || 0) === 1) return "failed";
  if (Number(row.spoolDepthBytes || 0) >= 1024 * 1024 * 1024 || Number(row.pendingFileCount || 0) >= 20) return "delayed";
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

function requiredString(url, name) {
  const value = url.searchParams.get(name);
  if (!value || !value.trim()) badRequest(`${name} is required`);
  return value.trim();
}

function limitParam(url, fallback, max, name = "limit") {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) badRequest(`${name} must be a positive integer`);
  return Math.min(value, max);
}

function uintParam(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) badRequest(`${name} must be a non-negative integer`);
  return parsed;
}

function sqlDate(date) {
  const iso = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  return `parseDateTime64BestEffort(${sqlString(iso)}, 3)`;
}

function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
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
