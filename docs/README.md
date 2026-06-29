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
| [`operations.md`](./operations.md) | Backup/restore, monitoring, failure & recovery runbooks, upgrades, scaling procedures |

## Key decisions (decision record)

1. **HA level B (multi-node).** Component-HA on a single node was rejected because it does
   not survive host failure. Requires provisioning ≥3 Dokploy servers (see prerequisites).
2. **TLS at the edge only.** Agent telemetry arrives over HTTPS to Traefik, which terminates
   TLS and forwards plain HTTP internally. Agent mTLS (client-cert allowlist + per-client
   rate limit from the original `nginx.conf`) is **out of scope** for this phase; it can be
   re-introduced later via a dedicated Traefik TCP passthrough entrypoint.
3. **Reuse the existing pipeline contract.** Same ingest path (`/api/v1/telemetry`), same
   `idempotency_key` dedup, same single public domain and API surface documented in the
   root `README.md`. Only the backend topology changes.

## Open items to confirm before implementation

- Node count & sizing (baseline 3 nodes for 1-shard×3-replica HA; 4–6 for sharded scale).
- Whether to keep Redpanda strictly as a durable replay bus (current design) or move
  ClickHouse ingestion to consume *from* Redpanda (Kafka-engine) instead of Vector direct-write.
- Backup target (object storage bucket) for ClickHouse `BACKUP`.
