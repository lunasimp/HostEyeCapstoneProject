import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Enrollment permissions separate inventory access from token and revoke operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-enrollment-"));
  const registration = await startMockRegistration();
  const clickhouse = await startMockClickHouse();
  const api = await startApi(join(directory, "users.json"), clickhouse.url, registration.url);
  try {
    const admin = await login(api.url, "admin", "enrollment-admin-password");
    await createUser(api.url, admin, {
      username: "enrollment.reader", displayName: "Enrollment Reader", role: "user",
      password: "enrollment-reader-password", permissions: ["dashboard:view", "enrollment:read"],
      scopes: { hosts: ["HOST-A"], agents: ["agent-a"], groups: ["group-a"] },
    });
    await createUser(api.url, admin, {
      username: "enrollment.operator", displayName: "Enrollment Operator", role: "user",
      password: "enrollment-operator-password", permissions: ["dashboard:view", "enrollment:read", "enrollment:write"],
      scopes: { hosts: [], agents: [], groups: [] },
    });

    const reader = await login(api.url, "enrollment.reader", "enrollment-reader-password");
    const summary = await requestJson(api.url + "/api/dashboard/registrations/summary", { token: reader });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.totals.devices, 1);
    assert.equal(summary.body.items[0].ciId, "ci-device-a");
    assert.equal(summary.body.items[0].actualHostname, "HOST-A");
    assert.equal((await requestJson(api.url + "/api/dashboard/admin/enrollment-tokens", {
      method: "POST", token: reader, body: { expectedHostname: "HOST-C" },
    })).status, 403);
    assert.equal((await requestJson(api.url + "/api/dashboard/admin/enrolled-devices/device-a/revoke", {
      method: "POST", token: reader, body: { reason: "reader must not revoke" },
    })).status, 403);

    const operator = await login(api.url, "enrollment.operator", "enrollment-operator-password");
    const created = await requestJson(api.url + "/api/dashboard/admin/enrollment-tokens", {
      method: "POST", token: operator,
      body: { expectedHostname: "HOST-C", groupId: "group-c", policyId: "policy-c", ttlMinutes: 15 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ciId, "ci-new-device");
    assert.equal(created.body.token, "one-time-enrollment-token");
    assert.equal(created.body.adminToken, undefined);

    const revoked = await requestJson(api.url + "/api/dashboard/admin/enrolled-devices/device-a/revoke", {
      method: "POST", token: operator, body: { reason: "certificate replacement" },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status, "Revoked");
    assert.deepEqual(registration.requests.map((item) => [item.method, item.path, item.actor]), [
      ["GET", "/api/v1/admin/devices", ""],
      ["POST", "/api/v1/admin/tokens", "enrollment.operator"],
      ["POST", "/api/v1/admin/devices/device-a/revoke", "enrollment.operator"],
    ]);
    assert.ok(registration.requests.every((item) => item.adminToken === "registration-test-admin-token"));
  } finally {
    await api.close();
    await clickhouse.close();
    await registration.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Dashboard exposes the complete C_i enrollment workflow", async () => {
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  assert.match(html, /data-page="enrollment"/);
  assert.match(html, /id="enrollmentTokenForm"/);
  assert.match(html, /id="enrollmentDevicesTable"/);
  assert.match(app, /enrollment:read/);
  assert.match(app, /enrollment:write/);
  assert.match(app, /\/api\/dashboard\/admin\/enrollment-tokens/);
  assert.match(app, /\/api\/dashboard\/admin\/enrolled-devices\/\$\{encodeURIComponent\([^)]*\)\}\/revoke/);
  assert.match(app, /\/ENROLLMENTTOKEN=/);
});

async function startMockRegistration() {
  const requests = [];
  const devices = [
    { deviceRecordId: "device-a", ciId: "ci-device-a", agentId: "agent-a", hostId: "host-a", actualHostname: "HOST-A", groupId: "group-a", status: "Active", updatedAt: "2026-08-15T01:00:00.000Z" },
    { deviceRecordId: "device-b", ciId: "ci-device-b", agentId: "agent-b", hostId: "host-b", actualHostname: "HOST-B", groupId: "group-b", status: "Active", updatedAt: "2026-08-15T00:00:00.000Z" },
  ];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      requests.push({ method: req.method, path: req.url, actor: String(req.headers["x-hosteye-actor"] || ""), adminToken: String(req.headers["x-hosteye-admin-token"] || ""), body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/v1/admin/devices") return res.end(JSON.stringify(devices));
      if (req.method === "POST" && req.url === "/api/v1/admin/tokens") {
        res.writeHead(201);
        return res.end(JSON.stringify({ token: "one-time-enrollment-token", ciId: "ci-new-device", expectedHostname: body.expectedHostname, expiresAt: "2026-08-15T02:00:00.000Z" }));
      }
      if (req.method === "POST" && req.url === "/api/v1/admin/devices/device-a/revoke") return res.end(JSON.stringify({ ...devices[0], status: "Revoked", revokeReason: body.reason }));
      res.writeHead(404);
      res.end(JSON.stringify({ message: "not found" }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function startMockClickHouse() {
  const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(""); });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolveClose) => server.close(resolveClose)) };
}

async function startApi(usersFile, clickhouseUrl, registrationUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: "test", CLICKHOUSE_URL: clickhouseUrl,
      HOSTEYE_REGISTRATION_URL: registrationUrl,
      HOSTEYE_REGISTRATION_ADMIN_TOKEN: "registration-test-admin-token",
      HOSTEYE_DASHBOARD_AUTH_REQUIRED: "true", HOSTEYE_DASHBOARD_USERS_FILE: usersFile,
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME: "admin",
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD: "enrollment-admin-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Dashboard API exited: " + output);
    try { if ((await fetch(url + "/api/dashboard/auth/status")).ok) return { url, close: async () => { if (child.exitCode === null) child.kill(); await new Promise((resolveClose) => child.once("exit", resolveClose)); } }; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  }
  child.kill();
  throw new Error("Dashboard API did not start: " + output);
}

async function createUser(url, token, body) {
  const response = await requestJson(url + "/api/dashboard/admin/users", { method: "POST", token, body });
  assert.equal(response.status, 201);
}

async function login(url, username, password) {
  const response = await requestJson(url + "/api/dashboard/auth/login", { method: "POST", body: { username, password } });
  assert.equal(response.status, 200);
  return response.body.token;
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
