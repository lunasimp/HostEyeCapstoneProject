# HostEye All-In-One Container

This folder builds a single test container that runs:

- ClickHouse database with the existing schema
- Vector HTTP ingest gateway
- HostEye dashboard API
- HostEye dashboard web UI
- Nginx reverse proxy and artifact browser

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
  -p 8443:443 `
  -p 8123:8123 `
  -p 9000:9000 `
  -v hosteye_clickhouse:/var/lib/clickhouse `
  -v hosteye_vault:/var/log/soc_vault `
  hosteye-all-in-one:local
```

Dashboard:

```text
http://localhost:8080/dashboard/
```

Telemetry endpoint:

```text
http://localhost:8080/api/v1/telemetry
https://localhost:8443/api/v1/telemetry
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

The default lab endpoint is:

```text
https://localhost:8443/api/v1/telemetry
```

If the endpoint VM is not the Docker host, pass the Docker host address:

```powershell
.\install-lab.ps1 -GatewayUri "https://<docker-host>:8443/api/v1/telemetry"
```

## Notes

- The HTTPS listener generates a local lab CA and a server certificate at container startup.
- The lab installer bundle includes `certs\company_ca.crt` and imports it into `LocalMachine\Root`.
- The all-in-one gateway is relaxed for lab testing and does not enforce the original mTLS allowlist.
- The installer bundle is rebuilt at container startup so its CA matches the running container.
