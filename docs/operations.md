# Operations & runbooks (HA target)

> Status: DESIGN. Operational procedures for the multi-node HA stack. Finalize during build/P3.

## 1. Health & monitoring

| Layer | Check |
|---|---|
| Swarm | `docker node ls` (all `Ready`/`Active`), `docker service ls` (replicas converged) |
| Traefik | dashboard/API reachable on the public domain; cert valid (Let's Encrypt) |
| Vector gateway | `/api/health`-style probe per replica; buffer fill %; events in/out rate |
| Redpanda | broker count = 3, under-replicated partitions = 0, topic `windows-logs-pool` ISR |
| Keeper | quorum present (1 leader + followers), no Raft re-elections flapping |
| ClickHouse | `system.replicas` (no `is_readonly`, low `queue_size`/`absolute_delay`), merges keeping up |
| Dashboard | `GET /api/health` returns `status:ok` + ClickHouse reachable + row count |

Recommended: Grafana dashboards for Vector throughput, Redpanda lag, ClickHouse merges/parts,
and node resource use. Alert on: under-replicated Redpanda partitions, ClickHouse replica delay,
Keeper quorum loss, Vector buffer near-full.

## 2. Failure & recovery runbooks

### Node down (any single node)
- **Expected:** stateless replicas reschedule onto surviving nodes; quorum services keep quorum
  (2 of 3); ClickHouse/Redpanda serve from surviving replicas. No data loss; ingest continues.
- **Action:** confirm Swarm rescheduled stateless services; bring the node back; verify the pinned
  stateful container re-attaches its local volume and **re-syncs** (ClickHouse replica catches up
  from Keeper; Redpanda broker rejoins ISR). Do not delete the pinned volume.

### ClickHouse replica lagging / read-only
- Check `system.replication_queue` and Keeper connectivity. A replica goes read-only if it loses
  Keeper; restoring Keeper quorum recovers it. If a replica's data is lost, recreate it and let it
  re-replicate from peers (`SYSTEM RESTORE REPLICA` / drop+recreate the Replicated table on that node).

### Keeper quorum lost (2 of 3 down)
- ClickHouse replication stalls (tables read-only), but **reads still serve**. Restore Keeper nodes
  to regain quorum; replication resumes automatically. Never run Keeper as a single node in prod.

### Redpanda broker down
- RF=3 tolerates one broker; producers continue (`acks=all` with min ISR satisfied). Replace/rejoin
  the broker; it back-fills from peers.

### Vector gateway overload / sink slow
- Disk buffer absorbs; if buffers fill, `when_full=block` pushes backpressure → edge returns 429/503
  → client SOCShipper backs off (no loss). Scale `vector-gateway` replicas; check ClickHouse merge
  pressure and Redpanda lag as root cause.

## 3. Backup & restore (ClickHouse)

- **System of record = ClickHouse** (Redpanda is a bounded replay buffer, not a backup).
- Use ClickHouse `BACKUP ... TO Disk/S3(...)` on a schedule to the object-storage bucket
  (prerequisite). Back up the Replicated tables (one replica per shard is sufficient since replicas
  are identical).
- Test restore into a scratch cluster periodically. Document RPO (backup interval) and RTO.
- 90-day TTL is data lifecycle, **not** a backup — expired partitions are dropped automatically.

## 4. Upgrades (zero/low-downtime)

- **Stateless** (`vector-gateway`, `edge-nginx`, dashboard): rolling update via `deploy.update_config`
  (one replica at a time, health-gated). Idempotency makes in-flight retries safe.
- **ClickHouse:** rolling, one replica at a time; wait for `system.replicas` to catch up before the
  next. Keep versions within a compatible range.
- **Redpanda:** rolling broker restart; wait for ISR to recover between brokers.
- **Keeper:** restart followers first, leader last; never lose quorum.

## 5. Scaling procedures

| Goal | Procedure |
|---|---|
| More ingest | raise `vector-gateway` replicas; ensure edge-nginx upstream resolves new replicas |
| More write capacity | add a ClickHouse **shard** (new node(s)); update `remote_servers`; re-shard by `cityHash64(idempotency_key)` (dump/reload or `clickhouse-copier`) |
| More read capacity | add a **replica** to a shard; it re-replicates from peers via Keeper |
| More buffer headroom | increase Redpanda partitions/retention; grow Vector disk buffer `max_size` |

## 6. Security posture (this phase)

- **Human path:** TLS terminated at Traefik (Let's Encrypt) on `hosteye…` + **Google OIDC**
  forward-auth → JWT/session. Internal traffic plain HTTP on the overlay.
- **Agent path:** `ingest.hosteye…` via Traefik **TCP passthrough** → internal **mTLS** nginx
  (company-CA client cert + `$ssl_client_serial` allowlist + per-serial rate-limit). Cert lifecycle
  via existing `Issue/Register/Revoke-EndpointClientCert.ps1`; renew before expiry; revoke = remove
  from allowlist (immediate cutoff). Company-CA pinning keeps anti-MITM/DNS-poisoning protection.
- **Data/services:** least-privilege ClickHouse users (`dashboard_ro`/`ingest_rw`/`admin`), Redpanda
  SASL/SCRAM; secrets in Dokploy env. `/clickhouse/` & `/artifacts/` behind `hosteye-admin` (or off
  the public domain) — never expose a no-password user. See `authentication.md`.

## 7. Definition of done (for the build phase that follows this design)

- [ ] ≥3 nodes provisioned, added to Dokploy, Swarm initialized with role labels.
- [ ] `docker-compose.ha.yml` + cluster configs + migrated `ON CLUSTER` schema committed.
- [ ] Staging domain validated: ingest, dedup, dashboard, `/clickhouse/`.
- [ ] Kill-a-node drills pass with no data loss.
- [ ] Load test sustains target ingest with no drops.
- [ ] Backup/restore verified.
- [ ] Cutover + rollback plan rehearsed.
