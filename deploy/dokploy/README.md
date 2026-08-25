# HostEye public deployment on Dokploy

This deployment is isolated from the local development stack:

- Compose project: `hosteye-public`
- Network: `hosteye-public-network`
- Volumes: all prefixed with `hosteye_public_`
- No host ports are published
- Dokploy exposes only `edge-router` port `8080`

## Dokploy configuration

1. Create a Compose application from this repository.
2. Set the Compose path to `deploy/dokploy/docker-compose.hosteye-public.yml`.
3. Copy the variables from `.env.public.example` into Dokploy and replace every placeholder.
4. Add the domain `hosteye.csp.vn` to service `edge-router`, container port `8080`, with HTTPS enabled.
5. In Cloudflare, point `hosteye.csp.vn` to the Dokploy server. Start with DNS-only while validating origin TLS; enable the proxy only after the endpoint tests pass.

Do not expose ClickHouse, Redpanda, Control Plane, or collector ports directly.

ClickHouse currently keeps the repository's internal no-password profile because the Rust backend and worker do not yet attach ClickHouse credentials. It is reachable only inside `hosteye-public-network`. Adding ClickHouse authentication must be implemented across every server-side client and system-tested separately.

## Validation before installing an endpoint

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-public-deployment.ps1 -BaseUrl https://hosteye.csp.vn
```

Only distribute the public installer after this validation passes.

## Public installer

Builds to a different filename and uses a separate generated settings file, so it does not overwrite the tested LocalTest installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\HostEyeAgent\build-public-installer.ps1
```

Expected artifact:

`HostEyeAgent\Output\HostEye_Endpoint_Installer_Public_CSP.exe`

This first public profile uses one collector. Additional collectors can be added after capacity measurements justify horizontal scaling.

## TLS and mTLS

Dokploy terminates normal HTTPS for this profile. If direct Agent-to-Gateway mTLS is required, use a separate DNS-only ingestion hostname and terminate client-certificate TLS at an mTLS-aware edge proxy instead of the default Dokploy HTTP router.
