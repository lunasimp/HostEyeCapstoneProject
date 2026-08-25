import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

test("UC-18 exposes endpoint retry backlog and recovery state from Shipper evidence", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/log-loss/retry-backlog?limit=100");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.summary, {
      backlogHosts: 2,
      pendingEvents: 110,
      pendingBytes: 910 * 1024 * 1024,
      resendingHosts: 1,
      waitingHosts: 0,
      backpressureHosts: 1,
      measuredHosts: 2,
    });
    const byHost = new Map(response.body.items.map((item) => [item.computer, item]));
    assert.equal(byHost.get("HOST-ONLINE").retryStatus, "resending");
    assert.equal(byHost.get("HOST-ONLINE").pendingEventCount, 20);
    assert.equal(byHost.get("HOST-BACKLOG").retryStatus, "backpressure");
    assert.equal(byHost.get("HOST-BACKLOG").retryCount, 4);
    assert.equal(byHost.get("HOST-BACKLOG").retryAfterSeconds, 30);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-18 UI presents retry backlog totals and per-host evidence", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/log-loss\/retry-backlog/);
  assert.match(app, /renderRetryBacklog/);
  assert.match(html, /id="lossRetryEvents"/);
  assert.match(html, /id="lossRetryTable"/);
});

test("UC-19 reports measured loss, connection, and interruption alerts without fabricated evidence", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/log-loss/alerts?thresholdPercent=1&limit=100");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.summary, { total: 2, critical: 1, high: 1, affectedHosts: 1 });
    assert.equal(response.body.thresholdPercent, 1);
    const rules = new Map(response.body.items.map((item) => [item.ruleId, item]));
    assert.equal(rules.get("HE-LOSS-001").computer, "HOST-BACKLOG");
    assert.match(rules.get("HE-LOSS-001").message, /30 event/);
    assert.equal(rules.get("HE-CONN-001").severity, "high");

    const higherThreshold = await getJson(api.url + "/api/dashboard/log-loss/alerts?thresholdPercent=20&limit=100");
    assert.equal(higherThreshold.status, 200);
    assert.equal(higherThreshold.body.summary.total, 1);
    assert.equal(higherThreshold.body.items[0].ruleId, "HE-CONN-001");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-19 validates alert thresholds and exposes the Log Loss alert UI", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const invalid = await getJson(api.url + "/api/dashboard/log-loss/alerts?thresholdPercent=101");
    assert.equal(invalid.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/log-loss\/alerts/);
  assert.match(app, /renderLossAlerts/);
  assert.match(html, /id="lossAlertThreshold"/);
  assert.match(html, /id="lossAlertTable"/);
});

test("UC-20 filters and searches hosts by evidence-backed log-loss risk state", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const backlog = await getJson(api.url + "/api/dashboard/log-loss/hosts?riskState=backlog&limit=100");
    assert.equal(backlog.status, 200);
    assert.deepEqual(backlog.body.items.map((item) => item.computer).sort(), ["HOST-BACKLOG", "HOST-ONLINE"]);
    assert.ok(backlog.body.items.every((item) => item.riskFlags.includes("backlog")));

    const disconnected = await getJson(api.url + "/api/dashboard/log-loss/hosts?riskState=disconnected&limit=100");
    assert.equal(disconnected.body.items.length, 1);
    assert.equal(disconnected.body.items[0].computer, "HOST-BACKLOG");
    assert.equal(disconnected.body.items[0].riskState, "disconnected");
    assert.ok(disconnected.body.items[0].riskFlags.includes("at_risk"));

    const searched = await getJson(api.url + "/api/dashboard/log-loss/hosts?machine=agent-backlog&riskState=at_risk&limit=100");
    assert.equal(searched.body.items.length, 1);
    assert.equal(searched.body.items[0].computer, "HOST-BACKLOG");
    assert.deepEqual(searched.body.filters, { machine: "agent-backlog", riskState: "at_risk" });
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-20 validates risk filters before querying and exposes search controls", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const invalid = await getJson(api.url + "/api/dashboard/log-loss/hosts?riskState=unsafe");
    assert.equal(invalid.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(html, /id="lossMachineFilter"/);
  assert.match(html, /id="lossRiskStateFilter"/);
  assert.match(app, /riskStateLabel/);
  assert.match(app, /riskFlags/);
});

test("UC-21 returns evidence-backed log-loss detail for one machine", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/log-loss/host-detail?machine=HOST-BACKLOG&agent=agent-backlog&thresholdMinutes=15");
    assert.equal(response.status, 200);
    assert.equal(response.body.host.computer, "HOST-BACKLOG");
    assert.equal(response.body.host.agentId, "agent-backlog");
    assert.equal(response.body.loss.generatedEventCount, null);
    assert.equal(response.body.loss.recordedDroppedEventCount, 30);
    assert.equal(response.body.loss.pendingEventCount, 90);
    assert.equal(response.body.sourceCoverage, "measured");
    assert.deepEqual(response.body.affectedSources.map((source) => [source.channel, source.eventId, source.droppedEventCount]), [
      ["Microsoft-Windows-Sysmon/Operational", "1", 20],
      ["Security", "4625", 10],
    ]);
    assert.equal(response.body.recovery.status, "ongoing");
    assert.equal(response.body.affectedPeriod.interruptionCount, 1);
    assert.equal(response.body.interruptions[0].computer, "HOST-BACKLOG");
    assert.equal(response.body.interruptions[0].status, "ongoing");

    const missing = await getJson(api.url + "/api/dashboard/log-loss/host-detail?machine=HOST-MISSING");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.message, "Host log-loss detail not found");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-21 validates detail input before querying and exposes an accessible dialog", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const missingMachine = await getJson(api.url + "/api/dashboard/log-loss/host-detail");
    assert.equal(missingMachine.status, 400);
    const invalidThreshold = await getJson(api.url + "/api/dashboard/log-loss/host-detail?machine=HOST-BACKLOG&thresholdMinutes=2");
    assert.equal(invalidThreshold.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/log-loss\/host-detail/);
  assert.match(app, /openLossDetail/);
  assert.match(app, /affectedSources/);
  assert.match(html, /id="lossDetailModal"/);
  assert.match(html, /aria-labelledby="lossDetailTitle"/);
});
test("UC-22 exports filtered log-loss evidence as UTF-8 CSV", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getText(api.url + "/api/dashboard/log-loss/export?format=csv&machine=backlog&agent=agent-backlog&channel=Security&eventId=4625&riskState=at_risk");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    assert.match(response.headers.get("content-disposition"), /^attachment; filename="hosteye-log-loss-/);
    assert.equal(response.body.charCodeAt(0), 0xfeff);
    assert.match(response.body, /"report_generated_at","range_from","range_to"/);
    assert.match(response.body, /"HOST-BACKLOG"/);
    assert.doesNotMatch(response.body, /"HOST-ONLINE"/);
    assert.match(response.body, /"Security","4625"/);
    assert.match(response.body, /,220,130,90,90,30,50,10,20,130,/);
    assert.match(response.body, /"requires_attention","disconnected"/);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-22 validates export format before querying and exposes download controls", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const invalid = await getJson(api.url + "/api/dashboard/log-loss/export?format=xlsx");
    assert.equal(invalid.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/log-loss\/export/);
  assert.match(app, /exportLogLossReport/);
  assert.match(app, /content-disposition/);
  assert.match(html, /id="lossExport"/);
  assert.match(html, /id="lossExportStatus"/);
});

test("UC-33 aggregates evidence-backed fleet log-loss monitoring for Admin", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/admin/log-loss/fleet?top=10");
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.hosts, 3);
    assert.equal(response.body.summary.sourceRows, 3);
    assert.equal(response.body.summary.duplicateRowsCollapsed, 0);
    assert.equal(response.body.summary.measuredHosts, 2);
    assert.equal(response.body.summary.unavailableHosts, 1);
    assert.equal(response.body.summary.measurementCoveragePercent, 66.67);
    assert.equal(response.body.summary.affectedHosts, 2);
    assert.equal(response.body.summary.disconnectedHosts, 1);
    assert.equal(response.body.summary.atRiskHosts, 1);
    assert.equal(response.body.summary.backlogHosts, 2);
    assert.equal(response.body.summary.droppedEvents, 30);
    assert.equal(response.body.summary.atRiskEvents, 90);
    assert.equal(response.body.summary.pendingEvents, 110);
    assert.equal(response.body.summary.lossRatioPercent, 2.1127);
    assert.equal(response.body.summary.generatedEvents, null);
    assert.equal(response.body.topHosts[0].computer, "HOST-BACKLOG");
    assert.deepEqual(response.body.topHosts.map((item) => item.computer), ["HOST-BACKLOG", "HOST-ONLINE"]);
    const distribution = new Map(response.body.riskDistribution.map((item) => [item.state, item.hosts]));
    assert.equal(distribution.get("disconnected"), 1);
    assert.equal(distribution.get("backlog"), 1);
    assert.equal(distribution.get("unknown"), 1);

    const filtered = await getJson(api.url + "/api/dashboard/admin/log-loss/fleet?riskState=at_risk&top=25");
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.focusTotal, 1);
    assert.deepEqual(filtered.body.topHosts.map((item) => item.computer), ["HOST-BACKLOG"]);
    assert.equal(filtered.body.summary.hosts, 3);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-33 returns a deterministic empty fleet without fabricated counters", async () => {
  const clickhouse = await startMockClickHouse({ mode: "empty" });
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/admin/log-loss/fleet");
    assert.equal(response.status, 200);
    assert.equal(response.body.summary.hosts, 0);
    assert.equal(response.body.summary.measuredHosts, 0);
    assert.equal(response.body.summary.lossRatioPercent, null);
    assert.equal(response.body.summary.generatedEvents, null);
    assert.deepEqual(response.body.topHosts, []);
    assert.equal(response.body.focusTotal, 0);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-33 validates Admin fleet filters and exposes a dedicated responsive view", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const before = clickhouse.queries.length;
    const invalidRisk = await getJson(api.url + "/api/dashboard/admin/log-loss/fleet?riskState=unsafe");
    const invalidTop = await getJson(api.url + "/api/dashboard/admin/log-loss/fleet?top=zero");
    assert.equal(invalidRisk.status, 400);
    assert.equal(invalidTop.status, 400);
    assert.equal(clickhouse.queries.length, before);
  } finally {
    await api.close();
    await clickhouse.close();
  }
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/admin\/log-loss\/fleet/);
  assert.match(app, /loadFleetLogLoss/);
  assert.match(html, /id="fleet-loss"/);
  assert.match(html, /id="fleetLossRiskDistribution"/);
  assert.match(html, /id="fleetLossTopHosts"/);
});

test("UC-34 persists Admin loss thresholds and applies them to operational alerts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-uc34-"));
  const thresholdFile = join(directory, "thresholds.json");
  const clickhouse = await startMockClickHouse();
  let api = await startApi(clickhouse.url, { env: { HOSTEYE_ALERT_THRESHOLDS_FILE: thresholdFile } });
  try {
    const defaults = await getJson(api.url + "/api/dashboard/admin/log-loss/thresholds");
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.source, "default");
    assert.deepEqual(defaults.body.policy, {
      lossRatioPercent: 1,
      backlogEvents: 100,
      disconnectMinutes: 0,
      interruptionMinutes: 15,
      version: 1,
      updatedAt: null,
      updatedBy: "system-default",
    });

    const saved = await putJson(api.url + "/api/dashboard/admin/log-loss/thresholds", {
      lossRatioPercent: 30,
      backlogEvents: 50,
      disconnectMinutes: 5,
      interruptionMinutes: 60,
      updatedBy: "uc34-test-admin",
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.policy.version, 2);
    assert.equal(saved.body.policy.updatedBy, "uc34-test-admin");

    const alerts = await getJson(api.url + "/api/dashboard/log-loss/alerts?limit=100");
    assert.equal(alerts.status, 200);
    assert.equal(alerts.body.thresholdSource, "file");
    assert.equal(alerts.body.thresholds.lossRatioPercent, 30);
    assert.equal(alerts.body.thresholds.backlogEvents, 50);
    assert.deepEqual(alerts.body.items.map((item) => item.ruleId), ["HE-BACKLOG-001"]);

    const from = new Date(now - 3 * 60 * minute).toISOString();
    const to = new Date(now).toISOString();
    const interruptions = await getJson(`${api.url}/api/dashboard/log-loss/interruptions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    assert.equal(interruptions.status, 200);
    assert.equal(interruptions.body.thresholdMinutes, 60);

    await api.close();
    api = await startApi(clickhouse.url, { env: { HOSTEYE_ALERT_THRESHOLDS_FILE: thresholdFile } });
    const reloaded = await getJson(api.url + "/api/dashboard/admin/log-loss/thresholds");
    assert.equal(reloaded.body.source, "file");
    assert.equal(reloaded.body.policy.version, 2);
    assert.equal(reloaded.body.policy.backlogEvents, 50);
  } finally {
    await api.close();
    await clickhouse.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UC-34 rejects unsafe threshold policies before changing persistent state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-uc34-invalid-"));
  const thresholdFile = join(directory, "thresholds.json");
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url, { env: { HOSTEYE_ALERT_THRESHOLDS_FILE: thresholdFile } });
  try {
    const invalidPolicies = [
      { lossRatioPercent: 101, backlogEvents: 100, disconnectMinutes: 0, interruptionMinutes: 15 },
      { lossRatioPercent: 1, backlogEvents: 0, disconnectMinutes: 0, interruptionMinutes: 15 },
      { lossRatioPercent: 1, backlogEvents: 100, disconnectMinutes: -1, interruptionMinutes: 15 },
      { lossRatioPercent: 1, backlogEvents: 100, disconnectMinutes: 0, interruptionMinutes: 2 },
    ];
    for (const policy of invalidPolicies) {
      const response = await putJson(api.url + "/api/dashboard/admin/log-loss/thresholds", policy);
      assert.equal(response.status, 400);
    }
    const current = await getJson(api.url + "/api/dashboard/admin/log-loss/thresholds");
    assert.equal(current.body.source, "default");
    assert.equal(current.body.policy.version, 1);
  } finally {
    await api.close();
    await clickhouse.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UC-34 exposes responsive Admin threshold controls and configured defaults", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  const css = await readFile(resolve(ROOT, "../HostEyeDashboard/public/styles.css"), "utf8");
  assert.match(app, /\/api\/dashboard\/admin\/log-loss\/thresholds/);
  assert.match(app, /method: "PUT"/);
  assert.match(app, /saveLossAlertThresholds/);
  assert.match(html, /id="lossThresholdForm"/);
  assert.match(html, /id="thresholdLossRatio"/);
  assert.match(html, /id="thresholdBacklogEvents"/);
  assert.match(html, /id="thresholdDisconnectMinutes"/);
  assert.match(html, /id="thresholdInterruptionMinutes"/);
  assert.match(css, /\.threshold-actions/);
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
  assert.match(html, /Windows-generated counts remain empty/);
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
    const agentErrors = await getJson(api.url + "/api/dashboard/agent-errors/summary");
    assert.deepEqual(jitter.body, { source: "registered_config", items: [] });
    assert.deepEqual(chunks.body, { source: "ingest_chunks", items: [] });
    assert.deepEqual(agentErrors.body, { agents: [], source: "agent_chunk_errors" });
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

test("Operational screens use current architecture evidence sources", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /\/api\/dashboard\/agent-errors\/summary/);
  assert.match(app, /source === "registered_config"/);
  assert.match(app, /source === "ingest_chunks"/);
  assert.doesNotMatch(app, /\/api\/v1\/control\/agent\/telemetry\/errors/);
  assert.match(html, /id="jitterEvidenceNote"/);
  assert.match(html, /id="chunkEvidenceNote"/);
  assert.match(html, /id="agentErrorEvidenceNote"/);
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
      { computer: "HOST-ONLINE", agentId: "agent-online", hostId: "host-online", lossMetricsVersion: "2", collectedEventCount: "1200", sentEventCount: "1180", pendingEventCount: "20", droppedEventCount: "0", collectedBySourceJson: JSON.stringify({ "Security\u001f4625": 100, "System\u001f7036": 1100 }), droppedBySourceJson: "{}", unattributedDroppedEventCount: "0", queueUsedMb: "10", maxSpoolBytes: String(1024 * 1024 * 1024), retryCount: "0", admissionDecision: "ok", retryAfterSeconds: "0", admissionMessage: "admitted", metricLastSeen: time(minute) },
      { computer: "HOST-BACKLOG", agentId: "agent-backlog", hostId: "host-backlog", lossMetricsVersion: "2", collectedEventCount: "220", sentEventCount: "130", pendingEventCount: "90", droppedEventCount: "30", collectedBySourceJson: JSON.stringify({ "Security\u001f4625": 50, "Microsoft-Windows-Sysmon/Operational\u001f1": 170 }), droppedBySourceJson: JSON.stringify({ "Security\u001f4625": 10, "Microsoft-Windows-Sysmon/Operational\u001f1": 20 }), unattributedDroppedEventCount: "0", queueUsedMb: "900", maxSpoolBytes: String(1024 * 1024 * 1024), retryCount: "4", admissionDecision: "ng", retryAfterSeconds: "30", admissionMessage: "no healthy collector available", metricLastSeen: time(3 * minute) },
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

async function startApi(clickhouseUrl, options = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), CLICKHOUSE_URL: clickhouseUrl, NODE_ENV: "test", ...(options.env || {}) },
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

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function getText(url) {
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, body: bytes.toString("utf8"), bytes, headers: response.headers };
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
