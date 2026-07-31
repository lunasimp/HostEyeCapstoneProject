import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FILTER_RANGE = "from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-02T00%3A00%3A00.000Z";

test("UC-03 searches by keyword and combines host, channel, Event ID and time filters", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(
      api.url + "/api/logs/search?" + FILTER_RANGE
      + "&q=failed%20logon&host=HOST-A&channel=Security&eventId=4625&limit=2&offset=0",
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.limit, 2);
    assert.equal(response.body.offset, 0);
    assert.equal(response.body.hasMore, true);
    assert.equal(response.body.items.length, 2);
    assert.equal(response.body.items[0].computer, "HOST-A");
    assert.deepEqual(response.body.filters, {
      q: "failed logon",
      host: "HOST-A",
      channel: "Security",
      eventId: "4625",
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-02T00:00:00.000Z",
    });

    assert.equal(clickhouse.queries.length, 2);
    for (const sql of clickhouse.queries) {
      assert.match(sql, /positionCaseInsensitive\(message, 'failed logon'\)/);
      assert.match(sql, /computer = 'HOST-A'/);
      assert.match(sql, /channel = 'Security'/);
      assert.match(sql, /event_id = 4625/);
      assert.match(sql, /2026-07-01T00:00:00\.000Z/);
      assert.match(sql, /2026-07-02T00:00:00\.000Z/);
    }
    assert.match(clickhouse.queries.find((sql) => sql.includes("ORDER BY")), /LIMIT 2\s+OFFSET 0/);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-03 supports filter-only search and pagination without a keyword", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(
      api.url + "/api/logs/search?" + FILTER_RANGE + "&channel=System&limit=2&offset=2",
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.items.length, 1);
    assert.equal(response.body.items[0].idempotencyKey, "log-3");
    assert.equal(response.body.hasMore, false);
    assert.equal(response.body.filters.q, "");
    assert.ok(clickhouse.queries.every((sql) => !sql.includes("positionCaseInsensitive")));
    assert.ok(clickhouse.queries.every((sql) => sql.includes("channel = 'System'")));
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-03 empty results return deterministic pagination metadata", async () => {
  const clickhouse = await startMockClickHouse({ mode: "empty" });
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(api.url + "/api/logs/search?" + FILTER_RANGE + "&q=missing&limit=50");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.items, []);
    assert.equal(response.body.total, 0);
    assert.equal(response.body.limit, 50);
    assert.equal(response.body.offset, 0);
    assert.equal(response.body.hasMore, false);
  } finally {
    await api.close();
    await clickhouse.close();
  }
});

test("UC-03 rejects malformed filters before querying ClickHouse", async () => {
  const clickhouse = await startMockClickHouse();
  const api = await startApi(clickhouse.url);

  try {
    const before = clickhouse.queries.length;
    const cases = [
      ["/api/logs/search?eventId=46x", "eventId must be a non-negative integer"],
      ["/api/logs/search?from=not-a-date", "from must be a valid date"],
      ["/api/logs/search?from=2026-07-03T00:00:00Z&to=2026-07-02T00:00:00Z", "from must be earlier"],
      ["/api/logs/search?limit=0", "limit must be a positive integer"],
      ["/api/logs/search?offset=-1", "offset must be a non-negative integer"],
      ["/api/logs/search?offset=100001", "offset must be between 0 and 100000"],
      ["/api/logs/search?q=" + "x".repeat(201), "q must be at most 200 characters"],
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

test("UC-03 reports ClickHouse query errors and outages without fake results", async () => {
  const clickhouse = await startMockClickHouse({ mode: "error" });
  const api = await startApi(clickhouse.url);

  try {
    const response = await getJson(api.url + "/api/logs/search?" + FILTER_RANGE + "&q=test");
    assert.equal(response.status, 502);
    assert.equal(response.body.message, "ClickHouse query failed");
  } finally {
    await api.close();
    await clickhouse.close();
  }

  const unreachablePort = await freePort();
  const outageApi = await startApi("http://127.0.0.1:" + unreachablePort);
  try {
    const response = await getJson(outageApi.url + "/api/logs/search?" + FILTER_RANGE);
    assert.equal(response.status, 503);
    assert.equal(response.body.message, "ClickHouse is not reachable");
  } finally {
    await outageApi.close();
  }
});

test("UC-03 Dashboard exposes a complete log-search workflow", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");

  assert.match(html, /href="#search"/);
  assert.match(html, /id="logSearchForm"/);
  assert.match(html, /id="searchKeyword"/);
  assert.match(html, /id="searchHost"/);
  assert.match(html, /id="searchChannel"/);
  assert.match(html, /id="searchEventId"/);
  assert.match(html, /id="searchFrom"/);
  assert.match(html, /id="searchTo"/);
  assert.match(html, /id="searchPrev"/);
  assert.match(html, /id="searchNext"/);
  assert.match(app, /\/api\/logs\/search/);
  assert.match(app, /renderLogSearch/);
  assert.match(app, /searchRequestId/);
  assert.doesNotMatch(app, /renderDemoDashboard/);
});

test("UC-03 Docker integration searches real ClickHouse rows", {
  skip: process.env.HOSTEYE_CLICKHOUSE_INTEGRATION !== "1",
}, async () => {
  const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://127.0.0.1:8123";
  const suffix = Date.now().toString(36);
  const host = `UC03-DOCKER-${suffix}`;
  const keyPrefix = `uc03-docker-${suffix}`;
  const now = new Date();
  const from = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const to = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  const timestamp = clickhouseDate(now);

  const rows = [
    {
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "Security",
      event_id: 4625,
      level: "Information",
      user_name: "uc03-user",
      process_path: "C:\\Windows\\System32\\winlogon.exe",
      message: "UC03 Docker probe failed logon",
      source_ip: "10.20.30.40",
      idempotency_key: keyPrefix + "-1",
    },
    {
      kafka_timestamp: timestamp,
      timestamp,
      computer: host,
      channel: "System",
      event_id: 7036,
      level: "Information",
      message: "UC03 Docker probe HostEyeAgent running",
      idempotency_key: keyPrefix + "-2",
    },
  ];

  await clickhouseRequest(
    clickhouseUrl,
    "INSERT INTO default.windows_system_logs FORMAT JSONEachRow\n"
      + rows.map((row) => JSON.stringify(row)).join("\n"),
  );

  const api = await startApi(clickhouseUrl);
  try {
    const keyword = await getJson(
      api.url + "/api/logs/search?"
      + new URLSearchParams({ from, to, q: "Docker probe", host, limit: "20" }),
    );
    assert.equal(keyword.status, 200);
    assert.equal(keyword.body.total, 2);
    assert.equal(keyword.body.items.length, 2);

    const filtered = await getJson(
      api.url + "/api/logs/search?"
      + new URLSearchParams({ from, to, host, channel: "Security", eventId: "4625" }),
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.items[0].idempotencyKey, keyPrefix + "-1");
  } finally {
    await api.close();
    await clickhouseRequest(
      clickhouseUrl,
      `ALTER TABLE default.windows_system_logs DELETE WHERE idempotency_key LIKE '${keyPrefix}%' SETTINGS mutations_sync = 1`,
    );
  }
});

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

    let rows = [];
    if (state.mode !== "empty") {
      if (/SELECT\s+count\(\) AS total/.test(body)) {
        rows = [{ total: "3" }];
      } else if (body.includes("OFFSET 2")) {
        rows = [searchRows()[2]];
      } else {
        rows = searchRows().slice(0, 2);
      }
    }

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

function searchRows() {
  return [
    {
      time: "2026-07-01 03:00:00.000",
      computer: "HOST-A",
      channel: "Security",
      eventId: 4625,
      level: "Information",
      providerName: "Microsoft-Windows-Security-Auditing",
      userName: "demo-user",
      processPath: "C:\\Windows\\System32\\winlogon.exe",
      commandLine: "",
      sourceIp: "10.0.0.10",
      destinationIp: "",
      dnsQuery: "",
      targetFilename: "",
      targetObject: "",
      message: "An account failed to log on",
      idempotencyKey: "log-1",
    },
    {
      time: "2026-07-01 02:00:00.000",
      computer: "HOST-A",
      channel: "Security",
      eventId: 4625,
      level: "Information",
      providerName: "Microsoft-Windows-Security-Auditing",
      userName: "other-user",
      processPath: "",
      commandLine: "",
      sourceIp: "10.0.0.11",
      destinationIp: "",
      dnsQuery: "",
      targetFilename: "",
      targetObject: "",
      message: "Failed logon attempt",
      idempotencyKey: "log-2",
    },
    {
      time: "2026-07-01 01:00:00.000",
      computer: "HOST-B",
      channel: "System",
      eventId: 7036,
      level: "Information",
      providerName: "Service Control Manager",
      userName: "",
      processPath: "",
      commandLine: "",
      sourceIp: "",
      destinationIp: "",
      dnsQuery: "",
      targetFilename: "",
      targetObject: "",
      message: "The HostEyeAgent service entered the running state",
      idempotencyKey: "log-3",
    },
  ];
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