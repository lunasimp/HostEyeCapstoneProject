import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("UC-01 overview endpoints return backend data and apply consistent filters", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const query = new URLSearchParams({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
      host: "HOST-A",
    });

    const summary = await getJson(api.url + "/api/dashboard/overview/summary?" + query);
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, {
      totalEvents: 12,
      totalHosts: 2,
      totalChannels: 3,
      totalEventIds: 4,
      firstSeen: "2026-07-01 01:00:00.000",
      lastSeen: "2026-07-01 02:00:00.000",
    });

    const volume = await getJson(api.url + "/api/dashboard/overview/log-volume?" + query + "&bucket=hour");
    assert.equal(volume.status, 200);
    assert.equal(volume.body.items.length, 2);

    const hosts = await getJson(api.url + "/api/dashboard/overview/top-hosts?" + query + "&limit=8");
    assert.equal(hosts.status, 200);
    assert.deepEqual(hosts.body.items[0], { computer: "HOST-A", events: 9 });

    const eventTypes = await getJson(api.url + "/api/dashboard/overview/event-types?" + query + "&limit=30");
    assert.equal(eventTypes.status, 200);
    assert.deepEqual(eventTypes.body.items[0], { eventType: "Security: Failed Logon", volume: 4 });

    const timeline = await getJson(api.url + "/api/dashboard/overview/security-timeline?" + query + "&limit=80");
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.items[0].computer, "HOST-A");

    const overviewQueries = clickhouse.queries.filter((sql) => !sql.includes("count() AS rows"));
    assert.equal(overviewQueries.length, 5);
    for (const sql of overviewQueries) {
      assert.match(sql, /2026-07-01T00:00:00\.000Z/);
      assert.match(sql, /2026-07-02T00:00:00\.000Z/);
      assert.match(sql, /computer = 'HOST-A'/);
    }
    assert.match(overviewQueries.find((sql) => sql.includes("GROUP BY time")), /toStartOfHour/);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-01 empty ClickHouse results produce deterministic zero and empty states", async () => {
  const clickhouse = await startMockClickHouse({ mode: "empty" });
  const api = await startApi(clickhouse.url);

  try {
    const summary = await getJson(api.url + "/api/dashboard/overview/summary");
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, {
      totalEvents: 0,
      totalHosts: 0,
      totalChannels: 0,
      totalEventIds: 0,
      firstSeen: null,
      lastSeen: null,
    });

    for (const path of [
      "/api/dashboard/overview/log-volume",
      "/api/dashboard/overview/top-hosts",
      "/api/dashboard/overview/event-types",
      "/api/dashboard/overview/security-timeline",
    ]) {
      const response = await getJson(api.url + path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { items: [] });
    }
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-01 rejects invalid overview filters before querying ClickHouse", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const before = clickhouse.queries.length;
    const cases = [
      ["/api/dashboard/overview/summary?from=not-a-date", "from must be a valid date"],
      ["/api/dashboard/overview/summary?from=2026-07-03T00:00:00Z&to=2026-07-02T00:00:00Z", "from must be earlier"],
      ["/api/dashboard/overview/log-volume?bucket=week", "bucket must be one of"],
      ["/api/dashboard/overview/top-hosts?limit=2abc", "limit must be a positive integer"],
      ["/api/dashboard/overview/summary?eventId=4x", "eventId must be a non-negative integer"],
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

test("UC-01 reports ClickHouse query failures without returning fabricated data", async () => {
  const clickhouse = await startMockClickHouse({ mode: "error" });
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(api.url + "/api/dashboard/overview/summary");
    assert.equal(response.status, 502);
    assert.equal(response.body.message, "ClickHouse query failed");
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-01 reports ClickHouse outages as an explicit service-unavailable response", async () => {
  const unreachablePort = await freePort();
  const api = await startApi("http://127.0.0.1:" + unreachablePort);

  try {
    const response = await getJson(api.url + "/api/dashboard/overview/summary");
    assert.equal(response.status, 503);
    assert.equal(response.body.message, "ClickHouse is not reachable");
  } finally {
    await api.close();
  }
});

test("UC-01 dashboard UI uses HostEye terminology and never activates demo fallback", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");

  assert.match(app, /\[ HOSTEYE OVERVIEW \]/);
  assert.doesNotMatch(app, /renderDemoDashboard/);
  assert.match(app, /setStatus\("API offline"/);
  assert.match(app, /resetKpis\(\)/);
  assert.match(app, /renderErrorEverywhere\(error\.message/);
  assert.match(html, /<title>HostEye Dashboard<\/title>/);
  assert.match(html, /<strong>HostEye Overview<\/strong>/);
  assert.doesNotMatch(html, /SOC Overview|HostEye SOC Dashboard/);
});

async function startMockClickHouse(options = {}) {
  const state = {
    mode: options.mode || "data",
    queries: [],
  };

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
  const address = server.address();
  return {
    url: "http://127.0.0.1:" + address.port,
    queries: state.queries,
    close: () => closeServer(server),
  };
}

function rowsForEmptyQuery(sql) {
  if (sql.includes("uniqExact(computer) AS totalHosts")) {
    return [{
      totalEvents: "0",
      totalHosts: "0",
      totalChannels: "0",
      totalEventIds: "0",
      firstSeen: "1970-01-01 00:00:00.000",
      lastSeen: "1970-01-01 00:00:00.000",
    }];
  }
  return [];
}

function rowsForQuery(sql) {
  if (sql.includes("count() AS rows")) return [{ rows: "12" }];
  if (sql.includes("uniqExact(computer) AS totalHosts")) {
    return [{
      totalEvents: "12",
      totalHosts: "2",
      totalChannels: "3",
      totalEventIds: "4",
      firstSeen: "2026-07-01 01:00:00.000",
      lastSeen: "2026-07-01 02:00:00.000",
    }];
  }
  if (sql.includes("GROUP BY time")) {
    return [
      { time: "2026-07-01 01:00:00.000", events: 5 },
      { time: "2026-07-01 02:00:00.000", events: 7 },
    ];
  }
  if (sql.includes("GROUP BY computer")) {
    return [
      { computer: "HOST-A", events: 9 },
      { computer: "HOST-B", events: 3 },
    ];
  }
  if (sql.includes("event_type AS eventType, count() AS volume")) {
    return [{ eventType: "Security: Failed Logon", volume: 4 }];
  }
  if (sql.includes("left(message, 300) AS message")) {
    return [{
      time: "2026-07-01 02:00:00.000",
      computer: "HOST-A",
      eventType: "Security: Failed Logon",
      channel: "Security",
      eventId: 4625,
      userName: "demo-user",
      processPath: "",
      sourceIp: "10.0.0.10",
      destinationIp: "",
      message: "Mock event",
    }];
  }
  return [];
}

async function startApi(clickhouseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      CLICKHOUSE_URL: clickhouseUrl,
      NODE_ENV: "test",
    },
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
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
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
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
