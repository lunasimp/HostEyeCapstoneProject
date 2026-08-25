import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("authenticated deployments use HostEyeDashboardApi and persistent account storage", async () => {
  const compose = await readFile(resolve(ROOT, "Vector-HA-Cluster/docker-compose.yml"), "utf8");
  const dockerfile = await readFile(resolve(ROOT, "DockerAllInOne/Dockerfile"), "utf8");
  const supervisor = await readFile(resolve(ROOT, "DockerAllInOne/supervisord.conf"), "utf8");
  const dokploy = await readFile(resolve(ROOT, "DockerAllInOne/docker-compose.dokploy.yml"), "utf8");
  const apiServer = await readFile(resolve(ROOT, "HostEyeDashboardApi/src/server.js"), "utf8");
  const dashboardServer = await readFile(resolve(ROOT, "HostEyeDashboard/server.js"), "utf8");
  const tunnelCompose = await readFile(resolve(ROOT, "deploy/cloudflare-tunnel/docker-compose.dashboard-tunnel.yml"), "utf8");

  assert.match(compose, /\.\.\/HostEyeDashboardApi:\/app:ro/);
  assert.doesNotMatch(compose, /\.\.\/VectorDashboardApi:\/app:ro/);
  assert.match(compose, /hosteye_dashboard_auth_data:\/var\/lib\/hosteye-dashboard/);
  assert.match(compose, /HOSTEYE_DASHBOARD_BOOTSTRAP_ADMIN_PASSWORD/);
  assert.match(compose, /127\.0\.0\.1:5055:5055/);
  assert.match(compose, /127\.0\.0\.1:5174:5174/);
  assert.match(compose, /HOSTEYE_DASHBOARD_LOGIN_ATTEMPT_LIMIT/);
  assert.match(compose, /HOSTEYE_PUBLIC_HOST/);

  assert.match(apiServer, /Too many login attempts/);
  assert.match(apiServer, /content-security-policy/);
  assert.match(dashboardServer, /frame-ancestors 'none'/);
  assert.match(dashboardServer, /isAllowedHost/);

  assert.match(tunnelCompose, /hosteye-dashboard-cloudflared/);
  assert.match(tunnelCompose, /host\.docker\.internal:host-gateway/);
  assert.match(tunnelCompose, /no-new-privileges:true/);
  assert.doesNotMatch(tunnelCompose, /ports:/);

  assert.match(dockerfile, /COPY HostEyeDashboardApi \/opt\/hosteye\/HostEyeDashboardApi/);
  assert.doesNotMatch(dockerfile, /COPY VectorDashboardApi/);
  assert.match(supervisor, /directory=\/opt\/hosteye\/HostEyeDashboardApi/);
  assert.match(supervisor, /HOSTEYE_DASHBOARD_USERS_FILE="\/var\/lib\/hosteye-dashboard\/dashboard-users\.json"/);
  assert.match(dokploy, /hosteye_dashboard_auth:\/var\/lib\/hosteye-dashboard/);
});
