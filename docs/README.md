# HostEye — High-Availability Deployment Design

> **Status:** DESIGN (phase 1, design-only — not yet implemented)
> **Date:** 2026-06-29
> **Target HA level:** B — multi-node true HA (survives loss of a whole node)
> **Edge security decision:** TLS terminated at the edge (Traefik + Let's Encrypt); **no agent mTLS** in this phase.

This folder is the design package for moving HostEye from the current single-container
all-in-one deployment to a **multi-node, fault-tolerant** deployment on Dokploy.

## Context

| | Today (deployed) | Target (this design) |
|---|---|---|
| Topology | 1 all-in-one container | Multi-node Swarm cluster on Dokploy |
| Vector gateways | 1 | N replicas across nodes |
| Broker | none | Redpanda, 3 brokers, RF=3 |
| ClickHouse | 1 instance | Replicated cluster + Keeper quorum |
| Failure tolerance | none (single point of failure) | survives any single node loss |
| TLS | Traefik edge | Traefik edge (unchanged) |

## Documents

| File | What it covers |
|---|---|
| [`ha-architecture.md`](./ha-architecture.md) | Goals/non-goals, node topology, component HA roles, data flow, failure domains, capacity & scaling knobs |
| [`clickhouse-cluster.md`](./clickhouse-cluster.md) | ClickHouse Keeper + Replicated tables + Distributed + sharding-by-`idempotency_key`, schema migration from the current DDL |
| [`dokploy-deployment.md`](./dokploy-deployment.md) | Prerequisites (provision nodes + Swarm), Dokploy resource mapping, compose/Swarm specifics, volumes, domains, env, phased rollout |
| [`authentication.md`](./authentication.md) | Auth/authz: human SSO (OIDC forward-auth), per-agent ingest token (+ mTLS path via existing PKI), least-privilege DB/Redpanda users, secrets, roles |
| [`operations.md`](./operations.md) | Backup/restore, monitoring, failure & recovery runbooks, upgrades, scaling procedures |

## Key decisions (decision record)

1. **HA level B (multi-node).** Component-HA on a single node was rejected because it does
   not survive host failure. Requires provisioning ≥3 Dokploy servers (see prerequisites).
2. **Split-plane edge security (locked).** Two ingress patterns on port 443, split by SNI:
   - **Human** (`hosteye.iahn.hanoi.vn`): TLS terminated at Traefik (Let's Encrypt) + **Google OIDC**
     forward-auth → JWT/session.
   - **Agent ingest** (`ingest.hosteye.iahn.hanoi.vn`): Traefik **TCP passthrough** → internal nginx
     **mTLS** (company-CA client cert + serial allowlist), reusing the existing PKI. Company-CA pinning
     preserves anti-MITM/DNS-poisoning protection.
3. **Authentication is in scope (locked).** Three planes — human **Google OIDC → JWT**, machine
   **mTLS** ingest, and service/data-store (least-privilege DB users + Redpanda SASL). **Single-tenant.**
   Closes the current "everything is open" gap. See `authentication.md`.
4. **Reuse the existing pipeline contract.** Same ingest path (`/api/v1/telemetry`), same
   `idempotency_key` dedup, same single public domain and API surface documented in the
   root `README.md`. Only the backend topology changes.

## Open items to confirm before implementation

- Node count & sizing (baseline 3 nodes for 1-shard×3-replica HA; 4–6 for sharded scale).
- Whether to keep Redpanda strictly as a durable replay bus (current design) or move
  ClickHouse ingestion to consume *from* Redpanda (Kafka-engine) instead of Vector direct-write.
- Backup target (object storage bucket) for ClickHouse `BACKUP`.
- **Auth (resolved — see `authentication.md`):** Google OIDC→JWT for humans, **mTLS** for agent
  ingest, single-tenant. Remaining minor: `/clickhouse/` & `/artifacts/` gated behind admin SSO vs
  removed from public; forward-auth impl (`oauth2-proxy` vs Authelia).
- **DNS** for `ingest.hosteye.iahn.hanoi.vn` (new ingest hostname) + the existing `hosteye…` record.
