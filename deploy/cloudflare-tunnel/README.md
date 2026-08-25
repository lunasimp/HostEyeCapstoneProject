# HostEye Dashboard through Cloudflare Tunnel

This profile publishes only the existing Dashboard Web proxy. The Web proxy forwards `/api/*` to Dashboard API inside the local HostEye Docker network. ClickHouse, Redpanda, Control Plane, Dynamic Config, and telemetry collectors are not tunnel routes.

## Security boundary

- Cloudflare Tunnel makes an outbound connection; no router port-forward is required.
- Dashboard Web and API host ports bind to `127.0.0.1` only.
- Cloudflare Access must protect the entire `hosteye.csp.vn` hostname.
- HostEye authentication and role/permission checks remain required behind Access.
- API responses are non-cacheable and include anti-framing, CSP, referrer, and MIME-sniffing protections.
- Login attempts are limited locally. Add a Cloudflare rate-limit rule as the outer control.
- The tunnel token belongs only in `deploy/cloudflare-tunnel/.env`, which is ignored by Git.
- The Cloudflared image is pinned by digest so an unattended restart cannot silently switch connector builds.

## Cloudflare Zero Trust setup

1. Open **Zero Trust -> Networks -> Tunnels** and create a Cloudflared tunnel named `hosteye-dashboard`.
2. Copy the connector token only (the long value after `--token`) into a copy of `.env.example` named `.env`.
3. Add the public hostname `hosteye.csp.vn` with service type `HTTP` and URL `host.docker.internal:5174`.
4. If an old `A` or `CNAME` record already uses `hosteye.csp.vn`, remove it only when Cloudflare asks to replace it with the tunnel CNAME. Do not expose the origin IP.
5. Create a **Zero Trust -> Access -> Applications -> Self-hosted** application for `hosteye.csp.vn`.
6. Add an Allow policy containing only the project members' exact email addresses. Require the configured identity provider's MFA when available. Do not add a public Bypass policy.
7. Set a short Access session duration for demonstrations (for example, one hour).
8. Add a Cache Rule to bypass cache for `hosteye.csp.vn/api/*`.
9. Add a rate-limit rule for `POST /api/dashboard/auth/login`. The local API also limits failed login attempts to five per fifteen-minute window by default.

Cloudflare Access is an outer identity gate. Users still sign in to HostEye after Access succeeds, preserving HostEye roles, permissions, and audit identity.

## Start and stop

From an elevated PowerShell prompt in the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dashboard-tunnel.ps1
```

Stop only the tunnel without touching the local HostEye stack:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-dashboard-tunnel.ps1
```

Do not configure telemetry, enrollment, ClickHouse, Redpanda, or administrative backend routes in this tunnel. The public endpoint installer is a separate deployment profile and is not validated by this dashboard-only tunnel.

## Temporary URL without owning a domain

Cloudflare Quick Tunnel provides a random `https://*.trycloudflare.com` URL without a Cloudflare account or DNS zone:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-dashboard-quick-tunnel.ps1
```

The script verifies public health and confirms that a protected API route returns `401` without a HostEye bearer token. Quick Tunnel cannot use Cloudflare Access policies, has no uptime guarantee, and its hostname can change when recreated. Use it only for a supervised demonstration and stop it afterward:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\stop-dashboard-quick-tunnel.ps1
```
