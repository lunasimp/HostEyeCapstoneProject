import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CertificateAuthority {
  constructor(options) {
    this.openssl = options.openssl || "openssl";
    this.caCertificate = options.caCertificate;
    this.caPrivateKey = options.caPrivateKey;
    this.certificateDays = Number(options.certificateDays || 90);
  }

  async ensure() {
    await mkdir(dirname(this.caCertificate), { recursive: true });
    try {
      await Promise.all([readFile(this.caCertificate), readFile(this.caPrivateKey)]);
      return;
    } catch {}
    await execFileAsync(this.openssl, [
      "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256",
      "-days", "3650", "-subj", "/CN=HostEye Enrollment CA/O=HostEye",
      "-keyout", this.caPrivateKey, "-out", this.caCertificate,
    ]);
  }

  async signCsr(csrPem, ciId) {
    await this.ensure();
    const directory = await mkdtemp(join(tmpdir(), "hosteye-enroll-"));
    const csr = join(directory, "endpoint.csr");
    const certificate = join(directory, "endpoint.crt");
    const extensions = join(directory, "client-ext.cnf");
    try {
      await writeFile(csr, csrPem, { encoding: "utf8", mode: 0o600 });
      await writeFile(extensions, [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=clientAuth",
        `subjectAltName=URI:hosteye:ci:${ciId}`,
      ].join("\n"), "utf8");
      await execFileAsync(this.openssl, [
        "x509", "-req", "-in", csr, "-CA", this.caCertificate, "-CAkey", this.caPrivateKey,
        "-CAcreateserial", "-days", String(this.certificateDays), "-sha256",
        "-extfile", extensions, "-out", certificate,
      ]);
      const certificatePem = await readFile(certificate, "utf8");
      const { stdout } = await execFileAsync(this.openssl, ["x509", "-in", certificate, "-noout", "-serial", "-fingerprint", "-sha256", "-enddate", "-subject"]);
      return { certificatePem, caCertificatePem: await readFile(this.caCertificate, "utf8"), ...parseCertificateMetadata(stdout) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function parseCertificateMetadata(output) {
  const value = String(output || "");
  const serial = value.match(/^serial=(.+)$/mi)?.[1]?.trim() || "";
  const thumbprint = value.match(/^sha256 Fingerprint=(.+)$/mi)?.[1]?.replace(/:/g, "").trim() || "";
  const notAfterRaw = value.match(/^notAfter=(.+)$/mi)?.[1]?.trim() || "";
  const subject = value.match(/^subject=(.+)$/mi)?.[1]?.trim() || "";
  return { serial, thumbprint, subject, notAfter: notAfterRaw ? new Date(notAfterRaw).toISOString() : null };
}
