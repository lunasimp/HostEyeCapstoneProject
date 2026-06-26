#!/usr/bin/env bash
set -euo pipefail

mkdir -p /opt/hosteye/certs /opt/hosteye/runtime /run/nginx /var/log/nginx /var/log/soc_vault

if [ ! -f /opt/hosteye/certs/hosteye-local.key ] || [ ! -f /opt/hosteye/certs/hosteye-local.crt ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /opt/hosteye/certs/hosteye-local.key \
    -out /opt/hosteye/certs/hosteye-local.crt \
    -subj "/CN=hosteye-all-in-one" >/dev/null 2>&1
fi

chown -R clickhouse:clickhouse /var/lib/clickhouse /var/log/clickhouse-server || true

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/hosteye.conf

