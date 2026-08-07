# HostEye Dashboard API

Node.js API for the HostEye Dashboard. It reads directly from ClickHouse through the HTTP endpoint.

No npm dependencies are required.

## Run

```powershell
cd HostEyeDashboardApi
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


## Dashboard accounts

Outside `NODE_ENV=test`, Dashboard authentication is enabled by default. On first access, the API atomically creates the bootstrap Administrator in `data/dashboard-users.json`; only a PBKDF2-SHA256 salt/hash is stored.

Set these values before deployment:

```text
HOSTEYE_DASHBOARD_AUTH_REQUIRED=true
HOSTEYE_DASHBOARD_USERS_FILE=data/dashboard-users.json
HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_USERNAME=admin
HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD=<strong deployment secret>
HOSTEYE_DASHBOARD_SESSION_TTL_MINUTES=480
```

Use `POST /api/dashboard/auth/login` to obtain a Bearer session. Administrator sessions can create, update, lock, and unlock accounts through `/api/dashboard/admin/users`. The service prevents locking or demoting the final active Administrator.