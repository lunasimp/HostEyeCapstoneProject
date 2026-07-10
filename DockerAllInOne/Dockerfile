FROM timberio/vector:0.35.0-alpine AS vector-bin

FROM clickhouse/clickhouse-server:latest

USER root

ARG NODE_MAJOR=20
ENV DEBIAN_FRONTEND=noninteractive

RUN rm -f /etc/apt/sources.list.d/*clickhouse* \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg nginx openssl supervisor tini zip \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=vector-bin /usr/local/bin/vector /usr/local/bin/vector

WORKDIR /opt/hosteye

COPY HostEyeDashboard /opt/hosteye/HostEyeDashboard
COPY VectorDashboardApi /opt/hosteye/VectorDashboardApi
COPY VectorBuild /opt/hosteye/artifacts/VectorBuild
COPY VectorServer /opt/hosteye/artifacts/VectorServer

COPY Vector-HA-Cluster/clickhouse-init /docker-entrypoint-initdb.d
COPY Vector-HA-Cluster/clickhouse-config/users.d/default-user.xml /etc/clickhouse-server/users.d/default-user.xml

COPY DockerAllInOne/vector-all-in-one.toml /etc/vector/vector.toml
COPY DockerAllInOne/nginx-all-in-one.conf /etc/nginx/nginx.conf
COPY DockerAllInOne/supervisord.conf /etc/supervisor/conf.d/hosteye.conf
COPY DockerAllInOne/entrypoint.sh /usr/local/bin/hosteye-entrypoint.sh
COPY DockerAllInOne/init-clickhouse.sh /usr/local/bin/init-clickhouse.sh
COPY DockerAllInOne/package-installer.sh /usr/local/bin/package-installer.sh

RUN chmod +x /usr/local/bin/hosteye-entrypoint.sh /usr/local/bin/init-clickhouse.sh /usr/local/bin/package-installer.sh \
    && mkdir -p /var/lib/vector /var/log/soc_vault /run/nginx /opt/hosteye/certs /opt/hosteye/runtime \
    && chown -R clickhouse:clickhouse /var/lib/clickhouse /var/log/clickhouse-server

# Single unified port; everything else is reverse-proxied by nginx internally.
EXPOSE 80

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/hosteye-entrypoint.sh"]
