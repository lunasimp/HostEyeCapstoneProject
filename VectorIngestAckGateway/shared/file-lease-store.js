const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createFileLeaseStore(options = {}) {
  const rootDir = options.rootDir || process.env.LEASE_STORE_DIR || "/var/lib/hosteye/leases";
  const now = options.now || (() => new Date());
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());

  async function issueLease(input) {
    await fs.promises.mkdir(rootDir, { recursive: true });
    const leaseId = randomUUID();
    const issuedAt = now();
    const ttlSeconds = Number(input.leaseTtlSeconds || 30);
    const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
    const lease = {
      lease_id: leaseId,
      collector_id: String(input.collectorId || ""),
      collector_url: String(input.collectorUrl || ""),
      agent_id: String(input.agentId || ""),
      host_id: String(input.hostId || ""),
      computer: String(input.computer || ""),
      issued_at: issuedAt.toISOString(),
      send_after: isoDateOrNow(input.sendAfter, issuedAt),
      expires_at: expiresAt.toISOString(),
      lease_ttl_seconds: ttlSeconds,
      used_at: "",
      status: "issued",
      max_batch_mb: Number(input.maxBatchMb || 5),
      max_upload_rate_kbps: Number(input.maxUploadRateKbps || 1024)
    };
    await writeLease(lease);
    return lease;
  }

  async function validateAndConsume(payload, collectorId) {
    const leaseId = String(payload.lease_id || "");
    if (!leaseId) {
      return { ok: false, statusCode: 428, status: "lease_required", message: "upload lease_id is required" };
    }

    const lease = await readLease(leaseId);
    if (!lease) {
      return { ok: false, statusCode: 409, status: "lease_invalid", message: "upload lease is missing or expired" };
    }
    if (lease.status === "used" || lease.used_at) {
      return { ok: false, statusCode: 409, status: "lease_used", message: "upload lease was already used" };
    }
    if (Date.parse(lease.expires_at) <= now().getTime()) {
      lease.status = "expired";
      await writeLease(lease);
      return { ok: false, statusCode: 409, status: "lease_expired", message: "upload lease expired" };
    }
    if (lease.send_after && Date.parse(lease.send_after) > now().getTime()) {
      return {
        ok: false,
        statusCode: 425,
        status: "lease_too_early",
        message: "upload attempted before send_after"
      };
    }
    if (lease.collector_id && collectorId && lease.collector_id !== collectorId) {
      return { ok: false, statusCode: 403, status: "lease_collector_mismatch", message: "upload lease collector mismatch" };
    }
    if (lease.agent_id && lease.agent_id !== String(payload.agent_id || "")) {
      return { ok: false, statusCode: 403, status: "lease_agent_mismatch", message: "upload lease agent mismatch" };
    }
    if (lease.host_id && lease.host_id !== String(payload.host_id || "")) {
      return { ok: false, statusCode: 403, status: "lease_host_mismatch", message: "upload lease host mismatch" };
    }
    if (lease.computer && lease.computer !== String(payload.computer || "")) {
      return { ok: false, statusCode: 403, status: "lease_computer_mismatch", message: "upload lease computer mismatch" };
    }

    const batchMb = payloadBatchMb(payload);
    if (lease.max_batch_mb > 0 && batchMb > lease.max_batch_mb) {
      return { ok: false, statusCode: 413, status: "lease_batch_too_large", message: `batch ${batchMb.toFixed(3)} MB exceeds lease max ${lease.max_batch_mb} MB` };
    }

    lease.status = "used";
    lease.used_at = now().toISOString();
    await writeLease(lease);
    return { ok: true, status: "lease_consumed", lease };
  }

  async function readLease(leaseId) {
    const file = leasePath(leaseId);
    try {
      return JSON.parse(await fs.promises.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeLease(lease) {
    await fs.promises.mkdir(rootDir, { recursive: true });
    await fs.promises.writeFile(leasePath(lease.lease_id), JSON.stringify(lease, null, 2));
  }

  function leasePath(leaseId) {
    return path.join(rootDir, `${safeFilePart(leaseId)}.json`);
  }

  async function countActive(collectorId = "") {
    try {
      const files = await fs.promises.readdir(rootDir);
      const nowMs = now().getTime();
      let active = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const lease = JSON.parse(await fs.promises.readFile(path.join(rootDir, file), "utf8"));
          if (collectorId && lease.collector_id !== collectorId) continue;
          if (lease.status !== "issued") continue;
          if (Date.parse(lease.expires_at) <= nowMs) continue;
          active++;
        } catch {
          continue;
        }
      }
      return active;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  return {
    issueLease,
    validateAndConsume,
    readLease,
    countActive
  };
}

function payloadBatchMb(payload) {
  const batchBytes = Number(payload.batch_bytes || 0);
  if (batchBytes > 0) return batchBytes / 1024 / 1024;
  return Buffer.byteLength(JSON.stringify(payload.events || []), "utf8") / 1024 / 1024;
}

function safeFilePart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 128);
}

function isoDateOrNow(value, fallbackDate) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? fallbackDate.toISOString() : new Date(parsed).toISOString();
}

module.exports = {
  createFileLeaseStore
};
