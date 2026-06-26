#!/usr/bin/env bash
set -euo pipefail

mkdir -p /opt/hosteye/certs /opt/hosteye/runtime /run/nginx /var/log/nginx /var/log/soc_vault

if [ ! -f /opt/hosteye/certs/hosteye-local-ca.key ] || [ ! -f /opt/hosteye/certs/hosteye-local-ca.crt ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /opt/hosteye/certs/hosteye-local-ca.key \
    -out /opt/hosteye/certs/hosteye-local-ca.crt \
    -subj "/CN=HostEye All-In-One Lab CA" >/dev/null 2>&1
fi

server_san="${HOSTEYE_SERVER_SAN:-DNS:localhost,DNS:host.docker.internal,DNS:hosteye-all-in-one,IP:127.0.0.1,IP:192.168.17.1}"
cat >/opt/hosteye/certs/server-ext.cnf <<EOF
subjectAltName=${server_san}
extendedKeyUsage=serverAuth
EOF

if [ ! -f /opt/hosteye/certs/hosteye-local.key ] || [ ! -f /opt/hosteye/certs/hosteye-local.crt ]; then
  openssl req -nodes -newkey rsa:2048 \
    -keyout /opt/hosteye/certs/hosteye-local.key \
    -out /opt/hosteye/certs/hosteye-local.csr \
    -subj "/CN=localhost" >/dev/null 2>&1
  openssl x509 -req -days 3650 \
    -in /opt/hosteye/certs/hosteye-local.csr \
    -CA /opt/hosteye/certs/hosteye-local-ca.crt \
    -CAkey /opt/hosteye/certs/hosteye-local-ca.key \
    -CAcreateserial \
    -out /opt/hosteye/certs/hosteye-local.crt \
    -extfile /opt/hosteye/certs/server-ext.cnf >/dev/null 2>&1
fi

cat >/opt/hosteye/certs/client-ext.cnf <<'EOF'
extendedKeyUsage=clientAuth
EOF

if [ ! -f /opt/hosteye/certs/client.key ] || [ ! -f /opt/hosteye/certs/client.crt ]; then
  openssl req -nodes -newkey rsa:2048 \
    -keyout /opt/hosteye/certs/client.key \
    -out /opt/hosteye/certs/client.csr \
    -subj "/CN=hosteye-lab-endpoint" >/dev/null 2>&1
  openssl x509 -req -days 3650 \
    -in /opt/hosteye/certs/client.csr \
    -CA /opt/hosteye/certs/hosteye-local-ca.crt \
    -CAkey /opt/hosteye/certs/hosteye-local-ca.key \
    -CAcreateserial \
    -out /opt/hosteye/certs/client.crt \
    -extfile /opt/hosteye/certs/client-ext.cnf >/dev/null 2>&1
fi

/usr/local/bin/package-installer.sh

chown -R clickhouse:clickhouse /var/lib/clickhouse /var/log/clickhouse-server || true

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/hosteye.conf
