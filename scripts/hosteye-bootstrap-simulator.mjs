import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname, platform, release, arch } from "node:os";
import { resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const apiBase = trimSlash(options.api || process.env.HOSTEYE_API_BASE || "http://127.0.0.1:5055");
const token = options.token || process.env.HOSTEYE_ENROLLMENT_TOKEN || "lab-auto-enroll";
const host = options.hostname || hostname();
const staffId = options.staffId || process.env.HOSTEYE_STAFF_ID || "bootstrap-sim";
const userName = options.userName || process.env.USERNAME || process.env.USER || staffId;
const organizationUnit = options.organizationUnit || "FPT/IAHN/Bootstrap";
const outputRoot = resolve(options.output || "bootstrap-output");
const shouldBuild = options.build !== "false";

const keyPair = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const enrollment = await postJson("/api/v1/enrollment/start", {
  enrollmentToken: token,
  hostname: host,
  staffId,
  userName,
  organizationUnit,
  osName: platformName(),
  osVersion: release(),
  architecture: arch(),
  hardwareFingerprint: hardwareFingerprint(host),
  publicKeyPem: keyPair.publicKey,
  csrPem: demoCsr(keyPair.publicKey, host),
  assignedGroups: [options.group || "bootstrap-sim"],
});

if (enrollment.status === "pending_approval") {
  throw new Error(`Device ${enrollment.deviceId} is pending admin approval; approve it before continuing.`);
}

let artifact = null;
if (shouldBuild) {
  const build = await postJson(`/api/v1/admin/artifacts/${encodeURIComponent(enrollment.artifactId)}/build`, {});
  artifact = build.artifact;
}

const verify = await postJson(`/api/v1/admin/artifacts/${encodeURIComponent(enrollment.artifactId)}/verify`, {});
if (!verify.valid) {
  throw new Error(`Artifact verification failed: ${JSON.stringify(verify.checks)}`);
}

const download = await fetch(`${apiBase}/api/v1/artifacts/${encodeURIComponent(enrollment.artifactId)}/download`, { cache: "no-store" });
if (!download.ok) throw new Error(`Artifact download failed: ${download.status} ${await download.text()}`);
const artifactBytes = Buffer.from(await download.arrayBuffer());
const artifactSha = sha256(artifactBytes);
const expectedSha = download.headers.get("x-hosteye-artifact-sha256") || artifact?.sha256 || "";
if (artifactSha !== expectedSha) {
  throw new Error(`Downloaded artifact SHA mismatch: expected=${expectedSha} actual=${artifactSha}`);
}

const deviceDir = resolve(outputRoot, enrollment.deviceId);
await mkdir(deviceDir, { recursive: true });
await writeFile(resolve(deviceDir, "client.key"), keyPair.privateKey, "utf8");
await writeFile(resolve(deviceDir, "client.crt"), enrollment.certificate.certificatePem, "utf8");
await writeFile(resolve(deviceDir, "company_ca.crt"), enrollment.certificate.caCertificatePem, "utf8");
await writeFile(resolve(deviceDir, `${enrollment.artifactId}.hosteye-ci.json`), artifactBytes);
await writeFile(resolve(deviceDir, "bootstrap-result.json"), `${JSON.stringify({ enrollment, verify, artifactSha }, null, 2)}\n`, "utf8");

const complete = await postJson("/api/v1/enrollment/complete", {
  deviceId: enrollment.deviceId,
  artifactId: enrollment.artifactId,
  agentVersion: artifact?.agentVersion || enrollment.identityClaims?.agent_version || "unknown",
  policyVersion: options.policyVersion || "bootstrap-sim-policy",
  certificateSerial: enrollment.certificate.serial,
});

console.log(JSON.stringify({
  ok: true,
  deviceId: enrollment.deviceId,
  hostId: enrollment.hostId,
  artifactId: enrollment.artifactId,
  artifactSha,
  status: complete.status,
  outputDir: deviceDir,
}, null, 2));

async function postJson(path, body) {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const index = arg.indexOf("=");
    if (index === -1) parsed[arg.slice(2)] = "true";
    else parsed[arg.slice(2, index)] = arg.slice(index + 1);
  }
  return parsed;
}

function platformName() {
  const value = platform();
  if (value === "win32") return "Windows";
  if (value === "darwin") return "macOS";
  return value;
}

function hardwareFingerprint(hostName) {
  return [
    `hostname=${hostName}`,
    `platform=${platform()}`,
    `release=${release()}`,
    `arch=${arch()}`,
  ].join(";");
}

function demoCsr(publicKeyPem, hostName) {
  const body = Buffer.from(JSON.stringify({ host: hostName, publicKeyPem }, null, 2)).toString("base64");
  return `-----BEGIN HOSTEYE DEMO CSR-----\n${body}\n-----END HOSTEYE DEMO CSR-----`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}
