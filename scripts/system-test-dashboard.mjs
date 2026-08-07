import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const baseUrl = process.env.HOSTEYE_TEST_API_URL || "http://127.0.0.1:5065";
const output = process.env.HOSTEYE_TEST_OUTPUT || "docs/test-evidence/ST-20260807-HOSTEYE-02/st03-dashboard-system.json";
const adminUsername = process.env.HOSTEYE_TEST_ADMIN_USERNAME || "admin";
const adminPassword = process.env.HOSTEYE_TEST_ADMIN_PASSWORD;
if (!adminPassword) throw new Error("HOSTEYE_TEST_ADMIN_PASSWORD is required");
const suffix = new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const result = {
  runId: "ST-20260807-HOSTEYE-02",
  capturedAt: new Date().toISOString(),
  api: baseUrl,
  checks: [],
};

function record(id, response, details = {}) {
  result.checks.push({ id, status: response.status, passed: response.status >= 200 && response.status < 300, ...details });
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(baseUrl + path, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

const login = await request("/api/dashboard/auth/login", {
  method: "POST",
  body: { username: adminUsername, password: adminPassword },
});
record("auth.admin.login", login, { role: login.body?.user?.role });
if (login.status !== 200 || !login.body?.token) throw new Error(`Administrator login failed: ${login.status}`);
const adminToken = login.body.token;

const health = await request("/api/health");
record("infrastructure.dashboard-api", health, {
  rows: health.body?.rows,
  latestSeen: health.body?.latestSeen,
  stale: health.body?.stale,
});

const endpoints = [
  ["dashboard.overview", "/api/dashboard/overview/summary"],
  ["dashboard.hosts", "/api/dashboard/hosts/summary?limit=50"],
  ["dashboard.search", "/api/logs/search?limit=5"],
  ["dashboard.alerts", "/api/alerts?limit=5"],
  ["loss.summary", "/api/dashboard/log-loss/summary"],
  ["loss.hosts", "/api/dashboard/log-loss/hosts?limit=50"],
  ["loss.interruptions", "/api/dashboard/log-loss/interruptions?thresholdMinutes=15&limit=50"],
  ["loss.retry-backlog", "/api/dashboard/log-loss/retry-backlog?limit=50"],
  ["loss.alerts", "/api/dashboard/log-loss/alerts?limit=50"],
  ["admin.fleet-loss", "/api/dashboard/admin/log-loss/fleet?limit=50"],
  ["admin.loss-thresholds", "/api/dashboard/admin/log-loss/thresholds"],
  ["config.catalog", "/api/dashboard/dynamic-config/catalog"],
  ["config.summary", "/api/dashboard/dynamic-config/summary"],
  ["config.policies", "/api/dashboard/dynamic-config/policies"],
  ["config.status", "/api/dashboard/dynamic-config/config-status"],
  ["config.audit", "/api/dashboard/dynamic-config/audit"],
];

const responses = {};
for (const [id, path] of endpoints) {
  const response = await request(path, { token: adminToken });
  responses[id] = response;
  const collection = response.body?.items || response.body?.hosts || response.body?.alerts || response.body?.policies || response.body?.agents;
  const items = Array.isArray(collection) ? collection.length : undefined;
  record(id, response, { items, total: response.body?.total ?? response.body?.summary?.total });
}

const firstSearchItem = responses["dashboard.search"]?.body?.items?.[0];
const rawKey = firstSearchItem?.idempotencyKey || firstSearchItem?.idempotency_key;
if (rawKey) {
  const raw = await request(`/api/logs/raw/${encodeURIComponent(rawKey)}`, { token: adminToken });
  record("dashboard.raw-detail", raw, { idempotencyKey: rawKey });
}

const firstAlert = responses["dashboard.alerts"]?.body?.items?.[0];
const alertKey = firstAlert?.alertId || firstAlert?.id;
if (alertKey) {
  const detail = await request(`/api/alerts/${encodeURIComponent(alertKey)}`, { token: adminToken });
  record("alerts.detail", detail, { alertId: alertKey, ruleId: detail.body?.alert?.ruleId });
}

const csv = await request("/api/dashboard/log-loss/export?format=csv", { token: adminToken });
record("loss.csv-export", csv, {
  contentType: csv.headers["content-type"],
  bytes: typeof csv.body === "string" ? Buffer.byteLength(csv.body) : 0,
});

const hosts = responses["dashboard.hosts"]?.body?.hosts || responses["dashboard.hosts"]?.body?.items || [];
const allowedHost = hosts[0]?.computer || hosts[0]?.host || "HOSTEYE-NO-DATA";
const viewerUsername = `st37.viewer.${suffix}`;
const viewerPassword = `HostEye-${randomUUID()}-Aa1!`;
const created = await request("/api/dashboard/admin/users", {
  method: "POST",
  token: adminToken,
  body: {
    username: viewerUsername,
    displayName: "ST-37 Scoped Viewer",
    role: "viewer",
    password: viewerPassword,
    permissions: ["dashboard:view", "telemetry:read"],
    scopes: { hosts: [allowedHost], agents: [], groups: [] },
  },
});
record("accounts.create-scoped-viewer", created, { username: viewerUsername, allowedHost });

const viewerLogin = await request("/api/dashboard/auth/login", {
  method: "POST",
  body: { username: viewerUsername, password: viewerPassword },
});
record("auth.viewer.login", viewerLogin, { role: viewerLogin.body?.user?.role });
const viewerToken = viewerLogin.body?.token;

if (viewerToken) {
  const allowed = await request(`/api/logs/search?host=${encodeURIComponent(allowedHost)}&limit=1`, { token: viewerToken });
  record("authorization.allowed-host", allowed, { host: allowedHost });

  const deniedHost = await request("/api/logs/search?host=HOSTEYE-OUTSIDE-SCOPE&limit=1", { token: viewerToken });
  result.checks.push({ id: "authorization.denied-host", status: deniedHost.status, passed: deniedHost.status === 403 });

  const deniedAlerts = await request("/api/alerts?limit=1", { token: viewerToken });
  result.checks.push({ id: "authorization.denied-function", status: deniedAlerts.status, passed: deniedAlerts.status === 403 });

  const deniedUsers = await request("/api/dashboard/admin/users", { token: viewerToken });
  result.checks.push({ id: "authorization.denied-user-admin", status: deniedUsers.status, passed: deniedUsers.status === 403 });

  const locked = await request(`/api/dashboard/admin/users/${created.body?.user?.id}/lock`, { method: "POST", token: adminToken });
  record("accounts.lock-viewer", locked, { locked: locked.body?.user?.locked });

  const revoked = await request("/api/dashboard/auth/me", { token: viewerToken });
  result.checks.push({ id: "accounts.lock-revokes-session", status: revoked.status, passed: revoked.status === 401 });

  const unlocked = await request(`/api/dashboard/admin/users/${created.body?.user?.id}/unlock`, { method: "POST", token: adminToken });
  record("accounts.unlock-viewer", unlocked, { locked: unlocked.body?.user?.locked });
}

result.summary = {
  total: result.checks.length,
  passed: result.checks.filter((item) => item.passed).length,
  failed: result.checks.filter((item) => !item.passed).length,
};

await writeFile(output, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify(result.summary));
if (result.summary.failed) process.exitCode = 1;
