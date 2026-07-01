#!/usr/bin/env bash
set -euo pipefail

SCHEMA=/docker-entrypoint-initdb.d/001_schema.sql

for _ in $(seq 1 120); do
  if clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

clickhouse-client --host 127.0.0.1 --query "SELECT 1" >/dev/null

clickhouse-client --host 127.0.0.1 --multiquery < "$SCHEMA"
echo "HostEye ClickHouse schema ensured"

