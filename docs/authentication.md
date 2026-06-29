# Authentication & Authorization design

> Status: DESIGN. Adds an identity/access layer to the HA target. Pairs with `ha-architecture.md`
> (TLS terminates at the edge) and `dokploy-deployment.md`.

## 1. Current state & threat model

Today **nothing is authenticated** on the data path:

| Surface | Current | Risk |
|---|---|---|
| `/dashboard/`, `/api/*` | open to anyone | full SOC data exposed to the internet |
| `/api/v1/telemetry` (ingest) | open (mTLS deferred) | **anyone can inject/poison logs** |
| `/clickhouse/` | open, `default` user no password | arbitrary DB read/write |
| `/artifacts/` | open | installer + CA bundle download by anyone |
| Grafana | its own login (weak default) | dashboards exposed |
| Redpanda / Keeper | internal, no SASL | lateral movement if overlay reached |

The HA design must close all of these. Three distinct identity planes, each with a different
mechanism — do **not** try to force one scheme on all three.

## 2. Three identity planes

| Plane | Principals | Mechanism (recommended) | Enforced at |
|---|---|---|---|
| **Human** | analysts, admins | OIDC SSO via Traefik **forward-auth** | edge (Traefik middleware) |
| **Machine** | endpoint agents (SOCShipper) | per-agent **bearer token** (path back to existing mTLS) | edge-nginx / Vector |
| **Service** | dashboard-api, Vector, MVs | least-privilege DB users + Redpanda SASL | each backend |

## 3. Plane 1 — Human auth (dashboard, API, Grafana, /clickhouse)

**Approach:** enforce SSO at the **edge** with a Traefik `forwardAuth` middleware in front of every
human-facing route. The apps themselves stay auth-agnostic; the edge guarantees a request only
reaches them after the user is authenticated.

```
browser ──TLS──► Traefik ──forwardAuth──► IdP/auth service (OIDC)
                    │  (on success, inject identity headers)
                    ▼
              dashboard-web / dashboard-api / grafana / /clickhouse
              (trust X-Forwarded-User / X-Forwarded-Groups from Traefik only)
```

- **IdP options:** (a) **Google OIDC** (org already on Google / omelet.tech) — lowest friction;
  (b) self-hosted **Authentik/Authelia** — full control + role groups without Google. Authelia is a
  natural forward-auth companion; Authentik if a richer IdP/UI is wanted.
- **Roles → IdP groups:**
  - `hosteye-analyst` → read dashboards + read API.
  - `hosteye-admin` → analyst + `/clickhouse/` + admin endpoints + artifacts management.
- **dashboard-api change:** trust `X-Forwarded-User`/`X-Forwarded-Groups` **only** from the Traefik
  network (reject if set by anyone else); gate write/admin endpoints on `hosteye-admin`.
- **Sessions:** short-lived SSO cookie at the auth service; central logout; MFA delegated to the IdP.
- `/clickhouse/` and `/artifacts/` move **behind `hosteye-admin`** (or off the public domain entirely).

## 4. Plane 2 — Machine / agent ingest auth

Interactive OIDC can't be used by agents. Two mechanisms; **bearer token** is the primary for this
phase (consistent with the "TLS at edge, no mTLS" decision), with a documented return-to-mTLS path
because the PKI already exists.

### 4.1 Primary — per-agent bearer token
- **Issue** a token at enrollment (one per agent, or per fleet), tied to `agent_id`/`host_id`.
- **Carry** it in SOCShipper as `Authorization: Bearer <token>` (new field in `shipper-config.json`).
- **Validate** at `edge-nginx` (lookup against a token map / introspection) **before** proxying to
  `vector_gateways`; reject unknown/revoked with 401.
- **Rate-limit & quota per token** — replaces the old `$ssl_client_serial` per-client limit.
- **Revocation:** a denylist (or short TTL + refresh) so a compromised agent is cut off fast.
- **Rotation:** tokens expire; new token delivered via the signed-config channel (§4.3).

### 4.2 Stronger option — reinstate mTLS (existing PKI)
The repo already has the full client-cert lifecycle: `Issue-EndpointClientCert.ps1`,
`Register-EndpointClientCert.ps1`, `Revoke-EndpointClientCert.ps1`, and `Vector-HA-Cluster/nginx.conf`
with `ssl_verify_client optional` + `$ssl_client_serial` allowlist + per-serial rate limit.
To re-enable: add a **Traefik TCP passthrough entrypoint** (dedicated port) → internal nginx that
performs client-cert verification, instead of edge TLS termination. Low cost since the PKI and nginx
rules are already written. Recommended for true production.

### 4.3 Agent config pull (`/api/v1/agent/config/*`)
`SOC_UpdateServer` serves `master-vector.toml`/`manifest.json` **with detached signatures** (integrity
via `updater_public.pem`) but is currently **unauthenticated**. Add: require the agent's bearer token
(or client cert) to download config → prevents config/CA enumeration. Keep signatures for integrity
(defense in depth: auth = who can fetch, signature = payload not tampered).

## 5. Plane 3 — Service & data-store auth

| Service | Hardening |
|---|---|
| **ClickHouse** | set/disable `default` password; create least-privilege users: `dashboard_ro` (SELECT on dashboard tables) for dashboard-api, `ingest_rw` (INSERT) for Vector, separate `admin`. Credentials via Dokploy env, never in repo. |
| **`/clickhouse/` route** | remove from public **or** gate behind `hosteye-admin` (§3). Never expose a no-password user. |
| **Redpanda** | enable **SASL/SCRAM** between Vector (producer) and brokers; per-topic ACLs (`windows-logs-pool`: produce for Vector, consume for named consumers). Brokers internal-overlay only. |
| **ClickHouse Keeper** | internal overlay only; no public binding. |
| **Internal HTTP** | dashboard-api↔ClickHouse, Vector↔ClickHouse stay on the Swarm overlay network; not routed by Traefik. |

## 6. Authorization model

- **Roles:** `hosteye-analyst` (read), `hosteye-admin` (manage). Mapped from IdP groups; enforced at
  Traefik (route-level) and re-checked in dashboard-api for admin endpoints.
- **Service accounts:** `dashboard_ro`, `ingest_rw`, Redpanda SASL users — least privilege, no humans.
- **Future — multi-tenancy:** scope analysts to a subset of `agent_id`/`host_id` (row-level filter in
  dashboard-api queries keyed off the SSO group). Out of scope this phase; note the data already
  carries `agent_id`/`host_id` to make this possible later.

## 7. Secrets management

- All secrets (OIDC client secret, agent token signing key, ClickHouse passwords, Redpanda SASL,
  forward-auth session secret) live in **Dokploy env/secrets** — **never** committed to git.
- The agent-config **signing private key** stays on the build/update server only; `updater_public.pem`
  ships with agents (already the case).
- Define a rotation cadence: OIDC secret (per provider policy), agent tokens (TTL + refresh),
  DB/SASL credentials (scheduled), and a revocation runbook (see `operations.md`).

## 8. Required changes (build phase)

| Component | Change |
|---|---|
| Traefik | add `forwardAuth` middleware on human routes; (optional) TCP passthrough entrypoint for mTLS |
| Auth service | deploy IdP/forward-auth (Google OIDC bridge, or Authelia/Authentik) as an HA service |
| edge-nginx | validate `Authorization: Bearer` on `/api/v1/telemetry`; per-token rate-limit; 401 on bad token |
| dashboard-api | trust forward-auth identity headers (from Traefik only); gate admin endpoints by group; use `dashboard_ro` DB user |
| ClickHouse init | provision `dashboard_ro` / `ingest_rw` / `admin`; password the default user |
| Vector | use `ingest_rw` for ClickHouse sink; SASL creds for Redpanda producer |
| SOCShipper | add `AuthToken` config + `Authorization` header; (or keep client-cert for mTLS path) |
| SOC_UpdateServer | require agent auth on `/api/v1/agent/config/*`; deliver/rotate agent tokens |
| Redpanda | enable SASL/SCRAM + topic ACLs |

## 9. Token / session lifecycle (summary)

```
Human:  IdP login → SSO cookie (short TTL) → forwardAuth allows → identity headers → app
        logout / IdP revoke → next request blocked at edge.

Agent:  enroll → issue bearer token (TTL) → SOCShipper sends Bearer on every POST
        → edge-nginx validates (map/introspect) → allow/deny + per-token rate-limit
        rotate via signed-config channel; revoke via denylist (immediate cutoff).
```

## 10. Open decisions (confirm before build)

1. **Human IdP:** Google OIDC vs self-hosted Authelia/Authentik (roles without Google).
2. **Agent ingest auth (primary):** bearer token now (matches TLS-edge), or reinstate mTLS now
   (existing PKI, strongest) via Traefik TCP passthrough.
3. **Multi-tenancy:** single-tenant now, or scope analysts by `agent_id`/`host_id` from the start.
4. **`/clickhouse/` & `/artifacts/`:** gate behind admin SSO, or remove from the public domain.
