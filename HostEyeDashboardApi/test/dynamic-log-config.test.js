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

test("UC-11 previews the canonical policy without contacting the control plane", async () => {
  const controlPlane = await startMockDynamicConfig();
  const api = await startApi(controlPlane.url);
  try {
    const response = await postJson(api.url + "/api/dashboard/dynamic-config/preview", {
      name: "Preview investigation policy",
      logTypes: ["windows-security", "sysmon"],
      selectedFields: ["timestamp", "hostname", "event_id", "channel", "username", "message"],
      targetType: "default",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.previewOnly, true);
    assert.equal(response.body.summary.state, "disabled draft");
    assert.deepEqual(response.body.summary.logTypes, [
      { id: "windows-security", name: "Windows Security" },
      { id: "sysmon", name: "Sysmon" },
    ]);
    assert.deepEqual(response.body.summary.channels, [
      "Security", "Microsoft-Windows-Sysmon/Operational",
    ]);
    assert.deepEqual(response.body.summary.selectedFields.map((item) => item.field),
      ["timestamp", "computer", "event_id", "channel", "user_name", "message"]);
    assert.deepEqual(response.body.summary.selectedFields.filter((item) => item.required).map((item) => item.field),
      ["timestamp", "computer", "event_id", "channel"]);
    assert.equal(response.body.policy.enabled, false);
    assert.equal(response.body.policy.rollout.enabled, false);
    assert.equal(controlPlane.requests.length, 0);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-11 preview validates input but remains available when the control plane is offline", async () => {
  const unreachablePort = await freePort();
  const api = await startApi("http://127.0.0.1:" + unreachablePort);
  try {
    const preview = await postJson(api.url + "/api/dashboard/dynamic-config/preview", {
      name: "Offline preview",
      logTypes: ["windows-system"],
      selectedFields: ["timestamp", "hostname", "event_id", "channel"],
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.previewOnly, true);

    const invalid = await postJson(api.url + "/api/dashboard/dynamic-config/preview", {
      name: "Unsafe preview",
      logTypes: ["windows-system"],
      selectedFields: ["timestamp", "hostname", "event_id"],
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.message, /required fields: channel/);
  } finally {
    await api.close();
  }
});

test("UC-12 assigns a disabled draft to a known endpoint group and enables signed rollout", async () => {
  const draft = {
    policy_id: "policy-draft-group-lab",
    version: 3,
    name: "Group investigation baseline",
    enabled: false,
    target: { type: "default" },
    rollout: { enabled: false, percent: 100, min_agent_version: "0.1.0" },
    config: {
      config_schema_version: 1,
      vector: {
        enabled: true,
        channels: ["Security", "Microsoft-Windows-Sysmon/Operational"],
        selected_fields: ["timestamp", "computer", "event_id", "channel", "message"],
        batch_max_events: 500,
        batch_timeout_secs: 5,
      },
      shipper: {
        enabled: true,
        gateway_url: "https://hosteye.iahn.hanoi.vn/api/v1/telemetry",
        normal_jitter_window_seconds: 300,
        recovery_jitter_window_seconds: 1800,
        base_backoff_seconds: 2,
        max_backoff_seconds: 300,
        max_spool_size_mb: 8192,
      },
      sensors: { sysmon_enabled: true, powershell_enabled: false, network_events_enabled: true },
    },
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  const controlPlane = await startMockDynamicConfig({
    policies: [draft],
    agents: [{
      agent_id: "agent-lab-001",
      host_id: "host-lab-001",
      group_id: "group-lab",
      last_ack_status: "applied",
    }],
  });
  const api = await startApi(controlPlane.url);
  try {
    const response = await postJson(api.url + "/api/dashboard/dynamic-config/assignments", {
      policyId: draft.policy_id,
      targetType: "group",
      targetValue: "group-lab",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "assigned");
    assert.equal(response.body.applyMode, "next_agent_poll");
    assert.deepEqual(response.body.target, { type: "group", group_id: "group-lab" });
    assert.equal(response.body.policy.policy_id, draft.policy_id);
    assert.equal(response.body.policy.version, 4);
    assert.equal(response.body.policy.enabled, true);
    assert.deepEqual(response.body.policy.rollout, {
      enabled: true,
      percent: 100,
      min_agent_version: "0.1.0",
    });
    assert.deepEqual(response.body.policy.config, draft.config);
    assert.equal(controlPlane.requests.length, 1);
    assert.equal(controlPlane.requests[0].headers["x-hosteye-admin-token"], "test-admin-token");
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-12 rejects unsafe or unknown assignments without mutating policy state", async () => {
  const draft = {
    policy_id: "policy-draft-known",
    version: 1,
    name: "Known draft",
    enabled: false,
    target: { type: "default" },
    rollout: { enabled: false, percent: 100, min_agent_version: "0.1.0" },
    config: {
      config_schema_version: 1,
      vector: { enabled: true, channels: ["Security"], selected_fields: ["timestamp", "computer", "event_id", "channel"], batch_max_events: 1000, batch_timeout_secs: 10 },
      shipper: { enabled: true, gateway_url: "https://hosteye.iahn.hanoi.vn/api/v1/telemetry", normal_jitter_window_seconds: 300, recovery_jitter_window_seconds: 1800, base_backoff_seconds: 2, max_backoff_seconds: 300, max_spool_size_mb: 8192 },
      sensors: { sysmon_enabled: false, powershell_enabled: false, network_events_enabled: true },
    },
    updated_at: "2026-08-01T00:00:00.000Z",
  };
  const active = {
    ...draft,
    policy_id: "policy-active",
    enabled: true,
    rollout: { ...draft.rollout, enabled: true },
  };
  const controlPlane = await startMockDynamicConfig({
    policies: [draft, active],
    agents: [{ agent_id: "agent-known", host_id: "host-known", group_id: "group-known" }],
  });
  const api = await startApi(controlPlane.url);
  try {
    const cases = [
      [{ policyId: "missing", targetType: "default" }, "draft does not exist"],
      [{ policyId: active.policy_id, targetType: "default" }, "only a disabled"],
      [{ policyId: draft.policy_id, targetType: "agent", targetValue: "agent-missing" }, "target agent does not exist"],
      [{ policyId: draft.policy_id, targetType: "group", targetValue: "group-missing" }, "target group does not exist"],
      [{ policyId: draft.policy_id, targetType: "site", targetValue: "site-a" }, "targetType must be one of"],
      [{ policyId: draft.policy_id, targetType: "group" }, "targetValue is required"],
    ];
    for (const [body, message] of cases) {
      const response = await postJson(api.url + "/api/dashboard/dynamic-config/assignments", body);
      assert.equal(response.status, 400);
      assert.match(response.body.message, new RegExp(message));
    }
    assert.equal(controlPlane.requests.length, 0);
  } finally {
    await api.close();
    await controlPlane.close();
  }
});

test("UC-13 reports assigned, sent, applied, failed, and current config state per endpoint", async () => {
  const basePolicy = {
    policy_id: "policy-default-v10",
    version: 10,
    enabled: true,
    target: { type: "default" },
    rollout: { enabled: true, percent: 100, min_agent_version: "0.1.0" },
  };
  const groupPolicy = {
    ...basePolicy,
    policy_id: "policy-group-lab",
    version: 4,
    target: { type: "group", group_id: "group-lab" },
  };
  const now = "2026-08-03T08:00:00.000Z";
  const controlPlane = await startMockDynamicConfig({
    policies: [basePolicy, groupPolicy],
    agents: [
      {
        agent_id: "agent-applied", host_id: "host-applied", group_id: "group-lab",
        reported_policy_id: groupPolicy.policy_id, reported_version: 4,
        desired_policy_id: groupPolicy.policy_id, desired_version: 4,
        delivery_status: "applied", last_poll_at: now, last_ack_at: now,
        last_policy_id: groupPolicy.policy_id, last_version: 4,
        last_ack_status: "applied", last_ack_message: "Atomic apply completed",
      },
      {
        agent_id: "agent-sent", host_id: "host-sent", group_id: "group-lab",
        reported_policy_id: "policy-previous", reported_version: 3,
        desired_policy_id: groupPolicy.policy_id, desired_version: 4,
        delivery_status: "sent_waiting_ack", last_poll_at: now, last_delivery_at: now,
        last_policy_id: "policy-previous", last_version: 3, last_ack_status: "applied",
      },
      {
        agent_id: "agent-pending", host_id: "host-pending", group_id: "group-lab",
        reported_policy_id: "policy-previous", reported_version: 3,
        desired_policy_id: "policy-previous", desired_version: 3,
        delivery_status: "up_to_date", last_poll_at: now,
        last_policy_id: "policy-previous", last_version: 3, last_ack_status: "applied",
      },
      {
        agent_id: "agent-failed", host_id: "host-failed", group_id: "group-lab",
        reported_policy_id: "policy-previous", reported_version: 3,
        desired_policy_id: groupPolicy.policy_id, desired_version: 4,
        delivery_status: "apply_failed", last_poll_at: now, last_ack_at: now,
        last_policy_id: groupPolicy.policy_id, last_version: 4,
        last_ack_status: "apply_failed", last_ack_message: "validation command failed",
      },
    ],
  });
  const api = await startApi(controlPlane.url);
  try {
    const response = await getJson(api.url + "/api/dashboard/dynamic-config/config-status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.totals, { agents: 4, applied: 1, pending: 2, failed: 1 });
    const byAgent = new Map(response.body.items.map((item) => [item.agentId, item]));
    assert.equal(byAgent.get("agent-applied").state, "applied");
    assert.equal(byAgent.get("agent-applied").assignedPolicyId, groupPolicy.policy_id);
    assert.equal(byAgent.get("agent-applied").reportedPolicyId, groupPolicy.policy_id);
    assert.equal(byAgent.get("agent-sent").state, "sent_waiting_ack");
    assert.equal(byAgent.get("agent-pending").state, "pending_agent_poll");
    assert.equal(byAgent.get("agent-failed").state, "apply_failed");
    assert.match(byAgent.get("agent-failed").lastAckMessage, /validation command failed/);
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
    "dynamicDraftStatus", "dynamicDraftPreview", "dynamicDraftSave", "dynamicPreviewPanel",
    "dynamicPreviewSummary", "dynamicPreviewJson", "dynamicAssignmentForm", "dynamicAssignmentPolicy",
    "dynamicAssignmentTargetType", "dynamicAssignmentTarget", "dynamicAssignmentStatus",
    "dynamicAssignmentSubmit"]) {
    assert.ok(html.includes('id="' + id + '"'));
  }
  assert.match(app, /dynamic-config\/catalog/);
  assert.match(app, /saveDynamicLogDraft/);
  assert.match(app, /previewDynamicLogDraft/);
  assert.match(app, /dynamic-config\/preview/);
  assert.match(app, /Preview ready; no policy saved/);
  assert.match(app, /dynamic-config\/assignments/);
  assert.match(app, /dynamic-config\/config-status/);
  assert.match(app, /Waiting for Agent poll/);
  assert.match(app, /Sent; waiting for ACK/);
  assert.match(app, /Apply failed/);
  assert.match(html, /Endpoint configuration status/);
  assert.match(html, /dynamic-status-panel/);
  assert.match(app, /assignDynamicConfig/);
  assert.match(app, /Waiting for endpoint poll and ACK/);
  assert.match(app, /Latest ACK:/);
  assert.match(app, /body: \{ \.\.\.values, draft: true, targetType: "default" \}/);
  assert.match(app, /name="dynamicField"/);
  assert.ok(app.includes('${item.required ? "disabled" : ""}'));
  assert.match(app, /dynamicSaveInFlight/);
  assert.match(css, /\.dynamic-log-options/);
  assert.ok(css.includes(".dynamic-field-options"));
  assert.ok(css.includes(".dynamic-preview-summary"));
  assert.ok(css.includes(".dynamic-assignment-grid"));
  assert.match(css, /#dynamicAgentsTable table/);
  assert.match(css, /min-width: 1120px/);
  assert.match(css, /grid-template-columns: 1fr/);
});

async function startMockDynamicConfig(options = {}) {
  const state = {
    requests: [],
    policies: structuredClone(options.policies || []),
    agents: structuredClone(options.agents || []),
    audit: structuredClone(options.audit || []),
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "POST" && req.url === "/api/v1/dynamic-config/policies") {
      const parsed = JSON.parse(body);
      state.requests.push({ headers: req.headers, body: parsed });
      const index = state.policies.findIndex((policy) => policy.policy_id === parsed.policy_id);
      if (index >= 0) state.policies[index] = parsed;
      else state.policies.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/dynamic-config/policies") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.policies));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/dynamic-config/agents") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.agents));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/dynamic-config/audit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.audit));
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
