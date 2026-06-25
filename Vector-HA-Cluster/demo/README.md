# HostEye Pipeline Container Demo

This demo starts a conflict-safe HostEye pipeline using unique demo container names, five endpoint simulator containers, and one automated testcase container.

The simulator containers are not Windows virtual machines. They are lightweight endpoint emulators that generate Windows/Sysmon-shaped telemetry with unique agent IDs, deterministic send jitter, and full-jitter retry/backoff. Use real Windows VMs for installer, Sysmon, service, updater, and mTLS validation.

## Recommended Run

From Vector-HA-Cluster:

    docker compose -f docker-compose.demo.full.yml up --build

This standalone file uses:

- ClickHouse on host port 18123.
- Grafana on host port 3300.
- Unique container names prefixed with hosteye-demo-* so it can run beside an existing local-clickhouse/local-grafana stack.

## Override Run For A Clean Docker Host

If no previous HostEye containers are present, this also works:

    docker compose -f docker-compose.yml -f docker-compose.demo.yml up --build

Useful checks:

    docker logs -f hosteye-demo-testcases
    docker logs --tail 80 hosteye-demo-hosteye-endpoint-sim-01
    docker exec hosteye-demo-clickhouse clickhouse-client --query "SELECT agent_id, computer, count() FROM default.windows_system_logs WHERE agent_id LIKE 'hosteye-agent-hosteye-endpoint-sim-%' GROUP BY agent_id, computer ORDER BY agent_id"

Expected testcase result:

    PASS: HostEye demo pipeline accepted simulator events and populated ClickHouse/views

## What This Verifies

- Gateway HTTP ingestion from multiple endpoint-like clients.
- Batch payload splitting.
- PII scrubber path receives command lines and user names.
- ClickHouse base table receives data from all five simulated endpoints.
- Dashboard-backed views have process, network, DNS, and security data.
- Endpoint-side demo clients apply deterministic jitter and full-jitter retry/backoff.

## What This Does Not Replace

- Real Windows endpoint install/upgrade tests.
- Real Sysmon configuration validation.
- mTLS client certificate tests through Nginx.
- Updater scheduled-task validation.
