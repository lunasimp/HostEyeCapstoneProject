import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class RegistrationStore {
  constructor(file) {
    this.file = file;
  }

  listDevices() {
    return this.read().devices.map(publicDevice).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  createToken(input, actor = "dashboard-admin") {
    const state = this.read();
    const now = new Date();
    const ttlMinutes = boundedInteger(input.ttlMinutes, 60, 5, 10080, "ttlMinutes");
    const expectedHostname = text(input.expectedHostname, 255);
    if (expectedHostname && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(expectedHostname)) {
      throw httpError(400, "Expected hostname must be the literal Windows computer name, not a shell variable or command");
    }
    const token = `he_enroll_${randomBytes(32).toString("base64url")}`;
    const ciId = `ci-${randomUUID()}`;
    const record = {
      tokenId: randomUUID(),
      tokenHash: tokenHash(token),
      ciId,
      expectedHostname,
      owner: text(input.owner, 255),
      staffId: text(input.staffId, 128),
      deviceId: text(input.deviceId, 255),
      groupId: text(input.groupId || "default", 128),
      policyId: text(input.policyId || "policy-default-windows-baseline", 255),
      status: "Pending",
      createdAt: now.toISOString(),
      createdBy: actor,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60000).toISOString(),
      consumedAt: null,
      deviceRecordId: null,
    };
    state.tokens.push(record);
    state.version += 1;
    this.persist(state);
    return { token, tokenId: record.tokenId, ciId, expiresAt: record.expiresAt, status: record.status };
  }

  beginEnrollment(token, request) {
    const state = this.read();
    const record = state.tokens.find((item) => safeEqual(item.tokenHash, tokenHash(token)));
    if (!record) throw httpError(401, "Enrollment token is invalid");
    if (record.status !== "Pending") throw httpError(409, "Enrollment token has already been used");
    if (Date.parse(record.expiresAt) <= Date.now()) {
      record.status = "Expired";
      state.version += 1;
      this.persist(state);
      throw httpError(410, "Enrollment token has expired");
    }
    if (record.expectedHostname && normalizeHost(record.expectedHostname) !== normalizeHost(request.actualHostname)) {
      throw httpError(409, "Endpoint hostname does not match the enrollment token");
    }
    record.status = "Issuing";
    state.version += 1;
    this.persist(state);
    return { ...record };
  }

  cancelEnrollment(tokenId) {
    const state = this.read();
    const token = state.tokens.find((item) => item.tokenId === tokenId);
    if (token?.status === "Issuing") {
      token.status = "Pending";
      state.version += 1;
      this.persist(state);
    }
  }

  completeEnrollment(tokenId, request, certificate) {
    const state = this.read();
    const token = state.tokens.find((item) => item.tokenId === tokenId);
    if (!token || token.status !== "Issuing") throw httpError(409, "Enrollment token is no longer reservable");
    const now = new Date().toISOString();
    const device = {
      deviceRecordId: randomUUID(),
      ciId: token.ciId,
      agentId: requiredText(request.agentId, "agentId", 255),
      hostId: requiredText(request.hostId, "hostId", 255),
      staffId: token.staffId,
      deviceId: token.deviceId,
      owner: token.owner,
      expectedHostname: token.expectedHostname,
      actualHostname: requiredText(request.actualHostname, "actualHostname", 255),
      groupId: token.groupId,
      policyId: token.policyId,
      agentVersion: text(request.agentVersion, 64),
      status: "Active",
      certificateSerial: certificate.serial,
      certificateThumbprint: certificate.thumbprint,
      certificateSubject: certificate.subject,
      certificateNotAfter: certificate.notAfter,
      createdAt: now,
      updatedAt: now,
      enrolledAt: now,
      enrollmentTokenExpiresAt: token.expiresAt,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    };
    state.devices.push(device);
    token.status = "Consumed";
    token.consumedAt = now;
    token.deviceRecordId = device.deviceRecordId;
    state.version += 1;
    this.persist(state);
    return publicDevice(device);
  }

  revokeDevice(deviceRecordId, actor, reason) {
    const state = this.read();
    const device = state.devices.find((item) => item.deviceRecordId === deviceRecordId);
    if (!device) throw httpError(404, "Enrolled device was not found");
    if (device.status !== "Revoked") {
      device.status = "Revoked";
      device.revokedAt = new Date().toISOString();
      device.revokedBy = actor || "dashboard-admin";
      device.revokeReason = text(reason || "Revoked by administrator", 500);
      device.updatedAt = device.revokedAt;
      state.version += 1;
      this.persist(state);
    }
    return publicDevice(device);
  }

  validateIdentity(input) {
    const state = this.read();
    const device = state.devices.find((item) => item.ciId === input.ciId);
    if (!device) return { valid: false, status: "identity_unknown", message: "C_i is not registered" };
    if (device.status !== "Active") return { valid: false, status: "identity_revoked", message: `C_i is ${device.status.toLowerCase()}` };
    if (device.agentId !== input.agentId || device.hostId !== input.hostId) {
      return { valid: false, status: "identity_binding_mismatch", message: "C_i does not match Agent/Host identity" };
    }
    if (input.certificateSerial && normalizeSerial(device.certificateSerial) !== normalizeSerial(input.certificateSerial)) {
      return { valid: false, status: "certificate_mismatch", message: "Client certificate serial does not match C_i" };
    }
    if (device.certificateNotAfter && Date.parse(device.certificateNotAfter) <= Date.now()) {
      return { valid: false, status: "certificate_expired", message: "Client certificate has expired" };
    }
    return { valid: true, status: "active", message: "C_i identity accepted", device: publicDevice(device) };
  }

  read() {
    if (!existsSync(this.file)) return { version: 1, tokens: [], devices: [] };
    const parsed = JSON.parse(readFileSync(this.file, "utf8"));
    if (!Array.isArray(parsed.tokens) || !Array.isArray(parsed.devices)) throw new Error("Registration state is invalid");
    return parsed;
  }

  persist(state) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

function publicDevice(device) {
  return { ...device };
}

function tokenHash(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function safeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function text(value, maxLength) {
  const result = String(value || "").trim();
  if (result.length > maxLength) throw httpError(400, `Value must be at most ${maxLength} characters`);
  return result;
}

function requiredText(value, name, maxLength) {
  const result = text(value, maxLength);
  if (!result) throw httpError(400, `${name} is required`);
  return result;
}

function boundedInteger(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw httpError(400, `${name} must be between ${min} and ${max}`);
  return result;
}

function normalizeHost(value) { return String(value || "").trim().replace(/\.$/, "").toLowerCase(); }
function normalizeSerial(value) { return String(value || "").replace(/[^a-fA-F0-9]/g, "").replace(/^0+/, "").toLowerCase(); }

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
