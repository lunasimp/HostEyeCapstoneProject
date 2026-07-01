# F Smooth Criminal Guard

SOC log pipeline demo for Windows endpoint telemetry.

## Components

- `DockerAllInOne`: single-container build (nginx + ClickHouse + Vector + dashboard API/UI) used for the live lab deployment behind one HTTP port.
- `HostEyeDashboard`: HostEye dashboard web UI (static assets served by a small Node `server.js`).
- `VectorDashboardApi`: read-only HTTP API that powers the dashboard by querying ClickHouse (this is the API served in the all-in-one container).
- `HostEyeDashboardApi`: standalone dashboard API package (alternate to `VectorDashboardApi`).
- `HostEyeDemoLab`: PowerShell automation to spin up, reset, and test a Windows demo lab that ships telemetry to the gateway.
- `VectorBuild`: Windows endpoint installer assets, Vector config, Sysmon config, and SOCShipper.
- `VectorServer`: update server and certificate helper scripts.
- `Vector-HA-Cluster`: Docker Compose server stack with Nginx, Vector Gateway, Redpanda, ClickHouse, and Grafana.
- `scripts/visualize_clickhouse_logs.py`: exports ClickHouse aggregations and generates SVG/HTML visualizations with Python standard library only.

## Deployed lab gateway — HTTP API

The all-in-one container (`DockerAllInOne/Dockerfile`) is deployed on Dokploy and
published behind a single domain. TLS is terminated by the platform reverse proxy
(Traefik + Let's Encrypt); the container itself serves plain HTTP on port `80` and
nginx fans every path out to the right internal service.

**Base URL:** `https://hosteye.iahn.hanoi.vn`

> DNS: the domain's `A` record must point at the Dokploy host for routing and
> Let's Encrypt issuance to work.

### Top-level routes (nginx)

| Path                 | Method   | Backend            | Notes                                      |
| -------------------- | -------- | ------------------ | ------------------------------------------ |
| `/`                  | GET      | —                  | `302` redirect to `/dashboard/`            |
| `/dashboard/`        | GET      | dashboard web UI   | HostEye single-page dashboard              |
| `/api/...`           | GET      | dashboard API      | JSON, CORS `*`, `GET`/`OPTIONS` only       |
| `/api/v1/telemetry`  | POST     | Vector ingest      | endpoint agents push telemetry here        |
| `/clickhouse/`       | GET/POST | ClickHouse HTTP    | raw query interface (no auth in lab)       |
| `/artifacts/`        | GET      | static file server | build artifacts + agent installer bundle   |

### Dashboard API (`/api`)

All endpoints are `GET` and return `application/json`. Unless noted, they accept the
common query parameters below.

| Endpoint                                      | Description                                          |
| --------------------------------------------- | ---------------------------------------------------- |
| `GET /api/health`                             | Liveness + ClickHouse connectivity and row count     |
| `GET /api/dashboard/overview/summary`         | Totals: events, hosts, channels, event ids, first/last seen |
| `GET /api/dashboard/overview/log-volume`      | Event volume time series (`bucket`)                  |
| `GET /api/dashboard/overview/top-hosts`       | Busiest hosts                                        |
| `GET /api/dashboard/overview/event-types`     | Event-type volume breakdown                          |
| `GET /api/dashboard/overview/security-timeline` | Recent security-overview events                    |
| `GET /api/dashboard/hosts/summary`            | Per-host rollup with online/active/stale status      |
| `GET /api/dashboard/hosts/heatmap`            | Host × time activity heatmap (`top`, `bucket`)       |
| `GET /api/dashboard/hosts/heatmap/cell`       | Drill-down for one heatmap cell (**requires** `host`, `time`) |
| `GET /api/dashboard/process/top-processes`    | Top process images                                   |
| `GET /api/dashboard/process/recent`           | Recent process events                                |
| `GET /api/dashboard/network/top-destination-ips` | Top destination IPs                               |
| `GET /api/dashboard/network/recent`           | Recent network connections                           |
| `GET /api/dashboard/dns/top-domains`          | Top queried DNS domains                              |
| `GET /api/dashboard/dns/recent`               | Recent DNS queries                                   |
| `GET /api/dashboard/registry/recent`          | Recent registry events                               |
| `GET /api/dashboard/file/recent`              | Recent file events                                   |
| `GET /api/dashboard/process-access/recent`    | Recent process-access events                         |
| `GET /api/dashboard/powershell/volume`        | PowerShell event volume time series (`bucket`)       |
| `GET /api/dashboard/powershell/recent`        | Recent PowerShell script-block events                |
| `GET /api/logs/search`                        | Full-text search across logs (**requires** `q`)      |
| `GET /api/logs/raw/{idempotencyKey}`          | Fetch one raw log row by idempotency key             |

**Common query parameters**

| Param          | Applies to                          | Default / values                                  |
| -------------- | ----------------------------------- | ------------------------------------------------- |
| `from`, `to`   | most endpoints                      | ISO-8601 datetime; default window = last 30 days  |
| `host`         | most endpoints                      | filter by `computer` name                         |
| `channel`      | most endpoints                      | filter by Windows channel                         |
| `eventId`      | most endpoints                      | filter by numeric event id                        |
| `limit`        | list endpoints                      | positive int, capped per endpoint                 |
| `bucket`       | time-series endpoints               | `second` \| `minute` \| `hour` \| `day`           |
| `top`          | `hosts/heatmap`                     | number of hosts (default 10, max 25)              |
| `q`            | `logs/search`, `heatmap/cell`       | case-insensitive search string                    |
| `time`         | `hosts/heatmap/cell`                | bucket start (required, paired with `bucket`)     |

### Telemetry ingest

```text
POST https://hosteye.iahn.hanoi.vn/api/v1/telemetry
Content-Type: application/json
```

Body is a single Windows event record or a JSON array batch of records. Vector parses,
scrubs PII, writes the raw payload to the forensic vault, and persists into ClickHouse
`default.windows_system_logs` (plus per-type tables: `process_events`, `network_events`,
`dns_events`, `file_events`, `registry_events`, `powershell_events`, `process_access_events`,
`security_overview_events`). Returns `200` on accept.

### ClickHouse HTTP

```text
GET https://hosteye.iahn.hanoi.vn/clickhouse/?query=SELECT%20version()
```

Proxies the ClickHouse HTTP interface (container port `8123`). The native protocol
(`9000`) is **not** exposed. The default user has no password in this lab build — do
not expose `/clickhouse/` to untrusted networks without adding auth.

### Artifacts

`GET /artifacts/` lists build artifacts and the lab agent installer, e.g.
`/artifacts/installers/HostEye-Agent-Installer.zip`.

## Server stack

```powershell
cd Vector-HA-Cluster
docker compose up -d
docker compose ps
```

Default service ports:

- Nginx gateway: `443`
- ClickHouse HTTP: `8123`
- ClickHouse native: `9000`
- Grafana: `3000`
- Redpanda external Kafka: `19092`

## Client gateway hostname

Endpoint agents send telemetry to:

```text
https://hosteye.iahn.hanoi.vn/api/v1/telemetry
```

For a VPN/LAN demo before public DNS is ready, map this hostname on client machines to the server-reachable IP, for example:

```powershell
Add-Content C:\Windows\System32\drivers\etc\hosts "192.168.17.1 hosteye.iahn.hanoi.vn"
Test-NetConnection hosteye.iahn.hanoi.vn -Port 443
```

## Restore Vector binary before building installer

`VectorBuild/vector.exe` is intentionally not committed because the binary is about 122 MB, which exceeds GitHub's normal 100 MB file limit. After cloning the repository, restore it with:

```powershell
cd VectorBuild
powershell -ExecutionPolicy Bypass -File .\fetch-vector.ps1
```

The script downloads Vector `0.55.0` from the official Timber package endpoint and places it at:

```text
VectorBuild\vector.exe
```

## ClickHouse checks

```powershell
docker exec local-clickhouse clickhouse-client --query "SELECT count() FROM default.windows_system_logs"
docker exec local-clickhouse clickhouse-client --query "SELECT computer, count() AS events FROM default.windows_system_logs GROUP BY computer ORDER BY events DESC LIMIT 20"
```

## Generate visualizations

Run after the server stack is up and ClickHouse contains data:

```powershell
python scripts\visualize_clickhouse_logs.py --output .\visualizations
```

The script writes CSV exports, SVG charts, and `dashboard.html`.

## Notes

Runtime data, generated binaries, certificate private keys, ClickHouse/Redpanda/Grafana volumes, and raw SOC vault logs are intentionally ignored by Git.
