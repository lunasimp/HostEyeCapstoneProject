# HA Architecture (target)

> Status: DESIGN. Target HA level B (multi-node). TLS at edge, no agent mTLS.

## 1. Goals / non-goals

**Goals**
- Survive the loss of **any single node** with no data loss and only brief, automatic failover.
- Absorb large log spikes without dropping events (durable buffering end-to-end).
- Horizontal scale of the stateless ingest tier (Vector gateways) and the query tier.
- Keep the existing public contract: one domain, `/api/v1/telemetry` ingest, dashboard + API,
  `idempotency_key` dedup.

**Non-goals (this phase)**
- Multi-region / cross-datacenter HA.
- Multi-tenant data scoping (single-tenant this phase — see `authentication.md`).
- Auto-scaling (replica counts are set manually; documented knobs only).

> Auth is **in scope** and locked: human Google OIDC→JWT at the edge; agent ingest via **mTLS**
> (Traefik TCP passthrough → internal nginx, company-CA). See `authentication.md`.

## 2. Failure domains

| Component | State | HA mechanism | Tolerates |
|---|---|---|---|
| Traefik (edge) | stateless | runs on all manager nodes, Swarm routing mesh | node loss |
| edge-nginx / Vector gateways | stateless | N replicas spread across nodes + disk buffer | node loss, crash, spike |
| Redpanda | **stateful** | 3 brokers, replication factor 3, `acks=all` | 1 broker/node loss |
| ClickHouse | **stateful** | Replicated*MergeTree, ≥2 replicas per shard | 1 replica/node loss per shard |
| ClickHouse Keeper | **stateful** | 3-node Raft quorum | 1 keeper/node loss |
| dashboard-api / dashboard-web | stateless | N replicas across nodes | node loss |
| Grafana (optional) | light state | single (or HA later with external DB) | — |

The hard rule: **stateful services replicate at the application layer** (ClickHouse replication,
Redpanda replication, Keeper Raft), **not** via shared storage. Swarm only schedules them;
each stateful replica is pinned to a node with its own local volume.

## 3. Node topology

### Baseline — 3 nodes (true HA, no sharding)

```
            ┌──────────────── Traefik routing mesh (all nodes) ────────────────┐
            │  TLS (Let's Encrypt) for hosteye.iahn.hanoi.vn                   │
 ┌──────────▼──────────┐   ┌───────────────────────┐   ┌───────────────────────┐
 │  node-1 (manager)   │   │  node-2 (manager)     │   │  node-3 (manager)     │
 │  edge-nginx         │   │  edge-nginx           │   │  edge-nginx           │
 │  vector-gateway     │   │  vector-gateway       │   │  vector-gateway       │
 │  dashboard-api/web  │   │  dashboard-api/web    │   │  dashboard-api/web    │
 │  redpanda-1         │   │  redpanda-2           │   │  redpanda-3           │
 │  ch-keeper-1        │   │  ch-keeper-2          │   │  ch-keeper-3          │
 │  clickhouse-r1      │   │  clickhouse-r2        │   │  clickhouse-r3        │
 │  (vol: ch_data_1,   │   │  (vol: ch_data_2,     │   │  (vol: ch_data_3,     │
 │   rp_data_1)        │   │   rp_data_2)          │   │   rp_data_3)          │
 └─────────────────────┘   └───────────────────────┘   └───────────────────────┘
        1 shard × 3 replicas (every node holds the full dataset)
```

- **Quorum components are odd (3):** Keeper and Redpanda tolerate losing 1 of 3.
- **1 shard × 3 replicas:** every ClickHouse node holds the complete dataset → any single node
  can serve all queries; writes land on all 3 replicas. Simplest correct HA. Write throughput
  is bounded by one shard — fine until ingest outgrows a single node's insert capacity.

### Scale-out — 4–6 nodes (sharded + replicated)

When a single shard can't keep up with insert volume, move to **2 shards × 2 replicas** (4 CH
instances) or **3 shards × 2 replicas** (6 instances). Keeper stays a 3-node quorum (co-located
on any 3 nodes). See `clickhouse-cluster.md` for the sharding key that preserves dedup.

## 4. End-to-end data flow

```
agent (Vector→spool→SOCShipper, gzip JSON batch, mTLS w/ client cert)
   │
   ▼  Traefik TCP passthrough (SNI ingest.hosteye…) — TLS NOT terminated
ingest-nginx (mTLS: company-CA client cert + serial allowlist + per-serial rate-limit)
                 │ /api/v1/telemetry  (plaintext, internal)
                 ▼  round-robin across replicas (Swarm mesh)
            vector-gateway ×N
                 ├─► raw_forensic_vault (per-node file vault)
                 ├─► Redpanda topic `windows-logs-pool` (RF=3, acks=all)  ── durable replay bus
                 └─► ClickHouse Distributed table (sharded by idempotency_key)
                          └─► ReplicatedReplacingMergeTree (per shard, dedup)
                                   └─► 9 materialized views → per-type Replicated tables

human ──TLS(LE)──► Traefik ──forwardAuth(Google OIDC→JWT)──► dashboard-web / dashboard-api
dashboard-api ──► ClickHouse Distributed (read fan-out across shards)
```

Unchanged invariants from the current pipeline:
- **`idempotency_key = SHA-256(computer-channel-record_id)`** is generated client-side.
- Dedup is by that key in `ReplacingMergeTree ORDER BY (idempotency_key, kafka_timestamp)`.
- Per-type tables (`process_events`, `network_events`, …) are fed by materialized views.

## 5. How large volume is handled (HA edition)

1. **Client spool** (unchanged): store-and-forward, up to 8 GB on the endpoint, backoff on 429/503.
2. **N Vector gateways** behind the Swarm routing mesh → ingest scales by adding replicas.
3. **Disk buffers on each gateway** (`buffer.type = "disk"`, `when_full = "block"`) → durable
   backpressure instead of in-memory loss when a sink is slow.
4. **Redpanda (RF=3)** absorbs spikes and decouples producers from ClickHouse; allows replay and
   additional consumers (detection/SIEM) without touching the DB.
5. **ClickHouse cluster** spreads inserts across shards and reads across replicas; batched inserts
   from Vector keep merge pressure sane.
6. **Idempotency** makes every retry/replay safe — no duplicate rows even under heavy re-delivery.

## 6. Scaling knobs (summary)

| Want more… | Turn this knob |
|---|---|
| Ingest throughput | `deploy.replicas` on `vector-gateway`; add `server …` lines to edge-nginx upstream |
| Buffer durability | gateway sink `buffer.type=disk`, `max_size`, `when_full=block` |
| Broker capacity | Redpanda partitions on `windows-logs-pool`; add brokers (keep RF≤broker count) |
| Write capacity (DB) | add ClickHouse **shards** (re-shard by `idempotency_key`) |
| Read/query capacity | add ClickHouse **replicas** per shard |
| Query tier | `deploy.replicas` on `dashboard-api` / `dashboard-web` |

## 7. Capacity planning notes

- Size each node for ClickHouse first (RAM for merges + SSD for `ch_data` + 90-day TTL footprint).
- Redpanda retention on `windows-logs-pool` sets how far back replay is possible; size `rp_data`
  accordingly (it is a buffer, not the system of record — ClickHouse is).
- Vector gateway disk buffer should hold at least a few minutes of peak ingest per replica.
