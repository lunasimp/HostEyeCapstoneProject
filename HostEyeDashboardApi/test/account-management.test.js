import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("UC-36 manages persistent Dashboard accounts and revokes locked sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-uc36-"));
  const usersFile = join(directory, "dashboard-users.json");
  let api = await startApi(usersFile);
  try {
    const status = await requestJson(api.url + "/api/dashboard/auth/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.required, true);
    assert.equal(status.body.userCount, 1);

    const login = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST",
      body: { username: "admin", password: "uc36-admin-password" },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, "admin");
    const adminToken = login.body.token;

    const created = await requestJson(api.url + "/api/dashboard/admin/users", {
      method: "POST",
      token: adminToken,
      body: {
        username: "analyst.one",
        displayName: "Analyst One",
        role: "user",
        password: "initial-user-password",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.locked, false);
    assert.equal(created.body.user.password, undefined);
    const userId = created.body.user.id;

    const updated = await requestJson(api.url + `/api/dashboard/admin/users/${userId}`, {
      method: "PUT",
      token: adminToken,
      body: { displayName: "Analyst Updated", password: "updated-user-password" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.displayName, "Analyst Updated");

    const userLogin = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST",
      body: { username: "analyst.one", password: "updated-user-password" },
    });
    assert.equal(userLogin.status, 200);
    const userToken = userLogin.body.token;
    const forbidden = await requestJson(api.url + "/api/dashboard/admin/users", { token: userToken });
    assert.equal(forbidden.status, 403);

    const locked = await requestJson(api.url + `/api/dashboard/admin/users/${userId}/lock`, {
      method: "POST",
      token: adminToken,
    });
    assert.equal(locked.body.user.locked, true);
    const revoked = await requestJson(api.url + "/api/dashboard/auth/me", { token: userToken });
    assert.equal(revoked.status, 401);
    const lockedLogin = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST",
      body: { username: "analyst.one", password: "updated-user-password" },
    });
    assert.equal(lockedLogin.status, 401);

    const lastAdmin = login.body.user.id;
    const unsafe = await requestJson(api.url + `/api/dashboard/admin/users/${lastAdmin}/lock`, {
      method: "POST",
      token: adminToken,
    });
    assert.equal(unsafe.status, 409);

    const unlocked = await requestJson(api.url + `/api/dashboard/admin/users/${userId}/unlock`, {
      method: "POST",
      token: adminToken,
    });
    assert.equal(unlocked.body.user.locked, false);

    await api.close();
    api = await startApi(usersFile);
    const persistedLogin = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST",
      body: { username: "analyst.one", password: "updated-user-password" },
    });
    assert.equal(persistedLogin.status, 200);
    assert.equal(persistedLogin.body.user.displayName, "Analyst Updated");
  } finally {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UC-36 rejects invalid accounts without exposing password material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosteye-uc36-invalid-"));
  const usersFile = join(directory, "dashboard-users.json");
  const api = await startApi(usersFile);
  try {
    const login = await requestJson(api.url + "/api/dashboard/auth/login", {
      method: "POST",
      body: { username: "admin", password: "uc36-admin-password" },
    });
    const token = login.body.token;
    const invalid = await requestJson(api.url + "/api/dashboard/admin/users", {
      method: "POST",
      token,
      body: { username: "x", displayName: "Bad", role: "user", password: "short" },
    });
    assert.equal(invalid.status, 400);
    const list = await requestJson(api.url + "/api/dashboard/admin/users", { token });
    assert.equal(list.body.items.length, 1);

    const stored = await readFile(usersFile, "utf8");
    assert.doesNotMatch(stored, /uc36-admin-password|short/);
    assert.match(stored, /pbkdf2-sha256/);
  } finally {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("UC-36 Dashboard exposes responsive sign-in and account lifecycle controls", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  const css = await readFile(resolve(ROOT, "../HostEyeDashboard/public/styles.css"), "utf8");
  assert.match(app, /\/api\/dashboard\/auth\/login/);
  assert.match(app, /\/api\/dashboard\/admin\/users/);
  assert.match(app, /hosteyeDashboardSession/);
  assert.match(html, /id="loginModal"/);
  assert.match(html, /id="userCreateForm"/);
  assert.match(html, /data-page="users"/);
  assert.match(css, /\.login-backdrop/);
  assert.match(css, /\.users-table table/);
});

async function startApi(usersFile) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      HOSTEYE_DASHBOARD_AUTH_REQUIRED: "true",
      HOSTEYE_DASHBOARD_USERS_FILE: usersFile,
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME: "admin",
      HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD: "uc36-admin-password",
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
      if (response.ok) {
        return {
          url,
          close: async () => {
            if (child.exitCode === null) child.kill();
            await new Promise((resolveClose) => child.once("exit", resolveClose));
          },
        };
      }
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
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
    server.on("error", reject);
  });
}
