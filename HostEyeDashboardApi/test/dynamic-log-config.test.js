import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("UC-09 exposes the supported Dynamic Logs catalog", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/dynamic-config/catalog");
    assert.equal(response.status, 200);
    assert.equal(response.body.items.length, 7);
    assert.ok(response.body.defaults.includes("windows-security"));
    assert.ok(response.body.items.some((item) => item.id === "sysmon"
      && item.channels.includes("Microsoft-Windows-Sysmon/Operational")));
    assert.equal(response.body.fields.length, 11);
    assert.ok(response.body.fields.some((item) => item.id === "hostname"
      && item.field === "computer" && item.required === true));
    assert.ok(response.body.fields.some((item) => item.id === "username"
      && item.field === "user_name"));
    assert.deepEqual(response.body.fields.filter((item) => item.required).map((item) => item.id),
      ["timestamp", "hostname", "event_id", "channel"]);
    assert.deepEqual(response.body.retainedInternalFields,
      ["agent_id", "host_id", "raw_log", "idempotency_key"]);
    assert.equal(controlPlane.requests.length, 0);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-09 saves selected log types as a disabled Dynamic Config draft", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const response = await postJson(api.url + "/api/dashboard/dynamic-config/policies", {
      name: "Investigation baseline",
      logTypes: ["windows-security", "sysmon", "powershell", "sysmon"],
      draft: true,
      targetType: "default",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.name, "Investigation baseline");
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.rollout.enabled, false);
    assert.match(response.body.policy_id, /^policy-draft-default-/);
    assert.deepEqual(response.body.config.vector.channels, [
      "Security",
      "Microsoft-Windows-Sysmon/Operational",
      "Microsoft-Windows-PowerShell/Operational",
    ]);
    assert.deepEqual(response.body.config.vector.selected_fields, [
      "timestamp", "computer", "user_name", "process_name", "process_id", "source_ip",
      "destination_ip", "destination_port", "event_id", "channel", "message",
    ]);
    assert.deepEqual(response.body.config.sensors, {
      sysmon_enabled: true,
      powershell_enabled: true,
      network_events_enabled: true,
    });
    assert.equal(response.body.config.shipper.gateway_url,
      "https://hosteye.iahn.hanoi.vn/api/v1/telemetry");
    assert.equal(controlPlane.requests.length, 1);
    assert.equal(controlPlane.requests[0].headers["x-hosteye-admin-token"], "test-admin-token");
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-09 rejects invalid draft definitions before contacting the control plane", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const cases = [
      [{ name: "Empty", logTypes: [], draft: true }, "at least one supported log type"],
      [{ name: "Wrong type", logTypes: "sysmon", draft: true }, "logTypes must be an array"],
      [{ logTypes: ["sysmon"], draft: true }, "name is required"],
      [{ name: "Unknown", logTypes: ["unknown-source"], draft: true }, "unsupported log type"],
      [{ name: "Bad target", logTypes: ["sysmon"], targetType: "site" }, "targetType must be one of"],
      [{ name: "Group", logTypes: ["sysmon"], targetType: "group" }, "targetValue is required"],
      [{ name: "Version", logTypes: ["sysmon"], version: "one" }, "version must be an integer"],
      [{ name: "x".repeat(201), logTypes: ["sysmon"] }, "name must be at most 200 characters"],
    ];
    for (const [body, message] of cases) {
      const response = await postJson(api.url + "/api/dashboard/dynamic-config/policies", body);
      assert.equal(response.status, 400);
      assert.match(response.body.message, new RegExp(message));
    }
    assert.equal(controlPlane.requests.length, 0);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-10 maps selected UI fields to a validated Dynamic Config contract", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const response = await postJson(api.url + "/api/dashboard/dynamic-config/policies", {
      name: "Minimal investigation fields",
      logTypes: ["windows-security", "sysmon"],
      selectedFields: ["timestamp", "hostname", "event_id", "channel", "username", "destination_port", "message"],
      draft: true,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.config.vector.selected_fields, [
      "timestamp", "computer", "event_id", "channel", "user_name", "destination_port", "message",
    ]);
    assert.equal(response.body.enabled, false);
    assert.equal(response.body.rollout.enabled, false);
    assert.deepEqual(controlPlane.requests[0].body.config.vector.selected_fields,
      response.body.config.vector.selected_fields);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-10 rejects invalid or unsafe field selections before contacting the control plane", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const base = { name: "Invalid fields", logTypes: ["sysmon"], draft: true };
    const cases = [
      [{ ...base, selectedFields: "timestamp" }, "selectedFields must be an array"],
      [{ ...base, selectedFields: [] }, "at least one supported field"],
      [{ ...base, selectedFields: ["timestamp", "hostname", "event_id", "channel", "unknown"] }, "unsupported selected field"],
      [{ ...base, selectedFields: ["timestamp", "hostname", "event_id", "channel", "message", "message"] }, "must not contain duplicates"],
      [{ ...base, selectedFields: ["timestamp", "hostname", "event_id"] }, "must include required fields: channel"],
      [{ ...base, selectedFields: ["timestamp", "", "hostname", "event_id", "channel"] }, "must not contain empty identifiers"],
    ];
    for (const [body, message] of cases) {
      const response = await postJson(api.url + "/api/dashboard/dynamic-config/policies", body);
      assert.equal(response.status, 400);
      assert.match(response.body.message, new RegExp(message));
    }
    assert.equal(controlPlane.requests.length, 0);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-09 reports Dynamic Config outages without claiming a draft was saved", async () => {
  const port = await freePort();
  const api = await startApi("http://127.0.0.1:" + port);
  try {
    const response = await postJson(api.url + "/api/dashboard/dynamic-config/policies", {
      name: "Offline draft", logTypes: ["windows-system"], draft: true,
    });
    assert.equal(response.status, 503);
    assert.match(response.body.message, /Dynamic Config service is not reachable/);
  } finally {
    await api.close();
  }
});

test("UC-09 Dashboard exposes a responsive log-type draft workflow", async () => {
  const app = await readFile(resolve(ROOT, "../HostEyeDashboard/public/app.js"), "utf8");
  const html = await readFile(resolve(ROOT, "../HostEyeDashboard/public/index.html"), "utf8");
  const css = await readFile(resolve(ROOT, "../HostEyeDashboard/public/styles.css"), "utf8");
  for (const id of ["dynamicLogForm", "dynamicPolicyName", "dynamicLogTypeOptions", "dynamicFieldOptions",
    "dynamicDraftStatus", "dynamicDraftSave"]) {
    assert.ok(html.includes('id="' + id + '"'));
  }
  assert.match(app, /dynamic-config\/catalog/);
  assert.match(app, /saveDynamicLogDraft/);
  assert.match(app, /logTypes, selectedFields, draft: true/);
  assert.match(app, /name="dynamicField"/);
  assert.ok(app.includes('${item.required ? "disabled" : ""}'));
  assert.match(app, /dynamicSaveInFlight/);
  assert.match(css, /\.dynamic-log-options/);
  assert.ok(css.includes(".dynamic-field-options"));
  assert.match(css, /grid-template-columns: 1fr/);
});

async function startMockDynamicConfig() {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST" && req.url === "/api/v1/dynamic-config/policies") {
      state.requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/dynamic-config/policies") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (req.method === "GET" && ["/api/v1/dynamic-config/agents", "/api/v1/dynamic-config/audit"].includes(req.url)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);
  return {
    url: "http://127.0.0.1:" + server.address().port,
    requests: state.requests,
    close: () => closeServer(server),
  };
}

async function startApi(dynamicConfigUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "test",
      HOSTEYE_DYNAMIC_CONFIG_URL: dynamicConfigUrl,
      HOSTEYE_DYNAMIC_CONFIG_ADMIN_TOKEN: "test-admin-token",
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
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Dashboard API did not start: " + output());
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
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
