import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const minute = 60 * 1000;
const now = Date.now();
const time = (ageMs) => new Date(now - ageMs).toISOString();

test("UC-02 merges enrollment, log and shipper telemetry into collection status", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(api.url + "/api/dashboard/hosts/summary?limit=50");
    assert.equal(response.status, 200);

    const byHost = new Map(response.body.hosts.map((host) => [host.computer, host]));
    assert.equal(byHost.get("HOST-ONLINE").statusLevel, "online");
    assert.equal(byHost.get("HOST-ACTIVE").statusLevel, "active");
    assert.equal(byHost.get("HOST-DELAYED").statusLevel, "delayed");
    assert.equal(byHost.get("HOST-STALE").statusLevel, "stale");
    assert.equal(byHost.get("HOST-UNKNOWN").statusLevel, "unknown");

    assert.equal(byHost.get("HOST-ONLINE").collectionLevel, "ok");
    assert.equal(byHost.get("HOST-FAILED").collectionLevel, "failed");
    assert.equal(byHost.get("HOST-BACKLOG").collectionLevel, "delayed");
    assert.equal(byHost.get("HOST-STALE").collectionLevel, "stale");
    assert.equal(byHost.get("HOST-DISABLED").collectionLevel, "disabled");
    assert.equal(byHost.get("HOST-REGISTERED").collectionLevel, "unknown");

    const registeredOnly = byHost.get("HOST-REGISTERED");
    assert.equal(registeredOnly.agentId, "agent-registered");
    assert.equal(registeredOnly.totalEvents, 0);
    assert.equal(registeredOnly.lastLogSeen, null);

    const online = byHost.get("HOST-ONLINE");
    assert.equal(online.lastAckStatus, "durable_commit");
    assert.equal(online.statusCode, 202);
    assert.equal(online.pendingFileCount, 2);
    assert.equal(online.totalEvents, 120);

    assert.equal(response.body.groups.find((group) => group.level === "unknown").count, 1);
    assert.equal(response.body.collectionGroups.find((group) => group.level === "failed").count, 1);

    const registered = await getJson(api.url + "/api/dashboard/agents/registered?limit=20");
    assert.equal(registered.status, 200);
    assert.equal(registered.body.items[0].agentId, "agent-online");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-02 exposes jitter and chunk health without fabricated fallback data", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const [jitterSummary, jitterHosts, chunksSummary, chunkHosts] = await Promise.all([
      getJson(api.url + "/api/dashboard/jitter/summary"),
      getJson(api.url + "/api/dashboard/jitter/hosts?limit=100"),
      getJson(api.url + "/api/dashboard/chunks/summary"),
      getJson(api.url + "/api/dashboard/chunks/hosts?limit=100"),
    ]);

    assert.equal(jitterSummary.status, 200);
    assert.equal(jitterSummary.body.hosts, "3");
    assert.equal(jitterSummary.body.worstHost.computer, "HOST-BACKLOG");
    assert.equal(jitterHosts.status, 200);
    assert.equal(jitterHosts.body.items[0].statusLevel, "delayed");

    assert.equal(chunksSummary.status, 200);
    assert.equal(chunksSummary.body.failedChunks, "1");
    assert.equal(chunksSummary.body.latestChunk.computer, "HOST-ONLINE");
    assert.equal(chunkHosts.status, 200);
    assert.equal(chunkHosts.body.items.find((item) => item.computer === "HOST-FAILED").statusLevel, "failed");
    assert.equal(chunkHosts.body.items.find((item) => item.computer === "HOST-BACKLOG").statusLevel, "delayed");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-14 exposes measured loss counters and explicit unavailable fields", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const [summary, hosts] = await Promise.all([
      getJson(api.url + "/api/dashboard/log-loss/summary"),
      getJson(api.url + "/api/dashboard/log-loss/hosts?limit=100"),
    ]);

    assert.equal(summary.status, 200);
    assert.equal(summary.body.measuredHosts, 2);
    assert.equal(summary.body.unavailableHosts, 1);
    assert.equal(summary.body.collectedEvents, 1420);
    assert.equal(summary.body.sentEvents, 1310);
    assert.equal(summary.body.pendingEvents, 110);
    assert.equal(summary.body.droppedEvents, 30);
    assert.equal(summary.body.generatedEvents, null);
    assert.equal(summary.body.generatedAvailability, "unavailable");

    assert.equal(hosts.status, 200);
    const byHost = new Map(hosts.body.items.map((item) => [item.computer, item]));
    assert.equal(byHost.get("HOST-ONLINE").statusLevel, "bursty");
    assert.equal(byHost.get("HOST-BACKLOG").statusLevel, "failed");
    assert.equal(byHost.get("HOST-BACKLOG").atRiskEventCount, 90);
    assert.equal(byHost.get("HOST-REGISTERED").coverage, "unavailable");
    assert.equal(byHost.get("HOST-REGISTERED").collectedEventCount, null);
    assert.equal(byHost.get("HOST-ONLINE").serverReceivedEvents, 1180);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-15 calculates measured loss ratios by host, Agent, channel and Event ID", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const overall = await getJson(api.url + "/api/dashboard/log-loss/summary");
    assert.equal(overall.status, 200);
    assert.equal(overall.body.lossRatioPercent, 2.1127);

    const filtered = await getJson(api.url + "/api/dashboard/log-loss/hosts?channel=Security&eventId=4625&agent=agent-backlog");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.items.length, 1);
    assert.equal(filtered.body.items[0].computer, "HOST-BACKLOG");
    assert.equal(filtered.body.items[0].ratioCollectedEventCount, 50);
    assert.equal(filtered.body.items[0].ratioDroppedEventCount, 10);
    assert.equal(filtered.body.items[0].lossRatioPercent, 20);
    assert.equal(filtered.body.items[0].ratioCoverage, "measured");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-15 UI exposes Agent, channel and Event ID ratio filters", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(html, /id="lossAgentFilter"/);
  assert.match(html, /id="lossChannelFilter"/);
  assert.match(html, /id="lossEventIdFilter"/);
  assert.match(app, /lossRatioPercent/);
});

test("UC-16 exposes evidence-backed log-loss causes without fabricating a diagnosis", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const [summary, hosts] = await Promise.all([
      getJson(api.url + "/api/dashboard/log-loss/summary"),
      getJson(api.url + "/api/dashboard/log-loss/hosts?limit=100"),
    ]);
    assert.equal(summary.status, 200);
    const causes = new Map(summary.body.causeCounts.map((item) => [item.code, item.count]));
    assert.equal(causes.get("quota_eviction"), 1);
    assert.equal(causes.get("source_read_failure"), 1);

    const byHost = new Map(hosts.body.items.map((item) => [item.computer, item]));
    assert.equal(byHost.get("HOST-BACKLOG").causeCode, "quota_eviction");
    assert.match(byHost.get("HOST-BACKLOG").causeEvidence, /30 event/);
    assert.equal(byHost.get("HOST-REGISTERED").causeCode, "source_read_failure");
    assert.equal(byHost.get("HOST-ONLINE").causeCode, "retry_backlog");
    assert.ok(clickhouse.queries.some((sql) => sql.includes("transportStatusCode")));
    assert.ok(clickhouse.queries.some((sql) => sql.includes("latestErrorType")));
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-16 UI renders cause summaries and per-host evidence", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(html, /id="lossCauseSummary"/);
  assert.match(app, /causeEvidence/);
  assert.match(app, /renderLossCauseSummary/);
});

test("UC-17 reports recovered and ongoing collection interruptions from observed evidence gaps", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  const from = new Date(now - 2 * 60 * minute).toISOString();
  const to = new Date(now).toISOString();

  try {
    const response = await getJson(`${api.url}/api/dashboard/log-loss/interruptions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&thresholdMinutes=15`);
    assert.equal(response.status, 200);
    assert.equal(response.body.thresholdMinutes, 15);
    assert.deepEqual(response.body.summary, { interruptions: 2, ongoing: 1, recovered: 1, affectedHosts: 2 });

    const recovered = response.body.items.find((item) => item.computer === "HOST-ONLINE");
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.durationSeconds, 23 * 60);
    assert.ok(recovered.endedAt);
    assert.ok(recovered.evidenceSources.includes("shipper_metric"));

    const ongoing = response.body.items.find((item) => item.computer === "HOST-BACKLOG");
    assert.equal(ongoing.status, "ongoing");
    assert.equal(ongoing.endedAt, null);
    assert.equal(ongoing.durationSeconds, 25 * 60);

    const recoveredOnly = await getJson(`${api.url}/api/dashboard/log-loss/interruptions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&thresholdMinutes=15&status=recovered`);
    assert.equal(recoveredOnly.status, 200);
    assert.equal(recoveredOnly.body.items.length, 1);
    assert.equal(recoveredOnly.body.items[0].computer, "HOST-ONLINE");
    assert.ok(clickhouse.queries.some((sql) => sql.includes("activitySignalUnixMs") && sql.includes("gateway_chunk")));
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-17 validates its threshold before querying ClickHouse and exposes the history UI", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const invalid = await getJson(api.url + "/api/dashboard/log-loss/interruptions?thresholdMinutes=2");
    assert.equal(invalid.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }

  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(html, /id="lossInterruptionThreshold"/);
  assert.match(html, /id="lossInterruptionTable"/);
  assert.match(app, /\/api\/dashboard\/log-loss\/interruptions/);
  assert.match(app, /renderInterruptionHistory/);
});

test("UC-14 empty responses and validation remain deterministic", async () => {
  const emptyClickHouse = await startMockClickHouse({ mode: "empty" });
  const emptyApi = await startApi(emptyClickHouse.url);
  try {
    const response = await getJson(emptyApi.url + "/api/dashboard/log-loss/summary");
    assert.equal(response.status, 200);
    assert.equal(response.body.hosts, 0);
    assert.equal(response.body.generatedEvents, null);
  } finally {
    await emptyApi.close();
    await emptyClickHouse.close();
  }

  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const response = await getJson(api.url + "/api/dashboard/log-loss/hosts?limit=bad");
    assert.equal(response.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-14 UI uses loss endpoints and marks generated counts unavailable", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.ok(app.includes("/api/dashboard/log-loss/summary"));
  assert.match(app, /generatedMessage/);
  assert.match(html, /id="log-loss"/);
  assert.match(html, /Phat sinh tai Windows de trong/);
});

test("UC-02 empty database responses are deterministic", async () => {
  const clickhouse = await startMockClickHouse({ mode: "empty" });
  const api = await startApi(clickhouse.url);

  try {
    const hosts = await getJson(api.url + "/api/dashboard/hosts/summary");
    assert.equal(hosts.status, 200);
    assert.deepEqual(hosts.body.hosts, []);
    assert.ok(hosts.body.groups.every((group) => group.count === 0));
    assert.ok(hosts.body.collectionGroups.every((group) => group.count === 0));

    const jitter = await getJson(api.url + "/api/dashboard/jitter/hosts");
    const chunks = await getJson(api.url + "/api/dashboard/chunks/hosts");
    assert.deepEqual(jitter.body, { items: [] });
    assert.deepEqual(chunks.body, { items: [] });
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-02 rejects invalid operational filters before ClickHouse queries", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const before = clickhouse.queries.length;
    const cases = [
      ["/api/dashboard/hosts/summary?limit=5x", "limit must be a positive integer"],
      ["/api/dashboard/hosts/summary?from=not-a-date", "from must be a valid date"],
      ["/api/dashboard/chunks/hosts?from=2026-07-03T00:00:00Z&to=2026-07-02T00:00:00Z", "from must be earlier"],
    ];
    for (const [path, message] of cases) {
      const response = await getJson(api.url + path);
      assert.equal(response.status, 400);
      assert.match(response.body.message, new RegExp(message));
    }
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-02 reports ClickHouse failures and outages explicitly", async () => {
  const clickhouse = await startMockClickHouse({ mode: "error" });
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/hosts/summary");
    assert.equal(response.status, 502);
    assert.equal(response.body.message, "ClickHouse query failed");
  } finally {
    await api.close();
    await clickhouse.close();
  }

  const unreachablePort = await freePort();
  const outageApi = await startApi("http://127.0.0.1:" + unreachablePort);
  try {
    const response = await getJson(outageApi.url + "/api/dashboard/chunks/hosts");
    assert.equal(response.status, 503);
    assert.equal(response.body.message, "ClickHouse is not reachable");
  } finally {
    await outageApi.close();
  }
});

test("UC-02 UI presents operational collection columns and uses live endpoints", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const css = await readFile(resolve(ROOT, "../HostEyeDashboard/public/styles.css"), "utf8");

  assert.match(app, /\/api\/dashboard\/hosts\/summary/);
  assert.match(app, /Collection health/);
  assert.match(app, /Last log/);
  assert.match(app, /Last upload/);
  assert.match(app, /ACK \/ HTTP/);
  assert.match(app, /Spool/);
  assert.match(app, /Pending/);
  assert.doesNotMatch(app, /renderDemoDashboard/);
  assert.match(css, /\.status-disabled/);
});

async function startMockClickHouse(options = {}) {
  const state = { mode: options.mode || "data", queries: [] };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    state.queries.push(body);

    if (state.mode === "error") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("mock query failure");
      return;
    }

    const rows = state.mode === "empty" ? rowsForEmptyQuery(body) : rowsForQuery(body);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  });

  await listen(server);
  return {
    url: "http://127.0.0.1:" + server.address().port,
    queries: state.queries,
    close: () => closeServer(server),
  };
}

function rowsForEmptyQuery(sql) {
  if (sql.includes("avg(planned_jitter_ms) AS avgJitterMs") && !sql.includes("GROUP BY computer")) {
    return [{ samples: "0", hosts: "0", avgJitterMs: "0", p95JitterMs: "0", maxJitterMs: "0" }];
  }
  if (sql.includes("sum(if(success = 1")) {
    return [{ chunks: "0", hosts: "0", eventsSent: "0", failedChunks: "0" }];
  }
  return [];
}

function rowsForQuery(sql) {
  if (sql.includes("activitySignalUnixMs")) {
    return [
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", activitySignalUnixMs: now - 40 * minute, evidenceSources: ["admission"] },
      { computer: "HOST-ONLINE", agentId: "agent-online", activitySignalUnixMs: now - 50 * minute, evidenceSources: ["shipper_metric"] },
      { computer: "HOST-ONLINE", agentId: "agent-online", activitySignalUnixMs: now - 48 * minute, evidenceSources: ["gateway_chunk"] },
      { computer: "HOST-ONLINE", agentId: "agent-online", activitySignalUnixMs: now - 10 * minute, evidenceSources: ["shipper_metric", "registration"] },
      { computer: "HOST-REGISTERED", agentId: "agent-registered", activitySignalUnixMs: now - 2 * minute, evidenceSources: ["registration"] },
    ];
  }

  if (sql.includes("max(kafka_timestamp) AS lastLogSeen")) {
    return [
      { computer: "HOST-ONLINE", totalEvents: "120", firstSeen: time(2 * 60 * minute), lastLogSeen: time(minute), channels: "4", eventIds: "18" },
      { computer: "HOST-ACTIVE", totalEvents: "60", firstSeen: time(4 * 60 * minute), lastLogSeen: time(30 * minute), channels: "3", eventIds: "12" },
      { computer: "HOST-DELAYED", totalEvents: "20", firstSeen: time(8 * 60 * minute), lastLogSeen: time(2 * 60 * minute), channels: "2", eventIds: "8" },
      { computer: "HOST-STALE", totalEvents: "8", firstSeen: time(4 * 24 * 60 * minute), lastLogSeen: time(2 * 24 * 60 * minute), channels: "1", eventIds: "4" },
    ];
  }

  if (sql.includes("agentFirstSeen")) {
    return [
      { computer: "HOST-ONLINE", agentId: "agent-online", hostId: "host-online", agentFirstSeen: time(24 * 60 * minute), agentLastSeen: time(minute), shipperVersion: "1.2.0", agentStatus: "active", enrollmentStatus: "enrolled", registeredLastChunk: "chunk-online", registeredLastAckStatus: "durable_commit" },
      { computer: "HOST-REGISTERED", agentId: "agent-registered", hostId: "host-registered", agentFirstSeen: time(20 * minute), agentLastSeen: time(2 * minute), shipperVersion: "1.2.0", agentStatus: "active", enrollmentStatus: "enrolled" },
      { computer: "HOST-DISABLED", agentId: "agent-disabled", hostId: "host-disabled", agentFirstSeen: time(60 * minute), agentLastSeen: time(2 * minute), shipperVersion: "1.1.0", agentStatus: "disabled", enrollmentStatus: "revoked" },
      { computer: "HOST-UNKNOWN", agentId: "agent-unknown", hostId: "host-unknown", agentFirstSeen: null, agentLastSeen: null, shipperVersion: "1.0.0", agentStatus: "active", enrollmentStatus: "enrolled" },
    ];
  }

  if (sql.includes("metricAgentId")) {
    return [
      { computer: "HOST-ONLINE", metricAgentId: "agent-online", metricHostId: "host-online", metricShipperVersion: "1.2.0", lastMetricSeen: time(minute), metricLastChunk: "chunk-online", metricLastAckStatus: "durable_commit", statusCode: "202", success: "1", dataLoss: "0", spoolDepthBytes: "4096", pendingFileCount: "2", uploadSamples: "10" },
      { computer: "HOST-FAILED", metricAgentId: "agent-failed", metricHostId: "host-failed", metricShipperVersion: "1.2.0", lastMetricSeen: time(2 * minute), metricLastChunk: "chunk-failed", metricLastAckStatus: "rejected", statusCode: "500", success: "0", dataLoss: "0", spoolDepthBytes: "1000", pendingFileCount: "1", uploadSamples: "3" },
      { computer: "HOST-BACKLOG", metricAgentId: "agent-backlog", metricHostId: "host-backlog", metricShipperVersion: "1.2.0", lastMetricSeen: time(3 * minute), metricLastChunk: "chunk-backlog", metricLastAckStatus: "retrying", statusCode: "0", success: "0", dataLoss: "0", spoolDepthBytes: String(2 * 1024 * 1024 * 1024), pendingFileCount: "25", uploadSamples: "6" },
    ];
  }

  if (sql.includes("transportStatusCode")) {
    return [
      { computer: "HOST-ONLINE", agentId: "agent-online", transportStatusCode: "202", transportSuccess: "1", transportDataLoss: "0", transportMessage: "durable commit", transportMetricType: "upload", transportLastSeen: time(minute) },
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", transportStatusCode: "0", transportSuccess: "0", transportDataLoss: "0", transportMessage: "connection refused", transportMetricType: "retrying", transportLastSeen: time(3 * minute) },
    ];
  }

  if (sql.includes("latestErrorType")) {
    return [
      { agentId: "agent-registered", latestErrorType: "source_read_failed", latestErrorSeen: time(2 * minute), errorCount: "1" },
    ];
  }

  if (sql.includes("argMax(loss_metrics_version")) {
    return [
      { computer: "HOST-ONLINE", agentId: "agent-online", hostId: "host-online", lossMetricsVersion: "2", collectedEventCount: "1200", sentEventCount: "1180", pendingEventCount: "20", droppedEventCount: "0", collectedBySourceJson: JSON.stringify({ "Security\u001f4625": 100, "System\u001f7036": 1100 }), droppedBySourceJson: "{}", unattributedDroppedEventCount: "0", queueUsedMb: "10", maxSpoolBytes: String(1024 * 1024 * 1024), metricLastSeen: time(minute) },
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", hostId: "host-backlog", lossMetricsVersion: "2", collectedEventCount: "220", sentEventCount: "130", pendingEventCount: "90", droppedEventCount: "30", collectedBySourceJson: JSON.stringify({ "Security\u001f4625": 50, "Microsoft-Windows-Sysmon/Operational\u001f1": 170 }), droppedBySourceJson: JSON.stringify({ "Security\u001f4625": 10, "Microsoft-Windows-Sysmon/Operational\u001f1": 20 }), unattributedDroppedEventCount: "0", queueUsedMb: "900", maxSpoolBytes: String(1024 * 1024 * 1024), metricLastSeen: time(3 * minute) },
    ];
  }

  if (sql.includes("sum(eventCount) AS serverReceivedEvents")) {
    return [
      { computer: "HOST-ONLINE", serverReceivedEvents: "1180", receivedChunks: "10", serverLastSeen: time(minute) },
      { computer: "HOST-BACKLOG", serverReceivedEvents: "130", receivedChunks: "2", serverLastSeen: time(3 * minute) },
    ];
  }

  if (sql.includes("registeredLastSeen")) {
    return [
      { computer: "HOST-ONLINE", agentId: "agent-online", hostId: "host-online", registeredLastSeen: time(minute) },
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", hostId: "host-backlog", registeredLastSeen: time(3 * minute) },
      { computer: "HOST-REGISTERED", agentId: "agent-registered", hostId: "host-registered", registeredLastSeen: time(2 * minute) },
    ];
  }

  if (sql.includes("argMax(cert_serial")) {
    return [{ agentId: "agent-online", hostId: "host-online", computer: "HOST-ONLINE", certSerial: "abc", firstSeen: time(24 * 60 * minute), lastSeen: time(minute), schemaVersion: "1", sourcePlatform: "windows", shipperVersion: "1.2.0", status: "active", enrollmentStatus: "enrolled" }];
  }

  if (sql.includes("avg(planned_jitter_ms) AS avgJitterMs") && !sql.includes("GROUP BY computer")) {
    return [{ samples: "20", hosts: "3", avgJitterMs: "12000", p95JitterMs: "44000", maxJitterMs: "60000", avgBatchSize: "200", maxSpoolDepthBytes: String(2 * 1024 * 1024 * 1024), lastSeen: time(minute) }];
  }
  if (sql.includes("ORDER BY p95JitterMs DESC")) {
    return [{ computer: "HOST-BACKLOG", p95JitterMs: "55000", spoolDepthBytes: String(2 * 1024 * 1024 * 1024), lastSeen: time(3 * minute) }];
  }
  if (sql.includes("min(planned_jitter_ms)")) {
    return [
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", samples: "6", avgJitterMs: "30000", minJitterMs: "1000", maxJitterMs: "60000", p95JitterMs: "55000", avgBatchSize: "100", maxBatchSize: "200", spoolDepthBytes: String(2 * 1024 * 1024 * 1024), pendingFileCount: "25", lastSeen: time(3 * minute) },
      { computer: "HOST-ONLINE", agentId: "agent-online", samples: "10", avgJitterMs: "5000", minJitterMs: "1000", maxJitterMs: "8000", p95JitterMs: "7000", avgBatchSize: "120", maxBatchSize: "180", spoolDepthBytes: "4096", pendingFileCount: "2", lastSeen: time(minute) },
    ];
  }

  if (sql.includes("sum(if(success = 1")) {
    return [{ chunks: "19", hosts: "3", eventsSent: "2100", avgBatchSize: "110", maxSpoolDepthBytes: String(2 * 1024 * 1024 * 1024), okChunks: "18", failedChunks: "1", lastSeen: time(minute) }];
  }
  if (sql.includes("argMax(spool_file, metric_timestamp) AS spoolFile") && sql.includes("LIMIT 1")) {
    return [{ computer: "HOST-ONLINE", spoolFile: "chunk-online.zst", statusCode: "202", success: "1", batchSize: "120", spoolDepthBytes: "4096", plannedJitterMs: "5000", lastSeen: time(minute) }];
  }
  if (sql.includes("argMax(line_offset")) {
    return [
      { computer: "HOST-ONLINE", agentId: "agent-online", lastChunk: "chunk-online.zst", statusCode: "202", success: "1", dataLoss: "0", batchSize: "120", spoolDepthBytes: "4096", pendingFileCount: "2", chunks: "10", eventsSent: "1200", lastSeen: time(minute) },
      { computer: "HOST-FAILED", agentId: "agent-failed", lastChunk: "chunk-failed.zst", statusCode: "500", success: "0", dataLoss: "0", batchSize: "80", spoolDepthBytes: "1000", pendingFileCount: "1", chunks: "3", eventsSent: "240", lastSeen: time(2 * minute) },
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", lastChunk: "chunk-backlog.zst", statusCode: "0", success: "0", dataLoss: "0", batchSize: "100", spoolDepthBytes: String(2 * 1024 * 1024 * 1024), pendingFileCount: "25", chunks: "6", eventsSent: "600", lastSeen: time(3 * minute) },
    ];
  }
  return [];
}

async function startApi(clickhouseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLICKHOUSE_URL: clickhouseUrl, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await waitUntilReady("http://127.0.0.1:" + port, child, () => output);

  return {
    url: "http://127.0.0.1:" + port,
    close: async () => {
      if (child.exitCode === null) child.kill();
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2000)),
      ]);
    },
  };
}

async function waitUntilReady(baseUrl, child, output) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Dashboard API exited early: " + output());
    try {
      const response = await fetch(baseUrl + "/not-found");
      if (response.status === 404) return;
    } catch {
      // Retry until the child binds the port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Dashboard API did not start: " + output());
}

async function getJson(url) {
  const response = await fetch(url);
  const body = await response.text();
  return { status: response.status, body: body ? JSON.parse(body) : null };
}

async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(resolveClose));
}