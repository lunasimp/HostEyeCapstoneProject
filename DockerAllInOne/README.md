# HostEye All-In-One Container

This folder builds a single test container that runs:

- ClickHouse database with the existing schema
- Vector HTTP ingest gateway
- HostEye dashboard API
- HostEye dashboard web UI
- Nginx reverse proxy and artifact browser

Everything is reverse-proxied by nginx behind a **single HTTP port (80)**, so the
container exposes exactly one port and is ready to deploy behind a platform that
terminates TLS (Dokploy / Traefik / load balancer).

It intentionally does not replace the existing multi-container `Vector-HA-Cluster` stack.

## Build

```powershell
cd D:\FULOG\F-smooth-criminal-guard
docker build -f DockerAllInOne\Dockerfile -t hosteye-all-in-one:local .
```

## Run

```powershell
docker run --name hosteye-all-in-one --rm `
  -p 8080:80 `
  -v hosteye_clickhouse:/var/lib/clickhouse `
  -v hosteye_vault:/var/log/soc_vault `
  -v hosteye_dashboard_auth:/var/lib/hosteye-dashboard `
  -e HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD="<unique-secret-at-least-16-characters>" `
  hosteye-all-in-one:local
```

The first authenticated start creates the Administrator account in the
`hosteye_dashboard_auth` volume. The container refuses to bootstrap with a
missing or known demo password.

All routes live under the same port:

| Path | Backend |
|------|---------|
| `/` | redirects to `/dashboard/` |
| `/dashboard/` | dashboard web UI |
| `/api/` | dashboard API |
| `/api/v1/telemetry` | Vector ingest gateway |
| `/clickhouse/` | ClickHouse HTTP interface (port 8123) |
| `/artifacts/` | artifact browser |

Dashboard:

```text
http://localhost:8080/dashboard/
```

Telemetry endpoint:

```text
http://localhost:8080/api/v1/telemetry
```

ClickHouse HTTP (via proxy):

```text
http://localhost:8080/clickhouse/?query=SELECT%20version()
```

Artifacts:

```text
http://localhost:8080/artifacts/
```

Lab installer:

```text
http://localhost:8080/artifacts/installers/HostEye-Agent-Installer.zip
```

On the endpoint VM, extract the zip, open PowerShell as Administrator, then run:

```powershell
.\install-lab.ps1
```

If the endpoint VM is not the Docker host, point the installer at the gateway URL
(the single published port, or the public domain once deployed):

```powershell
.\install-lab.ps1 -GatewayUri "http://<docker-host>:8080/api/v1/telemetry"
```

## Notes

- TLS is no longer terminated inside the container. Put this behind a deployment
  platform (Dokploy/Traefik) or any reverse proxy to add HTTPS on a public domain.
- The ClickHouse native protocol (port 9000) is not exposed — only the HTTP
  interface is proxied under `/clickhouse/`. The default user has no password in
  this lab build, so do not expose `/clickhouse/` publicly without adding auth.
- The all-in-one gateway is relaxed for lab testing and does not enforce the
  original mTLS allowlist.
- The installer bundle is rebuilt at container startup.
