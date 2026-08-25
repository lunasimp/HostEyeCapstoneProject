import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { CertificateAuthority } from "./certificate-authority.js";
import { RegistrationStore, httpError } from "./store.js";

export function createRegistrationServer(options = {}) {
  const store = options.store || new RegistrationStore(resolve(process.env.HOSTEYE_REGISTRATION_STORE || "data/registration-state.json"));
  const authority = options.authority || new CertificateAuthority({
    openssl: process.env.HOSTEYE_OPENSSL || "openssl",
    caCertificate: resolve(process.env.HOSTEYE_CA_CERTIFICATE || "data/ca/company_ca.crt"),
    caPrivateKey: resolve(process.env.HOSTEYE_CA_PRIVATE_KEY || "data/ca/company_ca.key"),
    certificateDays: Number(process.env.HOSTEYE_CLIENT_CERTIFICATE_DAYS || 90),
  });
  const adminToken = options.adminToken || process.env.HOSTEYE_REGISTRATION_ADMIN_TOKEN || "";
  const bootstrapSigningKey = options.bootstrapSigningKey || process.env.HOSTEYE_BOOTSTRAP_SIGNING_KEY || "";
  if (!adminToken || adminToken.length < 16) throw new Error("HOSTEYE_REGISTRATION_ADMIN_TOKEN must be at least 16 characters");
  if (!bootstrapSigningKey || bootstrapSigningKey.length < 32) throw new Error("HOSTEYE_BOOTSTRAP_SIGNING_KEY must be at least 32 characters");

  return http.createServer(async (req, res) => {
    setHeaders(res);
    if (req.method === "OPTIONS") return endJson(res, 204, {});
    try {
      const url = new URL(req.url, "http://registration.local");
      if (req.method === "GET" && url.pathname === "/health") return endJson(res, 200, { ok: true, service: "hosteye-registration" });
      if (req.method === "POST" && url.pathname === "/api/v1/enroll") {
        const body = await readJson(req);
        validateEnrollment(body);
        const reservation = store.beginEnrollment(body.token, body);
        try {
          const certificate = await authority.signCsr(body.csr, reservation.ciId);
          const device = store.completeEnrollment(reservation.tokenId, body, certificate);
          const bootstrap = {
            version: 1,
            issuedAt: new Date().toISOString(),
            ciId: device.ciId,
            agentId: device.agentId,
            hostId: device.hostId,
            groupId: device.groupId,
            policyId: device.policyId,
            controlUrl: process.env.HOSTEYE_CONTROL_URL || "http://127.0.0.1:8080/api/v1/control/bootstrap",
            admissionUrl: process.env.HOSTEYE_ADMISSION_URL || "http://127.0.0.1:8080/api/v1/admission/request",
            telemetryUrl: process.env.HOSTEYE_TELEMETRY_URL || "http://127.0.0.1:8088/api/v1/telemetry/collector-a",
            configUrl: process.env.HOSTEYE_CONFIG_URL || "http://127.0.0.1:5063/api/v1/dynamic-config/agent-config",
          };
          const canonical = JSON.stringify(bootstrap);
          return endJson(res, 201, {
            ciId: device.ciId,
            device,
            certificatePem: certificate.certificatePem,
            caCertificatePem: certificate.caCertificatePem,
            bootstrap,
            bootstrapCanonical: canonical,
            bootstrapSignature: createHmac("sha256", bootstrapSigningKey).update(canonical).digest("base64url"),
            bootstrapSignatureAlgorithm: "hmac-sha256",
          });
        } catch (error) {
          store.cancelEnrollment(reservation.tokenId);
          throw error;
        }
      }

      requireAdmin(req, adminToken);
      if (req.method === "GET" && url.pathname === "/api/v1/admin/devices") return endJson(res, 200, store.listDevices());
      if (req.method === "POST" && url.pathname === "/api/v1/admin/tokens") {
        const body = await readJson(req);
        return endJson(res, 201, store.createToken(body, req.headers["x-hosteye-actor"] || "dashboard-admin"));
      }
      const revoke = url.pathname.match(/^\/api\/v1\/admin\/devices\/([^/]+)\/revoke$/);
      if (req.method === "POST" && revoke) {
        const body = await readJson(req);
        return endJson(res, 200, store.revokeDevice(decodeURIComponent(revoke[1]), req.headers["x-hosteye-actor"], body.reason));
      }
      if (req.method === "POST" && url.pathname === "/api/v1/identity/validate") {
        const result = store.validateIdentity(await readJson(req));
        return endJson(res, result.valid ? 200 : 403, result);
      }
      throw httpError(404, "Registration endpoint was not found");
    } catch (error) {
      endJson(res, Number(error.statusCode || 500), { message: error.statusCode ? error.message : "Registration service failed", detail: process.env.NODE_ENV === "production" ? undefined : error.message });
    }
  });
}

function validateEnrollment(body) {
  for (const field of ["token", "agentId", "hostId", "actualHostname", "csr"]) {
    if (!String(body[field] || "").trim()) throw httpError(400, `${field} is required`);
  }
  if (!/-----BEGIN (NEW )?CERTIFICATE REQUEST-----[\s\S]+-----END (NEW )?CERTIFICATE REQUEST-----/.test(body.csr)) {
    throw httpError(400, "csr must be a PEM PKCS#10 certificate request");
  }
}

function requireAdmin(req, expected) {
  const actual = String(req.headers["x-hosteye-admin-token"] || "");
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw httpError(401, "Registration administrator token is invalid");
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw httpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "Request body must be valid JSON"); }
}

function setHeaders(res) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
}

function endJson(res, status, payload) {
  res.writeHead(status);
  res.end(status === 204 ? "" : JSON.stringify(payload));
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 5054);
  createRegistrationServer().listen(port, "0.0.0.0", () => console.log(`HostEye Registration listening on ${port}`));
}
