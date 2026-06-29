# Dokploy multi-node deployment plan

> Status: DESIGN. Describes how the target HA architecture maps onto Dokploy + Docker Swarm,
> the prerequisites that must be provisioned first, and a phased rollout.

## 1. Prerequisites (blocking)

The current Dokploy FU panel has **0 remote servers** (single node) — confirmed via
`dokploy server all`. Multi-node HA cannot be built until these exist:

1. **≥3 Linux servers** (baseline). Recommended same region/low-latency network. Sizing driven by
   ClickHouse (RAM for merges, SSD for data + 90-day TTL). 4–6 nodes if sharding for scale.
2. **Add each server in Dokploy** (`Servers` → add; or `dokploy server` CLI group) so Dokploy can
   manage them and join them to a **Docker Swarm** (Dokploy supports Swarm via the `swarm` /
   `cluster` command groups).
3. **Swarm initialized** with the nodes as managers/workers (stateful services pinned via node
   labels — see §3).
4. **Object storage bucket** for ClickHouse backups (see `operations.md`).
5. **DNS**: `hosteye.iahn.hanoi.vn` (and any new HA host) pointing at the Swarm ingress
   (Traefik). Note the still-open item that the current record points at the wrong IP.

## 2. Deployment unit: one Dokploy **Compose** service (Swarm-aware)

A multi-service stack with internal networking is a natural **Dokploy Compose** deployment.
On a multi-node Swarm, Dokploy deploys the compose stack with `deploy:` directives honored.

- **Source:** custom-git over SSH (the deploy key already added to `f-smooth-criminal-lab-team`).
- **Compose path:** a new `Vector-HA-Cluster/docker-compose.ha.yml` (to be written in the build
  phase), derived from the existing `docker-compose.yml` with the changes in §3–§5.
- **Ingress:** only `edge-nginx` is exposed; Traefik routes the domain to it. All other services
  talk over the compose/overlay network.

## 3. Service → Swarm mapping

| Service | Replicas | Placement | Volume (node-local) | Notes |
|---|---|---|---|---|
| `edge-nginx` | global/3 | any | — | one-port reverse proxy; Traefik labels for the domain |
| `vector-gateway` | 3→N | spread | `vec_buffer_<n>` | disk buffer; stateless; scale freely |
| `redpanda-{1,2,3}` | 1 each | **pinned** node-1/2/3 | `rp_data_<n>` | RF=3, `acks=all`; node labels |
| `ch-keeper-{1,2,3}` | 1 each | **pinned** node-1/2/3 | `keeper_<n>` | 3-node Raft quorum |
| `clickhouse-{1,2,3}` | 1 each | **pinned** node-1/2/3 | `ch_data_<n>` | Replicated tables; macros per node |
| `dashboard-api` | 2→N | spread | — | reads ClickHouse Distributed |
| `dashboard-web` | 2→N | spread | — | static UI |
| `grafana` | 1 | any | `grafana_data` | optional; HA later via external DB |

**Why pinning:** Swarm does not provide shared storage. Each stateful replica must stay on the
node that owns its local volume, so it always re-attaches the same data. Use Swarm **node labels**
(`hosteye.role=ch1`, etc.) and `deploy.placement.constraints`.

```yaml
# sketch — clickhouse replica pinned to its node + its local volume
clickhouse-1:
  image: clickhouse/clickhouse-server:latest
  volumes: [ "ch_data_1:/var/lib/clickhouse" ]
  deploy:
    replicas: 1
    placement: { constraints: [ "node.labels.hosteye.role == ch1" ] }
  configs/environment: { macros shard=01 replica=node-1, keeper hosts ... }
```

## 4. Changes vs the current `docker-compose.yml`

1. **Remove host `ports:`** except where Traefik needs the ingress; expose only `edge-nginx`.
2. **Add `deploy:`** blocks (replicas, placement constraints, restart policy, resource limits).
3. **Persistent named volumes** for `clickhouse`, `redpanda`, Keeper, Vector buffer, Grafana.
4. **Scale Redpanda 1→3 brokers**, set replication factor 3, seed/peer config.
5. **Add 3 ClickHouse Keeper** + convert ClickHouse to the Replicated cluster (see
   `clickhouse-cluster.md`); mount cluster `remote_servers` + per-node `macros`.
6. **Vector**: point ClickHouse sink at the Distributed table endpoint; enable `buffer.type=disk`,
   `when_full=block`; keep the Redpanda `push_to_broker` sink (now RF=3).
7. **edge-nginx**: upstream `vector_gateways` resolves to the Vector service (Swarm DNS RR) or
   lists replicas; route `/api/v1/telemetry` → gateways, `/dashboard|/api|/clickhouse|/artifacts`
   → dashboard/clickhouse, preserving the single-domain API from the root `README.md`.
8. **Drop the 5 demo simulators** from `docker-compose.demo.full.yml` (load-test only).
9. **Edge security (split by SNI):** human host `hosteye…` → Traefik terminates Let's Encrypt +
   **Google OIDC forward-auth**; agent host `ingest.hosteye…` → Traefik **TCP passthrough** to an
   internal **mTLS** nginx (company-CA client cert + serial allowlist). See `authentication.md`.
10. **Add a forward-auth service** (oauth2-proxy/Authelia → Google) and an **ingest-nginx** service
    (reuses `Vector-HA-Cluster/nginx.conf`). Provision least-privilege ClickHouse users + Redpanda SASL.

## 5. Domains

- Public (human): `hosteye.iahn.hanoi.vn` → Traefik (LE + OIDC forward-auth) → `edge-nginx:80`.
- Ingest (agents): `ingest.hosteye.iahn.hanoi.vn` → Traefik **TCP passthrough** → `ingest-nginx` (mTLS).
  Needs its own DNS record pointing at the Swarm ingress.
- During cutover, attach a **staging host** (e.g. `hosteye-ha.iahn.hanoi.vn`) to validate the HA
  stack side-by-side with the running all-in-one before flipping the main domain.

## 6. Phased rollout

| Phase | Action | Exit criteria |
|---|---|---|
| **P0 (now)** | This design package reviewed & approved | sign-off on node count, backup target |
| **P1** | Provision ≥3 servers, add to Dokploy, init Swarm + node labels | `docker node ls` healthy, Dokploy sees servers |
| **P2** | Write `docker-compose.ha.yml` + cluster configs + migrated schema; commit to repo | compose validates; schema DDL reviewed |
| **P3** | Deploy Compose to a **staging domain**; bring up Keeper→ClickHouse→Redpanda→gateways→edge | internal smoke tests pass (health, query, ingest) |
| **P4** | Kill-a-node drills (Keeper, CH replica, Redpanda broker, gateway) | no data loss; auto-recovery within target |
| **P5** | Load test (reuse endpoint simulators) at target ingest rate | sustained ingest, no drops, dedup holds |
| **P6** | Cutover `hosteye.iahn.hanoi.vn` to HA stack; decommission all-in-one | live traffic on HA; rollback plan ready |

## 7. Rollback

Keep the all-in-one app deployed (stopped, not deleted) until P6 is verified. Rollback = repoint
the domain back to the all-in-one application in Dokploy. ClickHouse data in the HA cluster is
independent; the all-in-one re-bootstraps its own schema on start.
