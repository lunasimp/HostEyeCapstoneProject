import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CertificateAuthority } from "../src/certificate-authority.js";

const execFileAsync = promisify(execFile);

test("OpenSSL CA signs a client-auth certificate bound to the allocated C_i", async (t) => {
  try {
    await execFileAsync("openssl", ["version"]);
  } catch {
    t.skip("OpenSSL is not available on this host");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "hosteye-real-ca-"));
  const keyPath = join(directory, "endpoint.key");
  const csrPath = join(directory, "endpoint.csr");
  const certificatePath = join(directory, "endpoint.crt");
  const ciId = "ci-11111111-2222-4333-8444-555555555555";
  try {
    await execFileAsync("openssl", [
      "req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
      "-subj", "/CN=agent-integration/OU=HostEye Endpoint/O=HostEye",
      "-keyout", keyPath, "-out", csrPath,
    ]);
    const authority = new CertificateAuthority({
      openssl: "openssl",
      caCertificate: join(directory, "ca", "company_ca.crt"),
      caPrivateKey: join(directory, "ca", "company_ca.key"),
      certificateDays: 30,
    });
    const signed = await authority.signCsr(await readFile(csrPath, "utf8"), ciId);
    await writeFile(certificatePath, signed.certificatePem, "utf8");

    assert.match(signed.certificatePem, /BEGIN CERTIFICATE/);
    assert.match(signed.caCertificatePem, /BEGIN CERTIFICATE/);
    assert.ok(signed.serial);
    assert.match(signed.thumbprint, /^[0-9A-F]{64}$/i);
    assert.match(signed.subject, /CN\s*=\s*agent-integration/);
    assert.ok(Date.parse(signed.notAfter) > Date.now());

    const { stdout } = await execFileAsync("openssl", ["x509", "-in", certificatePath, "-noout", "-text"]);
    assert.match(stdout, /TLS Web Client Authentication/);
    assert.match(stdout, new RegExp(`URI:hosteye:ci:${ciId}`));
    assert.match(stdout, /CA:FALSE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
