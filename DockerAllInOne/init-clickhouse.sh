#!/usr/bin/env bash
set -euo pipefail

MARKER=/var/lib/clickhouse/.hosteye_schema_initialized
SCHEMA=/docker-entrypoint-initdb.d/001_schema.sql

for _ in $(seq 1 120); do
  if clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null

if [ ! -f "$MARKER" ]; then
  clickhouse-client --host 127.0.0.1 --multiquery < "$SCHEMA"
  touch "$MARKER"
  echo "HostEye ClickHouse schema initialized"
else
  echo "HostEye ClickHouse schema already initialized"
fi

