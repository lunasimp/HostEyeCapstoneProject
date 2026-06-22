# F Smooth Criminal Guard

SOC log pipeline demo for Windows endpoint telemetry.

## Components

- `VectorBuild`: Windows endpoint installer assets, Vector config, Sysmon config, and SOCShipper.
- `VectorServer`: update server and certificate helper scripts.
- `Vector-HA-Cluster`: Docker Compose server stack with Nginx, Vector Gateway, Redpanda, ClickHouse, and Grafana.
- `scripts/visualize_clickhouse_logs.py`: exports ClickHouse aggregations and generates SVG/HTML visualizations with Python standard library only.

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
https://soc-gateway.yourcorporate.com/api/v1/telemetry
```

For a VPN/LAN demo, map this hostname on client machines to the server-reachable IP, for example:

```powershell
Add-Content C:\Windows\System32\drivers\etc\hosts "192.168.17.1 soc-gateway.yourcorporate.com"
Test-NetConnection soc-gateway.yourcorporate.com -Port 443
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
