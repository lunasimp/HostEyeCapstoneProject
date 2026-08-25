import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("UC-37 enforces function permissions and host/agent SQL scopes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-uc37-"));
  const clickhouse = await startMockClickHouse();
  const api = await startApi(join(directory, "users.json"), clickhouse.url);
  try {
    const status = await requestJson(api.url + "/api/dashboard/auth/status");
    assert.equal(status.status, 200);
    assert.ok(status.body.permissions.includes("users:manage"));

    const adminLogin = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST", body: { username: "admin", password: "uc37-admin-password" },
    });
    const adminToken = adminLogin.body.token;
    const created = await requestJson(api.url + "/api/dashboard/admin/users", {
      method: "POST", token: adminToken,
      body: {
        username: "scoped.reader", displayName: "Scoped Reader", role: "viewer",
        password: "scoped-reader-password", permissions: ["dashboard:view", "telemetry:read"],
        scopes: { hosts: ["HOST-A"], agents: ["agent-a"], groups: ["group-a"] },
      },
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.user.scopes.hosts, ["HOST-A"]);

    const login = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST", body: { username: "scoped.reader", password: "scoped-reader-password" },
    });
    const token = login.body.token;
    assert.equal((await requestJson(api.url + "/api/alerts", { token })).status, 403);
    assert.equal((await requestJson(api.url + "/api/dashboard/admin/users", { token })).status, 403);
    assert.equal((await requestJson(api.url + "/api/logs/search?host=HOST-B", { token })).status, 403);

    const allowed = await requestJson(api.url + "/api/logs/search?host=HOST-A&from=2026-08-01T00:00:00.000Z&to=2026-08-07T00:00:00.000Z", { token });
    assert.equal(allowed.status, 200);
    const scopedQueries = clickhouse.queries.filter((sql) => sql.includes("FROM default.windows_system_logs"));
    assert.ok(scopedQueries.some((sql) => sql.includes("computer IN ('HOST-A')")));
    assert.ok(scopedQueries.some((sql) => sql.includes("agent_id IN ('agent-a')")));

    const forbiddenWrite = await requestJson(api.url + "/api/dashboard/dynamic-config/policies", {
      method: "POST", token, body: {},
    });
    assert.equal(forbiddenWrite.status, 403);
    await requestJson(api.url + "/api/dashboard/admin/users", {
      method: "POST", token: adminToken,
      body: {
        username: "config.operator", displayName: "Config Operator", role: "user",
        password: "config-operator-password", permissions: ["config:read", "config:write"],
        scopes: { hosts: [], agents: [], groups: ["group-a"] },
      },
    });
    const configLogin = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST", body: { username: "config.operator", password: "config-operator-password" },
    });
    const configToken = configLogin.body.token;
    const globalAssignment = await requestJson(api.url + "/api/dashboard/dynamic-config/assignments", {
      method: "POST", token: configToken, body: { policyId: "draft-a", targetType: "default" },
    });
    assert.equal(globalAssignment.status, 403);
    const outsideGroup = await requestJson(api.url + "/api/dashboard/dynamic-config/assignments", {
      method: "POST", token: configToken, body: { policyId: "draft-a", targetType: "group", targetValue: "group-b" },
    });
    assert.equal(outsideGroup.status, 403);

    const invalidPermission = await requestJson(api.url + "/api/dashboard/admin/users", {
      method: "POST", token: adminToken,
      body: { username: "invalid.permission", displayName: "Invalid", role: "user", password: "invalid-user-password", permissions: ["root:anywhere"] },
    });
    assert.equal(invalidPermission.status, 400);
  } finally {
    await api.close();
    await clickhouse.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UC-37 Dashboard exposes role, permission, and data-scope controls", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  assert.match(app, /applyNavigationPermissions/);
  assert.match(app, /scopeHosts/);
  assert.match(app, /Bearer \$\{state\.auth\.token\}/);
  assert.match(html, /value="viewer"/);
  assert.match(html, /id="newUserPermissions"/);
  assert.match(html, /id="newUserScopeGroups"/);
});

test("Heatmap detail forwards the Dashboard session and handles expiration", async () => {
  const detail = await readFile(resolve(ROOT, "../HostEyeDashboard/public/detail.js"), "utf8");
  assert.match(detail, /localStorage\.getItem\("hosteyeDashboardSession"\)/);
  assert.match(detail, /authorization: `Bearer \$\{token\}`/);
  assert.match(detail, /response\.status === 401/);
  assert.match(detail, /localStorage\.removeItem\("hosteyeDashboardSession"\)/);
  assert.match(detail, /index\.html#heatmap/);
});

test("Dashboard static UI does not contain Vietnamese copy", async () => {
  const files = ["index.html", "detail.html", "app.js", "detail.js"];
  const content = (await Promise.all(files.map((name) =>
    readFile(resolve(ROOT, `../HostEyeDashboard/public/${name}`), "utf8")
  ))).join("\n");
  assert.doesNotMatch(content, /[^\x00-\x7F]/);
  assert.doesNotMatch(content, /\b(?:Giam sat|Thong ke|Cau hinh|May tram|Trang thai|Chi tiet|Khong|Chua|Dang|Nguyen nhan|Pham vi|Cap nhat|Bat dau|Ket thuc|Khoi phuc|Canh bao|Ty le|Da mat|Cho gui)\b/i);
});

async function startMockClickHouse() {
  const queries = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const sql = decodeURIComponent(String(req.url || "").split("query=")[1] || "") || body;
      queries.push(sql);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(sql.includes("count() AS total") ? '{"total":"0"}\n' : "");
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { url: `http://127.0.0.1:${server.address().port}`, queries, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function startApi(usersFile, clickhouseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: "test", CLICKHOUSE_URL: clickhouseUrl,
      HOSTEYE_DASHBOARD_AUTH_REQUIRED: "true", HOSTEYE_DASHBOARD_USERS_FILE: usersFile,
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME: "admin",
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD: "uc37-admin-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Dashboard API exited: " + output);
    try {
      const response = await fetch(url + "/api/dashboard/auth/status");
      if (response.ok) return { url, close: async () => { if (child.exitCode === null) child.kill(); await new Promise((resolveClose) => child.once("exit", resolveClose)); } };
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  child.kill();
  throw new Error("Dashboard API did not start: " + output);
}

async function requestJson(url, options = {}) {
  const headers = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, { method: options.method || "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolvePort(address.port)); });
    server.on("error", reject);
  });
}
