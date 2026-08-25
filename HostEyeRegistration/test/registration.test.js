import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegistrationStore } from "../src/store.js";
import { createRegistrationServer } from "../src/server.js";

const ADMIN = "registration-admin-test-token";
const SIGNING = "bootstrap-signing-test-key-at-least-32-bytes";
const CSR = "-----BEGIN CERTIFICATE REQUEST-----\nVEVTVA==\n-----END CERTIFICATE REQUEST-----";

test("one-time token enrolls one C_i and revoked identity is rejected", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hosteye-registration-test-"));
  const store = new RegistrationStore(join(directory, "state.json"));
  const authority = { signCsr: async () => ({
    certificatePem: "CERTIFICATE", caCertificatePem: "CA", serial: "01AB", thumbprint: "AABB", subject: "CN=test", notAfter: new Date(Date.now() + 86400000).toISOString(),
  }) };
  const server = createRegistrationServer({ store, authority, adminToken: ADMIN, bootstrapSigningKey: SIGNING });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await json(base + "/api/v1/admin/tokens", { method: "POST", headers: { "x-hosteye-admin-token": ADMIN }, body: { expectedHostname: "HOST-01", groupId: "workstations" } });
    assert.equal(created.status, 201);
    assert.match(created.body.ciId, /^ci-/);
    const request = { token: created.body.token, agentId: "agent-01", hostId: "host-01", actualHostname: "HOST-01", csr: CSR };
    const enrolled = await json(base + "/api/v1/enroll", { method: "POST", body: request });
    assert.equal(enrolled.status, 201);
    assert.equal(enrolled.body.ciId, created.body.ciId);
    assert.ok(enrolled.body.bootstrapSignature);
    const replay = await json(base + "/api/v1/enroll", { method: "POST", body: request });
    assert.equal(replay.status, 409);
    const valid = await json(base + "/api/v1/identity/validate", { method: "POST", headers: { "x-hosteye-admin-token": ADMIN }, body: { ciId: created.body.ciId, agentId: "agent-01", hostId: "host-01", certificateSerial: "01AB" } });
    assert.equal(valid.status, 200);
    const devices = await json(base + "/api/v1/admin/devices", { headers: { "x-hosteye-admin-token": ADMIN } });
    const revoked = await json(`${base}/api/v1/admin/devices/${devices.body[0].deviceRecordId}/revoke`, { method: "POST", headers: { "x-hosteye-admin-token": ADMIN }, body: { reason: "test" } });
    assert.equal(revoked.body.status, "Revoked");
    const rejected = await json(base + "/api/v1/identity/validate", { method: "POST", headers: { "x-hosteye-admin-token": ADMIN }, body: { ciId: created.body.ciId, agentId: "agent-01", hostId: "host-01", certificateSerial: "01AB" } });
    assert.equal(rejected.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: response.status, body: await response.json() };
}
