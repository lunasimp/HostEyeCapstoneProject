# HostEye Dashboard API

Node.js API for the SOC dashboard. It reads directly from ClickHouse through the HTTP endpoint.

No npm dependencies are required.

## Run

```powershell
cd C:\Users\admin\F-smooth-criminal-guard\VectorDashboardApi
copy .env.example .env
npm start
```

Default API URL:

```text
http://localhost:5055
```

Default ClickHouse URL:

```text
http://localhost:8123
```

## Useful Tests

```powershell
Invoke-RestMethod http://localhost:5055/api/health
Invoke-RestMethod "http://localhost:5055/api/dashboard/overview/summary"
Invoke-RestMethod "http://localhost:5055/api/dashboard/overview/security-timeline?limit=10"
Invoke-RestMethod "http://localhost:5055/api/dashboard/hosts/heatmap?top=10"
```

All dashboard endpoints accept:

```text
from=2026-06-01T00:00:00Z
to=2026-06-24T23:59:59Z
host=DESKTOP-2G18GQQ
limit=100
```

