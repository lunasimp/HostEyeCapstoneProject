import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RANGE = "from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-02T00%3A00%3A00.000Z";

test("UC-06 returns rule-based alerts with severity summary", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(api.url + "/api/alerts?" + RANGE + "&host=HOST-A&limit=20");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.summary, {
      total: 3,
      critical: 1,
      high: 1,
      medium: 1,
      low: 0,
    });
    assert.equal(response.body.total, 3);
    assert.equal(response.body.items.length, 3);
    assert.deepEqual(response.body.items.map((item) => item.ruleId), [
      "HE-PROC-001",
      "HE-PS-001",
      "HE-AUTH-001",
    ]);
    assert.equal(response.body.items[0].severity, "critical");
    assert.equal(response.body.items[2].evidenceCount, 7);
    assert.equal(response.body.filters.host, "HOST-A");

    assert.equal(clickhouse.queries.length, 4);
    for (const sql of clickhouse.queries) {
      assert.match(sql, /computer = 'HOST-A'/);
      assert.match(sql, /2026-07-01T00:00:00\.000Z/);
      assert.match(sql, /2026-07-02T00:00:00\.000Z/);
    }
    assert.ok(clickhouse.queries.some((sql) => sql.includes("event_id IN (8, 25)")));
    assert.ok(clickhouse.queries.some((sql) => sql.includes("HAVING evidenceCount >= 5")));
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-06 supports deterministic empty and paginated alert lists", async () => {
  const emptyClickHouse = await startMockClickHouse({ mode: "empty" });
  const emptyApi = await startApi(emptyClickHouse.url);
  try {
    const response = await getJson(emptyApi.url + "/api/alerts?" + RANGE);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items, []);
    assert.equal(response.body.total, 0);
    assert.equal(response.body.hasMore, false);
  } finally {
    await emptyApi.close();
    await emptyClickHouse.close();
  }

  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/alerts?" + RANGE + "&limit=1&offset=1");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 1);
    assert.equal(response.body.items[0].ruleId, "HE-PS-001");
    assert.equal(response.body.offset, 1);
    assert.equal(response.body.hasMore, true);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-06 rejects invalid list parameters before querying ClickHouse", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const before = clickhouse.queries.length;
    const cases = [
      ["/api/alerts?from=invalid", "from must be a valid date"],
      ["/api/alerts?from=2026-07-03T00:00:00Z&to=2026-07-02T00:00:00Z", "from must be earlier"],
      ["/api/alerts?limit=0", "limit must be a positive integer"],
      ["/api/alerts?offset=-1", "offset must be a non-negative integer"],
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

test("UC-06 reports ClickHouse errors and outages without fabricated alerts", async () => {
  const clickhouse = await startMockClickHouse({ mode: "error" });
  const api = await startApi(clickhouse.url);
  try {
    const response = await getJson(api.url + "/api/alerts?" + RANGE);
    assert.equal(response.status, 502);
    assert.equal(response.body.message, "ClickHouse query failed");
  } finally {
    await api.close();
    await clickhouse.close();
  }

  const unreachablePort = await freePort();
  const outageApi = await startApi("http://127.0.0.1:" + unreachablePort);
  try {
    const response = await getJson(outageApi.url + "/api/alerts?" + RANGE);
    assert.equal(response.status, 503);
    assert.equal(response.body.message, "ClickHouse is not reachable");
  } finally {
    await outageApi.close();
  }
});

test("UC-06 Dashboard exposes alert totals and a paginated alert table", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  const css = await readFile(resolve(ROOT, "../HostEyeDashboard/public/styles.css"), "utf8");

  assert.match(html, /href="#alerts"/);
  assert.match(html, /id="alertTotal"/);
  assert.match(html, /id="alertCritical"/);
  assert.match(html, /id="alertHigh"/);
  assert.match(html, /id="alertsTable"/);
  assert.match(html, /id="alertsPrev"/);
  assert.match(html, /id="alertsNext"/);
  assert.match(app, /\/api\/alerts/);
  assert.match(app, /renderAlertTable/);
  assert.match(app, /alertRequestId/);
  assert.match(css, /\.severity-critical/);
  assert.doesNotMatch(app, /renderDemoDashboard/);
});

test("UC-06 Docker integration detects alerts from real ClickHouse telemetry", {
  skip: process.env.HOSTEYE_CLICKHOUSE_INTEGRATION !== "1",
}, async () => {
  const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://127.0.0.1:8123";
  const suffix = Date.now().toString(36);
  const host = `UC06-DOCKER-${suffix}`;
  const keyPrefix = `uc06-docker-${suffix}`;
  const now = new Date();
  const from = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const timestamp = clickhouseDate(now);

  const rows = [
    {
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "Microsoft-Windows-Sysmon/Operational",
      event_id: 25,
      level: "Critical",
      message: "Process tampering detected by Sysmon",
      idempotency_key: keyPrefix + "-tamper",
    },
    {
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "Microsoft-Windows-Sysmon/Operational",
      event_id: 8,
      level: "Information",
      message: "CreateRemoteThread detected by Sysmon",
      idempotency_key: keyPrefix + "-thread",
    },
    {
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "Microsoft-Windows-Sysmon/Operational",
      event_id: 1,
      level: "Information",
      message: "Benign process create",
      idempotency_key: keyPrefix + "-benign",
    },
  ];
  for (let index = 0; index < 6; index++) {
    rows.push({
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "Security",
      event_id: 4625,
      level: "Information",
      user_name: "uc06-user",
      source_ip: "10.60.0.10",
      message: "An account failed to log on",
      idempotency_key: keyPrefix + "-failed-" + index,
    });
  }

  await clickhouseRequest(
    clickhouseUrl,
    "INSERT INTO default.windows_system_logs FORMAT JSONEachRow\n"
      + rows.map((row) => JSON.stringify(row)).join("\n"),
  );

  const api = await startApi(clickhouseUrl);
  try {
    const response = await getJson(
      api.url + "/api/alerts?" + new URLSearchParams({ from, to, host, limit: "20" }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 3);
    assert.deepEqual(new Set(response.body.items.map((item) => item.ruleId)), new Set([
      "HE-PROC-001",
      "HE-PROC-002",
      "HE-AUTH-001",
    ]));
    assert.equal(response.body.summary.critical, 1);
    assert.equal(response.body.summary.high, 1);
    assert.equal(response.body.summary.medium, 1);
    assert.ok(!response.body.items.some((item) => item.idempotencyKey === keyPrefix + "-benign"));
  } finally {
    await api.close();
    await clickhouseRequest(
      clickhouseUrl,
      `ALTER TABLE default.windows_system_logs DELETE WHERE idempotency_key LIKE '${keyPrefix}%' SETTINGS mutations_sync = 1`,
    );
  }
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

    const rows = state.mode === "empty" ? [] : rowsForQuery(body);
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

function rowsForQuery(sql) {
  if (sql.includes("concat('event:', idempotency_key)")) {
    return [
      {
        alertId: "event:tamper",
        detectedAt: "2026-07-01 03:00:00.000",
        severity: "critical",
        ruleId: "HE-PROC-001",
        title: "Process tampering detected",
        status: "new",
        computer: "HOST-A",
        agentId: "agent-a",
        hostId: "host-a",
        channel: "Microsoft-Windows-Sysmon/Operational",
        eventId: "25",
        userName: "",
        sourceIp: "",
        processPath: "C:\\malware.exe",
        message: "Process tampering",
        evidenceCount: "1",
        idempotencyKey: "tamper",
      },
      {
        alertId: "event:ps",
        detectedAt: "2026-07-01 02:00:00.000",
        severity: "high",
        ruleId: "HE-PS-001",
        title: "Suspicious PowerShell content",
        status: "new",
        computer: "HOST-A",
        agentId: "agent-a",
        hostId: "host-a",
        channel: "Microsoft-Windows-PowerShell/Operational",
        eventId: "4104",
        userName: "demo",
        sourceIp: "",
        processPath: "powershell.exe",
        message: "Invoke-Expression",
        evidenceCount: "1",
        idempotencyKey: "ps",
      },
    ];
  }
  if (sql.includes("GROUP BY severity") && sql.includes("event_id IN (8, 25)")) {
    return [{ severity: "critical", total: "1" }, { severity: "high", total: "1" }];
  }
  if (sql.includes("concat(") && sql.includes("'HE-AUTH-001:'")) {
    return [{
      alertId: "HE-AUTH-001:ABC",
      detectedAt: "2026-07-01 01:00:00.000",
      severity: "medium",
      ruleId: "HE-AUTH-001",
      title: "Repeated failed logons",
      status: "new",
      computer: "HOST-A",
      agentId: "agent-a",
      hostId: "host-a",
      channel: "Security",
      eventId: "4625",
      userName: "demo",
      sourceIp: "10.0.0.10",
      processPath: "",
      message: "7 failed logons within 5 minutes",
      evidenceCount: "7",
      idempotencyKey: "",
    }];
  }
  if (sql.includes("SELECT severity, count() AS total") && sql.includes("toStartOfFiveMinutes")) {
    return [{ severity: "medium", total: "1" }];
  }
  return [];
}

function clickhouseDate(date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

async function clickhouseRequest(baseUrl, query) {
  const response = await fetch(baseUrl.replace(/\/$/, "") + "/?database=default", {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: query,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${text}`);
  return text;
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