#!/usr/bin/env bash
set -euo pipefail

for _ in $(seq 1 120); do
  if clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null

for schema in /docker-entrypoint-initdb.d/*.sql; do
  [ -e "$schema" ] || continue
  echo "Applying ClickHouse schema: $schema"
  clickhouse-client --host 127.0.0.1 --multiquery < "$schema"
done

echo "HostEye ClickHouse schema ensured"

