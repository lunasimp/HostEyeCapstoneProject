# Authentication & Authorization design

> Status: DESIGN — **decisions locked**. Pairs with `ha-architecture.md` and `dokploy-deployment.md`.

## Locked decisions

1. **Ingest (machine): mTLS** — agents authenticate with a client certificate signed by the
   company CA, reusing the existing PKI (`Issue/Register/Revoke-EndpointClientCert.ps1`) and the
   `nginx.conf` allowlist. Delivered via a **Traefik TCP passthrough** entrypoint so the client
   cert reaches an internal nginx (TLS is *not* terminated at the edge for this path).
2. **Dashboard (human): Google OIDC → JWT/session** enforced at the edge via Traefik forward-auth.
3. **Single-tenant** — every analyst sees all hosts/agents (multi-tenant deferred).
4. **CA pinning for anti-MITM/DNS-poisoning** — the ingest listener presents a **company-CA** server
   cert; agents pin the company CA (already do). The human path uses Let's Encrypt at the edge.

## 1. Current state & threat model

Today **nothing is authenticated** on the data path:

| Surface | Current | Risk |
|---|---|---|
| `/dashboard/`, `/api/*` | open to anyone | full SOC data exposed to the internet |
| `/api/v1/telemetry` (ingest) | open | **anyone can inject/poison logs** |
| `/clickhouse/` | open, `default` user no password | arbitrary DB read/write |
| `/artifacts/` | open | installer + CA bundle download by anyone |
| Grafana | weak default login | dashboards exposed |
| Redpanda / Keeper | internal, no SASL | lateral movement if overlay reached |

The HA design closes all of these across **three identity planes** — each with a different
mechanism (do not force one scheme on all three).

## 2. Three identity planes

| Plane | Principals | Mechanism (locked) | Enforced at |
|---|---|---|---|
| **Human** | analysts, admins | **Google OIDC** → JWT/session via Traefik forward-auth | edge (Traefik middleware) |
| **Machine** | endpoint agents (SOCShipper) | **mTLS** (company-CA client cert) | internal nginx behind Traefik TCP passthrough |
| **Service** | dashboard-api, Vector, MVs | least-privilege DB users + Redpanda SASL | each backend |

## 3. Plane 1 — Human auth (dashboard, API, Grafana, /clickhouse)

**Approach:** enforce SSO at the **edge** with a Traefik `forwardAuth` middleware in front of every
human-facing route; the apps stay auth-agnostic.

```
browser ──TLS(LE)──► Traefik ──forwardAuth──► OIDC bridge ──► Google (OIDC)
                        │  on success: issue short-lived session/JWT,
                        │  inject X-Forwarded-User / X-Forwarded-Groups
                        ▼
                  dashboard-web / dashboard-api / grafana / /clickhouse
                  (trust identity headers from the Traefik network ONLY)
```

- **IdP: Google OIDC.** A forward-auth bridge (e.g. `oauth2-proxy` or Authelia in OIDC-client mode)
  runs the Google login flow and mints a short-lived **JWT/session cookie**.
- **JWT validity rules:** signed by the trusted issuer, verify `iss` + `aud` + `exp`; short TTL +
  refresh; MFA delegated to Google. The token is only meaningful behind TLS.
- **Roles → Google groups / allowed-domain claims:**
  - `hosteye-analyst` → read dashboards + read API.
  - `hosteye-admin` → analyst + `/clickhouse/` + admin endpoints + artifacts management.
- **dashboard-api change:** trust `X-Forwarded-User`/`X-Forwarded-Groups` **only** from the Traefik
  network (reject if a client sets them); gate admin endpoints on `hosteye-admin`.
- `/clickhouse/` and `/artifacts/` move **behind `hosteye-admin`** (or off the public domain).

> Why not mTLS for humans: client certs in browsers are poor UX and hard to manage. JWT-from-OIDC
> is the right fit for interactive human access.

## 4. Plane 2 — Machine / agent ingest auth (mTLS)

The native design for this system — endpoint telemetry from managed Windows machines that already
have a client-cert PKI and an agent (SOCShipper) that already supports it.

### 4.1 Topology — Traefik TCP passthrough → internal mTLS nginx

```
agent (SOCShipper, client cert)
   │ TLS (company-CA server cert, client cert presented)
   ▼  SNI = ingest.hosteye.iahn.hanoi.vn
Traefik TCP router (HostSNI + tls.passthrough)   ← does NOT terminate TLS
   │ raw TLS
   ▼
internal nginx  (ssl_verify_client, company CA, $ssl_client_serial allowlist + per-serial rate-limit)
   │ plaintext HTTP
   ▼
vector_gateways (pool of N)
```

- Two ingress patterns on **one port 443**, split by **SNI**:
  - `hosteye.iahn.hanoi.vn` → HTTP router, **LE termination + OIDC** (human).
  - `ingest.hosteye.iahn.hanoi.vn` → **TCP router, `tls.passthrough`** → internal nginx **mTLS**.
- Reuses `Vector-HA-Cluster/nginx.conf` as-is: `ssl_verify_client`, `map $ssl_client_serial`
  allowlist, `limit_req`/`limit_conn` per serial. The ingest server cert is signed by the
  **company CA** → agents pin company CA → strong anti-MITM/DNS-poisoning.
- **Cert lifecycle (existing PKI):** `Issue-EndpointClientCert.ps1` (issue), `Register-…` (allowlist),
  `Revoke-…` (remove). Automate issuance/renewal in enrollment; certs expire → renew before expiry.
- **SOCShipper:** already supports `ClientCertificateFile`/`ClientKeyFile`/`CaCertificateFile`
  (`BuildHttpClient`). Only config change: point `GatewayUri` at `ingest.hosteye.iahn.hanoi.vn`
  and ship the per-agent cert/key + company CA. **No new app code.**

### 4.2 Anti-DNS-poisoning note
DNS-poisoning/MITM protection comes from the **agent verifying the server cert** against the pinned
company CA (server-auth) — *not* from the client-cert part of mTLS. SOCShipper already pins the
company CA (`ServerCertificateCustomValidationCallback`). Keeping the ingest listener on the
**company CA** preserves this; if a path ever uses LE/public CA, pin that cert/CA explicitly.

### 4.3 Performance
- mTLS cost is **per TLS handshake, not per request**. With HTTP **keep-alive** + SOCShipper batching
  (1000 events / 1 MB), handshakes are rare → per-event overhead ≈ 0; the data plane (gzip, JSON
  parse, ClickHouse insert) dominates. Expected auth overhead **< 1–2%**.
- Tuning: **ECDSA P-256** client/server certs (cheaper than RSA), **TLS session resumption**, and
  keep-alive → mTLS overhead becomes negligible.

### 4.4 Agent config pull (`/api/v1/agent/config/*`)
`SOC_UpdateServer` serves `master-vector.toml`/`manifest.json` with detached signatures (integrity)
but is currently **unauthenticated**. Require the agent **client cert** (same mTLS) to download
config → prevents config/CA enumeration; keep signatures for payload integrity (defense in depth).

### 4.5 Deferred alternative — bearer token
A per-agent bearer token (validated at edge-nginx, works with edge TLS, no TCP passthrough) was
considered. Rejected as primary because mTLS is stronger (proof-of-possession, no secret on the
wire) and already ~built here. Keep as a fallback if a future client can't do mTLS.

## 5. Plane 3 — Service & data-store auth

| Service | Hardening |
|---|---|
| **ClickHouse** | password/disable `default`; least-privilege users: `dashboard_ro` (SELECT) for dashboard-api, `ingest_rw` (INSERT) for Vector, separate `admin`. Credentials via Dokploy env, never in repo. |
| **`/clickhouse/` route** | behind `hosteye-admin` (§3) or removed from public. Never expose a no-password user. |
| **Redpanda** | **SASL/SCRAM** between Vector and brokers; per-topic ACLs (`windows-logs-pool`). Brokers internal-overlay only. |
| **ClickHouse Keeper** | internal overlay only; no public binding. |
| **Internal HTTP** | dashboard-api↔ClickHouse, Vector↔ClickHouse stay on the Swarm overlay; not routed by Traefik. |

## 6. Authorization model

- **Roles:** `hosteye-analyst` (read), `hosteye-admin` (manage) — from Google groups/claims; enforced
  at Traefik (route-level) and re-checked in dashboard-api for admin endpoints.
- **Tenancy: single-tenant (locked).** Every analyst sees all `agent_id`/`host_id`. The data already
  carries `agent_id`/`host_id`, so row-level multi-tenant scoping can be added later without schema
  change.
- **Service accounts:** `dashboard_ro`, `ingest_rw`, Redpanda SASL users — least privilege, no humans.

## 7. Secrets management

- All secrets (Google OIDC client secret, forward-auth session secret, ClickHouse passwords,
  Redpanda SASL) live in **Dokploy env/secrets** — never committed to git.
- The agent-config **signing private key** and the **company CA key** stay on the build/update
  server only; `company_ca.crt` + `updater_public.pem` ship with agents (already the case).
- Rotation: OIDC secret (per policy), client certs (renew before expiry), DB/SASL creds (scheduled);
  revocation runbook in `operations.md`.

## 8. Required changes (build phase)

| Component | Change |
|---|---|
| Traefik | HTTP router (LE + `forwardAuth`) for `hosteye…`; **TCP router `tls.passthrough`** (HostSNI `ingest.hosteye…`) → internal nginx |
| forward-auth | deploy OIDC bridge (oauth2-proxy / Authelia) wired to **Google**, as an HA service |
| internal nginx (ingest) | reuse `Vector-HA-Cluster/nginx.conf`: `ssl_verify_client` + serial allowlist + per-serial rate-limit → `vector_gateways` |
| dashboard-api | trust forward-auth identity headers (Traefik net only); gate admin by group; use `dashboard_ro` DB user |
| ClickHouse init | provision `dashboard_ro` / `ingest_rw` / `admin`; password the default user |
| Vector | use `ingest_rw` for ClickHouse sink; SASL creds for Redpanda producer |
| SOCShipper | config only: `GatewayUri` → `ingest.hosteye…`, ship per-agent cert/key + company CA (no code change) |
| SOC_UpdateServer | require client cert on `/api/v1/agent/config/*` |
| Redpanda | enable SASL/SCRAM + topic ACLs |
| PKI ops | automate `Issue/Register/Revoke` + renewal in enrollment |

## 9. Lifecycle summary

```
Human:  Google OIDC login → forward-auth mints short-lived session/JWT → identity headers → app.
        logout / Google revoke → next request blocked at the edge.

Agent:  enroll → Issue-EndpointClientCert + Register (allowlist) → SOCShipper presents client cert
        on every connection → internal nginx verifies (CA + serial allowlist) + rate-limits per serial.
        renew cert before expiry; Revoke-EndpointClientCert → removed from allowlist (immediate cutoff).
```

## 10. Remaining minor decisions
- `/clickhouse/` & `/artifacts/`: gate behind `hosteye-admin` vs remove from the public domain.
- Forward-auth implementation: `oauth2-proxy` vs Authelia (both fine for Google OIDC).
- Ingest hostname (`ingest.hosteye.iahn.hanoi.vn`) vs a dedicated port — SNI passthrough on 443 preferred.
