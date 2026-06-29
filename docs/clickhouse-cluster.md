# ClickHouse cluster design

> Status: DESIGN. Migrates the current single-node schema to a Replicated + Distributed cluster
> while preserving the existing `idempotency_key` dedup semantics.

## 1. Current state (single node)

From `Vector-HA-Cluster/clickhouse-init/001_schema.sql`:

```sql
CREATE TABLE default.windows_system_logs ( ... )
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (idempotency_key, kafka_timestamp)
TTL kafka_timestamp + toIntervalDay(90);
-- + 9 materialized views fanning out into process_events, network_events, dns_events,
--   file_events, registry_events, powershell_events, process_access_events,
--   security_overview_events.
```

Dedup is eventual (on merge), keyed by `idempotency_key`, within one partition on one node.
Vector writes directly to this table.

## 2. Cluster building blocks

| Piece | Role |
|---|---|
| **ClickHouse Keeper** (3-node quorum) | coordination/metadata for replication (Raft). Replaces ZooKeeper. |
| **`ReplicatedReplacingMergeTree`** | per-shard local table; replicas converge via Keeper. |
| **`Distributed` table** | logical table over the cluster; routes inserts by sharding key, fans reads across shards. |
| **Cluster definition** (`remote_servers`) | lists shards/replicas; uses macros `{shard}` / `{replica}`. |

### Macros (per node, in config)

```xml
<macros>
  <cluster>hosteye</cluster>
  <shard>01</shard>      <!-- same value for all replicas of a shard -->
  <replica>node-1</replica>
</macros>
```

### Cluster topology (baseline 1 shard × 3 replicas)

```xml
<remote_servers>
  <hosteye>
    <shard>
      <internal_replication>true</internal_replication>
      <replica><host>clickhouse-r1</host><port>9000</port></replica>
      <replica><host>clickhouse-r2</host><port>9000</port></replica>
      <replica><host>clickhouse-r3</host><port>9000</port></replica>
    </shard>
  </hosteye>
</remote_servers>
```

`internal_replication=true` → the Distributed table writes to **one** replica per shard and lets
ClickHouse replication copy to the others (avoids double-writes).

## 3. Schema migration

### 3.1 Local replicated tables

Every `MergeTree`/`ReplacingMergeTree` becomes `Replicated*` with a Keeper path keyed by `{shard}`:

```sql
CREATE TABLE default.windows_system_logs_local ON CLUSTER hosteye ( ... )
ENGINE = ReplicatedReplacingMergeTree(
  '/clickhouse/tables/{shard}/windows_system_logs', '{replica}')
PARTITION BY toYYYYMM(kafka_timestamp)
ORDER BY (idempotency_key, kafka_timestamp)
TTL kafka_timestamp + toIntervalDay(90);
```

The 8 per-type tables migrate the same way (`*_local`, `ReplicatedReplacingMergeTree` /
`ReplicatedMergeTree` with `/clickhouse/tables/{shard}/<name>` + `{replica}`).

### 3.2 Distributed tables (read/write entrypoint)

```sql
CREATE TABLE default.windows_system_logs ON CLUSTER hosteye
AS default.windows_system_logs_local
ENGINE = Distributed(hosteye, default, windows_system_logs_local, cityHash64(idempotency_key));
```

> **Critical:** the sharding key is `cityHash64(idempotency_key)`. Because every copy of an event
> carries the same `idempotency_key`, all duplicates **always route to the same shard**, so
> `ReplacingMergeTree` dedup keeps working across the cluster. Sharding by anything else (e.g.
> random/round-robin) would scatter duplicates across shards and **break dedup**.

The application keeps querying/inserting the familiar names (`windows_system_logs`,
`process_events`, …) — those are now the Distributed tables. No dashboard/API query changes
needed (names are identical).

### 3.3 Materialized views

The 9 MVs run on each replica against the **local** table and write to the **local** per-type
table, so the fan-out happens shard-locally and replicates normally:

```sql
CREATE MATERIALIZED VIEW default.process_events_mv ON CLUSTER hosteye
TO default.process_events_local
AS SELECT ... FROM default.windows_system_logs_local WHERE ...;
```

(Today's MVs read `FROM default.windows_system_logs`; in the cluster they must read
`FROM …_local` and target `…_local`.)

## 4. Write path

Vector's ClickHouse sink points at the **Distributed** `windows_system_logs` table. Options:

- **Recommended:** `insert_distributed_sync = 1` so inserts are acknowledged after reaching the
  shard (predictable backpressure, pairs with Vector disk buffer).
- The Distributed table applies `cityHash64(idempotency_key)` → one shard → local Replicated
  table → MV fan-out → replication to peers.

Vector keeps writing batched, gzip-compressed inserts exactly as today; only the endpoint target
(now any healthy ClickHouse replica / a load-balanced CH endpoint) and table engine change.

## 5. Query-time dedup

`ReplacingMergeTree` dedup is eventual. The current dashboard queries do not use `FINAL`. For the
cluster this is unchanged behaviour, but document the options:

- Accept eventual dedup (cheapest; current behaviour).
- Use `SELECT … FINAL` on hot tables where exactness matters (costlier).
- Or `argMax`/`GROUP BY idempotency_key` patterns in specific endpoints.

Recommendation for this phase: keep current behaviour (no `FINAL`); revisit per-endpoint if
duplicate rows in a narrow time window become a problem.

## 6. Bootstrapping notes

- Schema is created `ON CLUSTER hosteye` so a single DDL run provisions all replicas.
- Keeper must be healthy (quorum up) before creating Replicated tables.
- For Dokploy/Swarm, the init SQL runs once against any replica; `ON CLUSTER` propagates it.
- Re-sharding later (1→2 shards) requires a data redistribution plan (dump/reload or
  `clickhouse-copier`); design for the target shard count early if high volume is expected.
