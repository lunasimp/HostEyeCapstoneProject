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

## Notes

- The HTTPS listener generates a self-signed local certificate at container startup.
- The all-in-one gateway is relaxed for lab testing and does not enforce the original mTLS allowlist.
- Installer binaries are only included if they exist in `VectorBuild\Output` or other copied artifact folders at build time.

