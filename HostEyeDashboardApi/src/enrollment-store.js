import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const registryPath = process.env.HOSTEYE_REGISTRY_PATH || resolve(process.cwd(), "data", "hosteye-registry.json");

export async function readJsonBody(req) {
  if (!["POST", "PUT", "PATCH"].includes(req.method || "")) return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    badRequest("Request body must be valid JSON");
  }
}

export function registryInfo() {
  return { path: registryPath, signingKeyPath: signingKeyPath() };
}

export async function enrollmentStart(ctx, res) {
  const body = ctx.body || {};
  const token = stringField(body, "enrollmentToken", "lab-auto-enroll");
  const hostname = stringField(body, "hostname", "unknown-host");
  const staffId = stringField(body, "staffId", "unassigned");
  const organizationUnit = stringField(body, "organizationUnit", "FPT/IAHN/Lab");
  const osName = stringField(body, "osName", "unknown");
  const osVersion = stringField(body, "osVersion", "");
  const architecture = stringField(body, "architecture", "");
  const csrPem = stringField(body, "csrPem", "");
  const publicKeyPem = stringField(body, "publicKeyPem", "");
  const hardwareFingerprint = stringField(body, "hardwareFingerprint", "");
  const assignedGroups = Array.isArray(body.assignedGroups) ? body.assignedGroups.map(String) : ["lab-default"];

  const registry = loadRegistry();
  const tokenRecord = ensureEnrollmentToken(registry, token, {
    assignedStaffId: staffId,
    assignedGroup: assignedGroups[0] || "lab-default",
    autoApprove: body.autoApprove !== false,
  });

  if (tokenRecord.status !== "active") badRequest("Enrollment token is not active");
  if (new Date(tokenRecord.expiresAt).getTime() < Date.now()) badRequest("Enrollment token has expired");
  if (tokenRecord.usedCount >= tokenRecord.maxUses) badRequest("Enrollment token usage limit exceeded");

  const deviceId = `dev-${randomUUID()}`;
  const hostId = `host-${randomUUID()}`;
  const now = nowIso();
  const artifactId = `artifact-${deviceId}-pending`;
  const publicKeySha256 = publicKeyPem ? sha256(publicKeyPem) : "";
  const hardwareFingerprintHash = hardwareFingerprint ? sha256(hardwareFingerprint) : "";

  const device = {
    deviceId,
    hostId,
    staffId,
    userName: stringField(body, "userName", staffId),
    organizationUnit,
    hostname,
    osName,
    osVersion,
    architecture,
    hardwareFingerprintHash,
    publicKeySha256,
    certificateSerial: `demo-cert-${sha256(`${deviceId}:${publicKeySha256}`).slice(0, 20)}`,
    enrollmentTokenId: tokenRecord.tokenId,
    assignedGroups,
    currentAgentVersion: "pending",
    currentPolicyVersion: "pending",
    latestArtifactId: artifactId,
    status: tokenRecord.autoApprove ? "building" : "pending_approval",
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
  };

  const claims = {
    claimsId: `claims-${randomUUID()}`,
    deviceId,
    hostId,
    artifactId,
    staffId,
    organizationUnit,
    licenseId: stringField(body, "license", "lab-2026"),
    agentVersion: "pending",
    issuedAt: now,
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    claimsJson: {},
    claimsSignature: "",
  };
  claims.claimsJson = {
    device_id: deviceId,
    host_id: hostId,
    staff_id: staffId,
    organization_unit: organizationUnit,
    artifact_id: artifactId,
    agent_version: claims.agentVersion,
    issued_at: claims.issuedAt,
    expires_at: claims.expiresAt,
  };
  claims.claimsSignature = signHostEyePayload(claims.claimsJson);

  const artifact = {
    artifactId,
    deviceId,
    buildId: `build-${randomUUID()}`,
    agentVersion: "pending",
    platform: normalizePlatform(osName),
    architecture,
    artifactUrl: "",
    sha256: "",
    signature: "",
    signerKeyId: signingKeyInfo().keyId,
    identityClaimsHash: sha256(canonicalJson(claims.claimsJson)),
    buildStatus: tokenRecord.autoApprove ? "queued" : "waiting_approval",
    createdAt: now,
    downloadedAt: "",
    installedAt: "",
  };

  registry.devices.push(device);
  registry.identityClaims.push(claims);
  registry.deviceArtifacts.push(artifact);
  tokenRecord.usedCount += 1;
  tokenRecord.lastUsedAt = now;
  addAudit(registry, "installer", deviceId, "enrollment.start", "device", deviceId, {
    hostname,
    staffId,
    tokenId: tokenRecord.tokenId,
    csrSha256: csrPem ? sha256(csrPem) : "",
  });
  saveRegistry(registry);

  sendJson(res, 202, {
    enrollmentId: deviceId,
    deviceId,
    hostId,
    status: device.status,
    artifactId,
    buildStatus: artifact.buildStatus,
    identityClaims: claims.claimsJson,
    identityClaimsSignature: claims.claimsSignature,
    certificate: issueDemoCertificate(device, publicKeySha256),
    next: tokenRecord.autoApprove ? "build_artifact" : "admin_approval",
  });
}

export async function enrollmentComplete(ctx, res) {
  const body = ctx.body || {};
  const deviceId = stringField(body, "deviceId", "");
  if (!deviceId) badRequest("deviceId is required");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  const artifactId = stringField(body, "artifactId", device.latestArtifactId);
  const artifact = findArtifact(registry, artifactId);
  const now = nowIso();

  device.status = "active";
  device.currentAgentVersion = stringField(body, "agentVersion", artifact.agentVersion || "unknown");
  device.currentPolicyVersion = stringField(body, "policyVersion", device.currentPolicyVersion || "pending");
  device.certificateSerial = stringField(body, "certificateSerial", device.certificateSerial || `demo-${sha256(deviceId).slice(0, 16)}`);
  device.lastSeenAt = now;
  device.updatedAt = now;
  artifact.installedAt = now;
  artifact.buildStatus = artifact.buildStatus === "ready" ? "installed" : artifact.buildStatus;
  addAudit(registry, "installer", deviceId, "enrollment.complete", "device", deviceId, {
    artifactId,
    agentVersion: device.currentAgentVersion,
  });
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, status: device.status, artifactId, certificateSerial: device.certificateSerial });
}

export async function enrollmentHeartbeat(ctx, res) {
  const body = ctx.body || {};
  const deviceId = stringField(body, "deviceId", "");
  if (!deviceId) badRequest("deviceId is required");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  const now = nowIso();
  device.lastSeenAt = now;
  device.updatedAt = now;
  if (body.agentVersion) device.currentAgentVersion = String(body.agentVersion);
  if (body.policyVersion) device.currentPolicyVersion = String(body.policyVersion);
  addAudit(registry, "agent", deviceId, "enrollment.heartbeat", "device", deviceId, {
    agentVersion: device.currentAgentVersion,
    policyVersion: device.currentPolicyVersion,
    artifactId: stringField(body, "artifactId", device.latestArtifactId),
  });
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, status: device.status, lastSeenAt: device.lastSeenAt });
}

export async function enrollmentFail(ctx, res) {
  const body = ctx.body || {};
  const deviceId = stringField(body, "deviceId", "");
  if (!deviceId) badRequest("deviceId is required");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  const reason = stringField(body, "reason", "unknown");
  device.status = "failed";
  device.updatedAt = nowIso();
  addAudit(registry, "installer", deviceId, "enrollment.fail", "device", deviceId, { reason });
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, status: device.status, reason });
}

export async function adminEnrollmentTokens(ctx, res) {
  const registry = loadRegistry();
  sendJson(res, 200, {
    items: registry.enrollmentTokens
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((token) => ({ ...token, tokenHash: `${token.tokenHash.slice(0, 12)}...` })),
  });
}

export async function adminEnrollmentTokenCreate(ctx, res) {
  const body = ctx.body || {};
  const token = stringField(body, "token", `hosteye-${randomUUID()}`);
  const registry = loadRegistry();
  const record = ensureEnrollmentToken(registry, token, {
    assignedStaffId: stringField(body, "assignedStaffId", "unassigned"),
    assignedGroup: stringField(body, "assignedGroup", "lab-default"),
    autoApprove: body.autoApprove !== false,
  });
  if (body.maxUses !== undefined) record.maxUses = positiveInt(body.maxUses, "maxUses");
  if (body.expiresAt) record.expiresAt = validDate(body.expiresAt, "expiresAt").toISOString();
  record.status = stringField(body, "status", record.status);
  addAudit(registry, "admin", "demo-admin", "enrollment_token.create", "enrollment_token", record.tokenId, {
    assignedStaffId: record.assignedStaffId,
    assignedGroup: record.assignedGroup,
    autoApprove: record.autoApprove,
  });
  saveRegistry(registry);
  sendJson(res, 201, { token, tokenRecord: { ...record, tokenHash: `${record.tokenHash.slice(0, 12)}...` } });
}

export async function adminDevices(ctx, res) {
  const registry = loadRegistry();
  const status = ctx.url.searchParams.get("status");
  const group = ctx.url.searchParams.get("group");
  let items = registry.devices;
  if (status) items = items.filter((device) => device.status === status);
  if (group) items = items.filter((device) => device.assignedGroups?.includes(group));
  sendJson(res, 200, {
    items: items.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  });
}

export async function adminDeviceDetail(ctx, res) {
  const deviceId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  sendJson(res, 200, {
    device,
    artifacts: registry.deviceArtifacts.filter((artifact) => artifact.deviceId === deviceId),
    identityClaims: registry.identityClaims.filter((claims) => claims.deviceId === deviceId),
    auditEvents: registry.auditEvents.filter((event) => event.targetId === deviceId || event.actorId === deviceId),
  });
}

export async function adminDeviceApprove(ctx, res) {
  const deviceId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  if (device.status !== "pending_approval") {
    sendJson(res, 200, { deviceId, status: device.status, message: "Device is not waiting for approval" });
    return;
  }
  device.status = "building";
  device.updatedAt = nowIso();
  for (const artifact of registry.deviceArtifacts.filter((item) => item.deviceId === deviceId && item.buildStatus === "waiting_approval")) {
    artifact.buildStatus = "queued";
  }
  addAudit(registry, "admin", "demo-admin", "device.approve", "device", deviceId, {});
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, status: device.status });
}

export async function adminDeviceRevoke(ctx, res) {
  const deviceId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  device.status = "revoked";
  device.updatedAt = nowIso();
  addAudit(registry, "admin", "demo-admin", "device.revoke", "device", deviceId, {});
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, status: device.status });
}

export async function adminDeviceAssignGroups(ctx, res) {
  const deviceId = decodeURIComponent(ctx.params[0] || "");
  const groups = Array.isArray(ctx.body?.assignedGroups) ? ctx.body.assignedGroups.map(String) : [];
  if (groups.length === 0) badRequest("assignedGroups must contain at least one group");
  const registry = loadRegistry();
  const device = findDevice(registry, deviceId);
  device.assignedGroups = groups;
  device.updatedAt = nowIso();
  addAudit(registry, "admin", "demo-admin", "device.assign_groups", "device", deviceId, { groups });
  saveRegistry(registry);
  sendJson(res, 200, { deviceId, assignedGroups: groups });
}

export async function adminArtifactBuildNext(ctx, res) {
  const registry = loadRegistry();
  const artifact = registry.deviceArtifacts.find((item) => item.buildStatus === "queued");
  if (!artifact) {
    sendJson(res, 404, { message: "No queued artifact found" });
    return;
  }
  buildArtifact(registry, artifact);
  saveRegistry(registry);
  sendJson(res, 200, { artifact });
}

export async function adminArtifactBuildById(ctx, res) {
  const artifactId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const artifact = findArtifact(registry, artifactId);
  buildArtifact(registry, artifact);
  saveRegistry(registry);
  sendJson(res, 200, { artifact });
}

export async function adminArtifactVerify(ctx, res) {
  const artifactId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const artifact = findArtifact(registry, artifactId);
  const result = verifyArtifact(registry, artifact);
  sendJson(res, result.valid ? 200 : 409, result);
}

export async function artifactDownload(ctx, res) {
  const artifactId = decodeURIComponent(ctx.params[0] || "");
  const registry = loadRegistry();
  const artifact = findArtifact(registry, artifactId);
  if (artifact.buildStatus !== "ready" && artifact.buildStatus !== "installed") {
    sendJson(res, 409, { message: "Artifact is not ready", artifactId, buildStatus: artifact.buildStatus });
    return;
  }
  const artifactPath = artifactPathFor(artifact.artifactId);
  if (!existsSync(artifactPath)) {
    sendJson(res, 404, { message: "Artifact file is missing", artifactId });
    return;
  }
  const data = readFileSync(artifactPath);
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-disposition": `attachment; filename="${artifact.artifactId}.hosteye-ci.json"`,
    "x-hosteye-artifact-sha256": artifact.sha256,
    "x-hosteye-artifact-signature": artifact.signature,
  });
  res.end(data);
}

export async function adminArtifacts(ctx, res) {
  const registry = loadRegistry();
  const status = ctx.url.searchParams.get("status");
  let items = registry.deviceArtifacts;
  if (status) items = items.filter((artifact) => artifact.buildStatus === status);
  sendJson(res, 200, {
    items: items.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  });
}

function loadRegistry() {
  if (!existsSync(registryPath)) {
    const registry = createEmptyRegistry();
    saveRegistry(registry);
    return registry;
  }
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    return {
      schemaVersion: 1,
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      enrollmentTokens: Array.isArray(parsed.enrollmentTokens) ? parsed.enrollmentTokens : [],
      deviceArtifacts: Array.isArray(parsed.deviceArtifacts) ? parsed.deviceArtifacts : [],
      identityClaims: Array.isArray(parsed.identityClaims) ? parsed.identityClaims : [],
      auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
    };
  } catch (cause) {
    const error = new Error("HostEye registry is not readable");
    error.statusCode = 500;
    error.detail = `${registryPath} - ${cause?.message || cause}`;
    throw error;
  }
}

function saveRegistry(registry) {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function createEmptyRegistry() {
  return {
    schemaVersion: 1,
    devices: [],
    enrollmentTokens: [],
    deviceArtifacts: [],
    identityClaims: [],
    auditEvents: [],
  };
}

function ensureEnrollmentToken(registry, token, defaults) {
  const tokenHash = sha256(token);
  let record = registry.enrollmentTokens.find((item) => item.tokenHash === tokenHash);
  if (record) return record;

  const now = nowIso();
  record = {
    tokenId: `token-${randomUUID()}`,
    tokenHash,
    issuedBy: "demo-admin",
    assignedStaffId: defaults.assignedStaffId || "unassigned",
    assignedGroup: defaults.assignedGroup || "lab-default",
    maxUses: 100,
    usedCount: 0,
    autoApprove: defaults.autoApprove !== false,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    status: "active",
    createdAt: now,
    lastUsedAt: "",
  };
  registry.enrollmentTokens.push(record);
  return record;
}

function findDevice(registry, deviceId) {
  const device = registry.devices.find((item) => item.deviceId === deviceId);
  if (!device) {
    const error = new Error("Device not found");
    error.statusCode = 404;
    throw error;
  }
  return device;
}

function findArtifact(registry, artifactId) {
  const artifact = registry.deviceArtifacts.find((item) => item.artifactId === artifactId);
  if (!artifact) {
    const error = new Error("Artifact not found");
    error.statusCode = 404;
    throw error;
  }
  return artifact;
}

function addAudit(registry, actorType, actorId, action, targetType, targetId, detail) {
  registry.auditEvents.push({
    eventId: `audit-${randomUUID()}`,
    actorType,
    actorId,
    action,
    targetType,
    targetId,
    ipAddress: "",
    detail,
    createdAt: nowIso(),
  });
}

function stringField(source, name, fallback) {
  const value = source?.[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return String(value).trim();
}

function normalizePlatform(osName) {
  const value = String(osName || "").toLowerCase();
  if (value.includes("windows")) return "windows";
  if (value.includes("mac") || value.includes("darwin")) return "macos";
  if (value.includes("linux") || value.includes("ubuntu") || value.includes("debian")) return "linux";
  return "unknown";
}

function buildArtifact(registry, artifact) {
  const device = findDevice(registry, artifact.deviceId);
  const claims = registry.identityClaims.find((item) => item.artifactId === artifact.artifactId);
  if (!claims) {
    const error = new Error("Identity claims not found for artifact");
    error.statusCode = 409;
    throw error;
  }

  const now = nowIso();
  const agentVersion = process.env.HOSTEYE_AGENT_VERSION || "1.0.0-ci-mvp";
  claims.agentVersion = agentVersion;
  claims.claimsJson.agent_version = agentVersion;
  claims.claimsSignature = signHostEyePayload(claims.claimsJson);

  const payload = {
    artifact_type: "hosteye-agent-ci-demo",
    artifact_id: artifact.artifactId,
    build_id: artifact.buildId,
    device_id: device.deviceId,
    host_id: device.hostId,
    staff_id: device.staffId,
    hostname: device.hostname,
    platform: artifact.platform,
    architecture: artifact.architecture,
    agent_version: agentVersion,
    identity_claims: claims.claimsJson,
    identity_claims_signature: claims.claimsSignature,
    certificate_serial: device.certificateSerial,
    generated_at: now,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  const artifactSha = sha256(serialized);
  const artifactSignature = signHostEyePayload({ artifact_id: artifact.artifactId, sha256: artifactSha });
  mkdirSync(artifactDir(), { recursive: true });
  writeFileSync(artifactPathFor(artifact.artifactId), serialized, "utf8");

  artifact.agentVersion = agentVersion;
  artifact.artifactUrl = `/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/download`;
  artifact.sha256 = artifactSha;
  artifact.signature = artifactSignature;
  artifact.identityClaimsHash = sha256(canonicalJson(claims.claimsJson));
  artifact.buildStatus = "ready";
  artifact.createdAt = artifact.createdAt || now;
  artifact.builtAt = now;
  device.status = "artifact_ready";
  device.currentAgentVersion = agentVersion;
  device.updatedAt = now;
  addAudit(registry, "build-orchestrator", artifact.buildId, "artifact.build", "artifact", artifact.artifactId, {
    deviceId: device.deviceId,
    sha256: artifact.sha256,
    signature: artifact.signature,
  });
}

function artifactDir() {
  return resolve(dirname(registryPath), "artifacts");
}

function artifactPathFor(artifactId) {
  return resolve(artifactDir(), `${artifactId}.hosteye-ci.json`);
}

function verifyArtifact(registry, artifact) {
  const artifactPath = artifactPathFor(artifact.artifactId);
  const claims = registry.identityClaims.find((item) => item.artifactId === artifact.artifactId);
  const checks = [];

  if (!claims) {
    checks.push({ name: "identity_claims_present", valid: false, detail: "Missing identity claims" });
  } else {
    checks.push({
      name: "identity_claims_signature",
      valid: verifyHostEyePayload(claims.claimsJson, claims.claimsSignature),
      detail: claims.claimsId,
    });
    checks.push({
      name: "identity_claims_hash",
      valid: artifact.identityClaimsHash === sha256(canonicalJson(claims.claimsJson)),
      detail: artifact.identityClaimsHash || "",
    });
  }

  if (!existsSync(artifactPath)) {
    checks.push({ name: "artifact_file_present", valid: false, detail: artifactPath });
  } else {
    const serialized = readFileSync(artifactPath, "utf8");
    const actualSha = sha256(serialized);
    checks.push({ name: "artifact_sha256", valid: actualSha === artifact.sha256, detail: actualSha });
    checks.push({
      name: "artifact_signature",
      valid: verifyHostEyePayload({ artifact_id: artifact.artifactId, sha256: artifact.sha256 }, artifact.signature),
      detail: artifact.signature || "",
    });
  }

  return {
    artifactId: artifact.artifactId,
    valid: checks.every((check) => check.valid),
    checks,
    signer: signingKeyInfo(),
  };
}

function issueDemoCertificate(device, publicKeySha256) {
  const subject = `CN=${device.deviceId}, O=HostEye, OU=${device.organizationUnit}`;
  const body = Buffer.from(JSON.stringify({
    subject,
    serial: device.certificateSerial,
    device_id: device.deviceId,
    host_id: device.hostId,
    public_key_sha256: publicKeySha256,
    issued_at: nowIso(),
  }, null, 2)).toString("base64");
  return {
    serial: device.certificateSerial,
    subject,
    certificatePem: `-----BEGIN HOSTEYE DEMO CERTIFICATE-----\n${body}\n-----END HOSTEYE DEMO CERTIFICATE-----`,
    caCertificatePem: "-----BEGIN HOSTEYE DEMO CA-----\nZGVtby1jYQ==\n-----END HOSTEYE DEMO CA-----",
  };
}

function positiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) badRequest(`${name} must be a positive integer`);
  return parsed;
}

function validDate(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) badRequest(`${name} must be a valid date`);
  return date;
}

function signHostEyePayload(payload) {
  const key = loadSigningKey();
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), key.privateKeyPem).toString("base64");
  return `ed25519:${key.keyId}:${signature}`;
}

function verifyHostEyePayload(payload, signatureEnvelope) {
  const [algorithm, keyId, signatureText] = String(signatureEnvelope || "").split(":");
  if (algorithm !== "ed25519" || !keyId || !signatureText) return false;
  const key = loadSigningKey();
  if (key.keyId !== keyId) return false;
  return verify(null, Buffer.from(canonicalJson(payload), "utf8"), key.publicKeyPem, Buffer.from(signatureText, "base64"));
}

function signingKeyInfo() {
  const key = loadSigningKey();
  return { keyId: key.keyId, algorithm: "ed25519", publicKeyPem: key.publicKeyPem };
}

function loadSigningKey() {
  const path = signingKeyPath();
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = {
    keyId: `hosteye-ed25519-${sha256(publicKey).slice(0, 16)}`,
    algorithm: "ed25519",
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    createdAt: nowIso(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, "utf8");
  return key;
}

function signingKeyPath() {
  return process.env.HOSTEYE_SIGNING_KEY_PATH || resolve(dirname(registryPath), "hosteye-signing-key.json");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}
