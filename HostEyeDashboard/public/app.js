const API_BASE = window.HOSTEYE_API_BASE || "";
const palette = ["#ff8200", "#4c8dff", "#6dd17c", "#ff5364", "#b184ff", "#f7c948", "#59c3c3", "#f97090"];

const state = {
  hosts: [],
  loading: false,
  searchOffset: 0,
  searchLoaded: false,
  searchResult: null,
  searchRequestId: 0,
  alertOffset: 0,
  alertLoaded: false,
  alertResult: null,
  alertRequestId: 0,
  alertDetailRequestId: 0,
  lossDetailRequestId: 0,
  dynamicSaveInFlight: false,
  dynamicPreviewRequestId: 0,
  dynamicAssignmentInFlight: false,
  dynamicAssignmentData: { policies: [], agents: [], groups: [] },
  auth: { required: false, token: localStorage.getItem("hosteyeDashboardSession") || "", user: null },
  users: [],
  enrollment: { items: [], lastToken: null },
};

const el = (id) => document.getElementById(id);

const pages = {
  overview: { title: "Overview", eyebrow: "[ HOSTEYE OVERVIEW ]" },
  hosts: { title: "Host Inventory", eyebrow: "[ ENDPOINTS ]" },
  process: { title: "Process Activity", eyebrow: "[ PROCESS TELEMETRY ]" },
  network: { title: "Network & DNS", eyebrow: "[ NETWORK TELEMETRY ]" },
  registry: { title: "Registry & File", eyebrow: "[ ENDPOINT CHANGES ]" },
  powershell: { title: "PowerShell Monitoring", eyebrow: "[ SCRIPT ACTIVITY ]" },
  jitter: { title: "Shipper Jitter", eyebrow: "[ AGENT QUEUE ]" },
  chunks: { title: "Chunk Monitor", eyebrow: "[ SHIPPER BATCHES ]" },
  "fleet-loss": { title: "Fleet Log-Loss Monitoring", eyebrow: "[ ADMIN OPERATIONS ]" },
  "log-loss": { title: "Log-Loss Statistics", eyebrow: "[ DELIVERY ACCOUNTING ]" },
  "dynamic-config": { title: "Dynamic Configuration", eyebrow: "[ CONTROL PLANE ]" },
  enrollment: { title: "Endpoint Enrollment", eyebrow: "[ DEVICE IDENTITY ]" },
  users: { title: "User Management", eyebrow: "[ ADMIN ACCESS ]" },
  heatmap: { title: "Host Activity Heatmap", eyebrow: "[ TIME SERIES ]" },
  "agent-errors": { title: "Agent Chunk Errors", eyebrow: "[ AGENT DIAGNOSTICS ]" },
  search: { title: "Log Search", eyebrow: "[ TELEMETRY SEARCH ]" },
  alerts: { title: "Security Alerts", eyebrow: "[ DETECTION ]" },
};

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      const page = pageFromHash(item.getAttribute("href") || "");
      showPage(page);
      item.closest(".nav-group")?.removeAttribute("open");
    });
  });
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".nav-group[open]").forEach((group) => {
      if (!group.contains(event.target)) group.removeAttribute("open");
    });
  });
  window.addEventListener("hashchange", () => showPage(pageFromHash(window.location.hash)));

  el("refreshBtn").addEventListener("click", loadDashboard);
  el("rangeSelect").addEventListener("change", loadDashboard);
  el("hostFilter").addEventListener("change", loadDashboard);
  el("heatmapBucket")?.addEventListener("change", loadHeatmap);
  el("hostLevelFilter")?.addEventListener("change", () => renderHostsScreen(state.hostSummary || { hosts: [], groups: [] }));
  el("lossFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadLogLoss().catch((error) => console.error(error));
  });
  el("lossFilterReset")?.addEventListener("click", () => {
    el("lossFilterForm")?.reset();
    el("lossAlertThreshold").dataset.override = "false";
    el("lossInterruptionThreshold").dataset.override = "false";
    loadLossAlertThresholds()
      .then(() => loadLogLoss())
      .catch((error) => console.error(error));
  });
  el("lossExport")?.addEventListener("click", () => {
    exportLogLossReport().catch((error) => console.error(error));
  });
  el("fleetLossFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadFleetLogLoss().catch((error) => console.error(error));
  });
  el("fleetLossReset")?.addEventListener("click", () => {
    el("fleetLossFilterForm")?.reset();
    loadFleetLogLoss().catch((error) => console.error(error));
  });
  el("lossThresholdForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveLossAlertThresholds().catch((error) => console.error(error));
  });
  el("lossThresholdReload")?.addEventListener("click", () => {
    loadLossAlertThresholds().catch((error) => console.error(error));
  });
  ["lossAlertThreshold", "lossInterruptionThreshold"].forEach((id) => {
    el(id)?.addEventListener("change", (event) => {
      event.currentTarget.dataset.override = "true";
    });
  });
  el("logSearchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadLogSearch({ reset: true }).catch((error) => console.error(error));
  });
  el("searchReset")?.addEventListener("click", () => {
    el("logSearchForm")?.reset();
    state.searchOffset = 0;
    loadLogSearch({ reset: true }).catch((error) => console.error(error));
  });
  el("searchPrev")?.addEventListener("click", () => changeSearchPage(-1));
  el("searchNext")?.addEventListener("click", () => changeSearchPage(1));
  el("dynamicLogForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveDynamicLogDraft().catch((error) => console.error(error));
  });
  el("dynamicDraftPreview")?.addEventListener("click", () => {
    previewDynamicLogDraft().catch((error) => console.error(error));
  });
  el("dynamicLogForm")?.addEventListener("input", clearDynamicPreview);
  el("dynamicAssignmentForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    assignDynamicConfig().catch((error) => console.error(error));
  });
  el("dynamicAssignmentTargetType")?.addEventListener("change", renderDynamicAssignmentTargets);
  el("enrollmentTokenForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createEnrollmentToken().catch((error) => showEnrollmentError(error));
  });
  el("enrollmentDevicesTable")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-enrollment-action='revoke']");
    if (button) revokeEnrolledDevice(button).catch((error) => showEnrollmentError(error));
  });
  el("alertFilterForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loadAlerts({ reset: true }).catch((error) => console.error(error));
  });
  el("alertReset")?.addEventListener("click", () => {
    el("alertFilterForm")?.reset();
    state.alertOffset = 0;
    loadAlerts({ reset: true }).catch((error) => console.error(error));
  });
  el("alertsPrev")?.addEventListener("click", () => changeAlertPage(-1));
  el("alertsNext")?.addEventListener("click", () => changeAlertPage(1));
  el("loginForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    loginDashboard().catch(() => {});
  });
  el("logoutBtn")?.addEventListener("click", () => {
    logoutDashboard().catch((error) => console.error(error));
  });
  el("userCreateForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createDashboardUser().catch(() => {});
  });
  el("userReload")?.addEventListener("click", () => {
    loadDashboardUsers().catch((error) => console.error(error));
  });
  el("usersTable")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-user-action]");
    if (button) updateDashboardUser(button).catch(() => {});
  });
  el("alertDetailClose")?.addEventListener("click", closeAlertDetail);
  el("alertDetailModal")?.addEventListener("click", (event) => {
    if (event.target === el("alertDetailModal")) closeAlertDetail();
  });
  el("lossDetailClose")?.addEventListener("click", closeLossDetail);
  el("lossDetailModal")?.addEventListener("click", (event) => {
    if (event.target === el("lossDetailModal")) closeLossDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el("alertDetailModal")?.hidden) closeAlertDetail();
    if (event.key === "Escape" && !el("lossDetailModal")?.hidden) closeLossDetail();
  });
  document.querySelectorAll(".section-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.closest(".section-card");
      const isOpen = section.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(isOpen));
    });
  });
  initializeDashboard().catch((error) => {
    console.error(error);
    showLogin(error.message || "Unable to initialize Dashboard authentication");
  });
});

function pageFromHash(hash) {
  const value = String(hash || "").replace(/^#/, "");
  return pages[value] ? value : "overview";
}

function showPage(page) {
  let selectedPage = pages[page] ? page : "overview";
  if (state.auth.user && !hasPermission(pagePermission(selectedPage))) selectedPage = firstAuthorizedPage();
  document.querySelectorAll(".page-view").forEach((view) => {
    view.hidden = view.dataset.page !== selectedPage;
  });
  document.querySelectorAll(".nav-item").forEach((link) => {
    link.classList.toggle("active", pageFromHash(link.getAttribute("href")) === selectedPage);
  });
  document.querySelectorAll(".nav-group").forEach((group) => {
    group.classList.toggle("has-active", Boolean(group.querySelector(".nav-item.active")));
  });
  if (window.location.hash !== `#${selectedPage}`) {
    history.replaceState(null, "", `#${selectedPage}`);
  }
  const meta = pages[selectedPage];
  el("pageHeading").textContent = meta.title;
  el("pageEyebrow").textContent = meta.eyebrow;
  if (selectedPage === "search" && !state.searchLoaded) {
    loadLogSearch({ reset: true }).catch((error) => console.error(error));
  }
  if (selectedPage === "alerts" && !state.alertLoaded) {
    loadAlerts({ reset: true }).catch((error) => console.error(error));
  }
  if (selectedPage === "users") {
    loadDashboardUsers().catch((error) => console.error(error));
  }
  if (selectedPage === "enrollment") {
    loadEnrollment().catch((error) => showEnrollmentError(error));
  }
}

async function initializeDashboard() {
  const status = await api("/api/dashboard/auth/status", { auth: false });
  state.auth.required = Boolean(status.required);
  if (state.auth.token) {
    try {
      const result = await api("/api/dashboard/auth/me");
      state.auth.user = result.user;
    } catch {
      state.auth.token = "";
      localStorage.removeItem("hosteyeDashboardSession");
    }
  }
  if (state.auth.required && !state.auth.user) {
    showLogin();
    return;
  }
  if (!state.auth.user) {
    state.auth.user = { username: "local-system", displayName: "Local mode", role: "admin" };
  }
  renderCurrentUser();
  showPage(pageFromHash(window.location.hash));
  await loadDashboard();
}

function showLogin(message = "") {
  el("loginModal").hidden = false;
  document.body.classList.add("modal-open");
  el("loginStatus").textContent = message;
  setTimeout(() => el("loginUsername")?.focus(), 0);
}

function hideLogin() {
  el("loginModal").hidden = true;
  document.body.classList.remove("modal-open");
  el("loginStatus").textContent = "";
}

async function loginDashboard() {
  const button = el("loginSubmit");
  button.disabled = true;
  el("loginStatus").textContent = "Signing in...";
  try {
    const result = await api("/api/dashboard/auth/login", {
      auth: false,
      method: "POST",
      body: { username: el("loginUsername").value, password: el("loginPassword").value },
    });
    state.auth.token = result.token;
    state.auth.user = result.user;
    localStorage.setItem("hosteyeDashboardSession", result.token);
    el("loginPassword").value = "";
    hideLogin();
    renderCurrentUser();
    showPage(pageFromHash(window.location.hash));
    await loadDashboard();
  } catch (error) {
    el("loginStatus").textContent = "Sign-in failed. Check the account state and credentials.";
  } finally {
    button.disabled = false;
  }
}

async function logoutDashboard() {
  try {
    if (state.auth.token) await api("/api/dashboard/auth/logout", { method: "POST" });
  } finally {
    state.auth.token = "";
    state.auth.user = null;
    localStorage.removeItem("hosteyeDashboardSession");
    renderCurrentUser();
    showLogin("Signed out.");
  }
}

function renderCurrentUser() {
  const user = state.auth.user;
  el("currentUserAvatar").textContent = user?.displayName?.charAt(0)?.toUpperCase() || "?";
  el("currentUserName").textContent = user?.displayName || user?.username || "Guest";
  el("currentUserRole").textContent = `// ${user?.role || "not signed in"}`;
  el("logoutBtn").hidden = !state.auth.token;
  applyNavigationPermissions(user);
}

function hasPermission(permission, user = state.auth.user) {
  if (user?.role === "admin") return true;
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  return permissions.includes("*") || permissions.includes(permission);
}

function pagePermission(page) {
  const requirements = {
    overview: "dashboard:view", hosts: "dashboard:view", heatmap: "dashboard:view",
    alerts: "alerts:read", search: "telemetry:read", process: "telemetry:read",
    network: "telemetry:read", registry: "telemetry:read", powershell: "telemetry:read",
    jitter: "dashboard:view", chunks: "dashboard:view", "fleet-loss": "operations:admin",
    "log-loss": "loss:read", "agent-errors": "dashboard:view", "dynamic-config": "config:read",
    enrollment: "enrollment:read", users: "users:manage",
  };
  return requirements[page] || "dashboard:view";
}

function firstAuthorizedPage(user = state.auth.user) {
  return Object.keys(pages).find((page) => hasPermission(pagePermission(page), user)) || "overview";
}

function applyNavigationPermissions(user) {
  document.querySelectorAll("a.nav-item[href^='#']").forEach((link) => {
    const page = link.getAttribute("href").slice(1);
    link.hidden = !hasPermission(pagePermission(page), user);
  });
}

function parseAccountList(value) {
  return [...new Set(String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

async function loadDashboardUsers() {
  const container = el("usersTable");
  if (!container) return;
  if (!state.auth.token || !hasPermission("users:manage")) {
    container.innerHTML = '<div class="empty-state">An account with users:manage permission is required.</div>';
    return;
  }
  const result = await api("/api/dashboard/admin/users");
  state.users = result.items || [];
  container.innerHTML = state.users.length ? `
    <table><thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Permissions</th><th>Host scope</th><th>Agent scope</th><th>Group scope</th><th>State</th><th>Last login</th><th>Actions</th></tr></thead><tbody>
      ${state.users.map((user) => `<tr data-user-id="${escapeHtml(user.id)}">
        <td><input data-field="username" value="${escapeHtml(user.username)}"></td>
        <td><input data-field="displayName" value="${escapeHtml(user.displayName)}"></td>
        <td><select data-field="role"><option value="user"${user.role === "user" ? " selected" : ""}>User</option><option value="viewer"${user.role === "viewer" ? " selected" : ""}>Viewer</option><option value="admin"${user.role === "admin" ? " selected" : ""}>Admin</option></select></td>
        <td><input data-field="permissions" value="${escapeHtml((user.permissions || []).join(", "))}" ${user.role === "admin" ? "disabled" : ""}></td>
        <td><input data-field="scopeHosts" value="${escapeHtml((user.scopes?.hosts || []).join(", "))}"></td>
        <td><input data-field="scopeAgents" value="${escapeHtml((user.scopes?.agents || []).join(", "))}"></td>
        <td><input data-field="scopeGroups" value="${escapeHtml((user.scopes?.groups || []).join(", "))}"></td>
        <td><span class="status-pill ${user.locked ? "failed" : "ok"}">${user.locked ? "Locked" : "Active"}</span></td>
        <td>${user.lastLoginAt ? formatDate(user.lastLoginAt) : "Never"}</td>
        <td class="user-actions"><input data-field="password" type="password" minlength="10" placeholder="New password"><button class="button ghost" data-user-action="save" type="button">Save</button><button class="button ${user.locked ? "secondary" : "ghost"}" data-user-action="${user.locked ? "unlock" : "lock"}" type="button">${user.locked ? "Unlock" : "Lock"}</button></td>
      </tr>`).join("")}
    </tbody></table>` : '<div class="empty-state">No Dashboard accounts found.</div>';
}

async function createDashboardUser() {
  const status = el("userManagementStatus");
  status.textContent = "Creating account...";
  try {
    const permissions = parseAccountList(el("newUserPermissions").value);
    const result = await api("/api/dashboard/admin/users", {
      method: "POST",
      body: {
        username: el("newUsername").value,
        displayName: el("newDisplayName").value,
        role: el("newUserRole").value,
        password: el("newUserPassword").value,
        ...(permissions.length ? { permissions } : {}),
        scopes: {
          hosts: parseAccountList(el("newUserScopeHosts").value),
          agents: parseAccountList(el("newUserScopeAgents").value),
          groups: parseAccountList(el("newUserScopeGroups").value),
        },
      },
    });
    el("userCreateForm").reset();
    status.textContent = `Created ${result.user.username}.`;
    await loadDashboardUsers();
  } catch (error) {
    status.textContent = accountErrorMessage(error);
  }
}

async function updateDashboardUser(button) {
  const row = button.closest("tr[data-user-id]");
  const id = row.dataset.userId;
  const action = button.dataset.userAction;
  button.disabled = true;
  try {
    if (action === "save") {
      const password = row.querySelector('[data-field="password"]').value;
      const role = row.querySelector('[data-field="role"]').value;
      const permissions = parseAccountList(row.querySelector('[data-field="permissions"]').value);
      await api(`/api/dashboard/admin/users/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: {
          username: row.querySelector('[data-field="username"]').value,
          displayName: row.querySelector('[data-field="displayName"]').value,
          role,
          ...(!permissions.includes("*") ? { permissions } : {}),
          scopes: {
            hosts: parseAccountList(row.querySelector('[data-field="scopeHosts"]').value),
            agents: parseAccountList(row.querySelector('[data-field="scopeAgents"]').value),
            groups: parseAccountList(row.querySelector('[data-field="scopeGroups"]').value),
          },
          ...(password ? { password } : {}),
        },
      });
      el("userManagementStatus").textContent = "Account updated.";
    } else {
      await api(`/api/dashboard/admin/users/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      el("userManagementStatus").textContent = `Account ${action === "lock" ? "locked" : "unlocked"}.`;
    }
    await loadDashboardUsers();
  } catch (error) {
    el("userManagementStatus").textContent = accountErrorMessage(error);
  } finally {
    button.disabled = false;
  }
}
function accountErrorMessage(error) {
  const text = String(error?.message || "Account operation failed");
  const match = text.match(/\{"message":"([^"]+)"/);
  return match?.[1] || text;
}

async function loadDashboard() {
  if (state.loading) return;
  state.loading = true;
  setStatus("Connecting", false);

  try {
    const health = await api("/api/health");
    const latest = health.lastSeen ? `latest ${formatDate(health.lastSeen)}` : "no telemetry";
    const age = health.dataAgeSeconds === null || health.dataAgeSeconds === undefined
      ? ""
      : ` | ${formatAge(health.dataAgeSeconds)} old`;
    setStatus(
      health.stale ? "Connected - telemetry stale" : "Connected",
      true,
      `${formatNumber(health.rows)} rows all-time | ${latest}${age}`,
    );

    const tasks = [];
    if (hasPermission("dashboard:view")) {
      await loadSummaryAndHosts();
      tasks.push(loadHostsScreen(), loadOverview(), loadJitter(), loadChunks(), loadHeatmap(), loadAgentErrors());
    } else {
      resetKpis();
    }
    if (hasPermission("telemetry:read")) {
      tasks.push(loadProcess(), loadNetworkDns(), loadRegistryFileAccess(), loadPowerShell());
    }
    if (hasPermission("operations:admin")) {
      tasks.push(loadLossAlertThresholds(), loadFleetLogLoss());
    }
    if (hasPermission("loss:read")) tasks.push(loadLogLoss());
    if (hasPermission("config:read")) tasks.push(loadDynamicConfig());
    if (hasPermission("enrollment:read")) tasks.push(loadEnrollment());
    await Promise.all(tasks);
  } catch (error) {
    console.error(error);
    setStatus("API offline", false, "Check dashboard API");
    resetKpis();
    renderErrorEverywhere(error.message || "API offline");
  } finally {
    state.loading = false;
  }
}
function resetKpis() {
  [
    "kpiEvents",
    "kpiHosts",
    "kpiEventIds",
    "kpiLastSeen",
    "jitterHosts",
    "jitterAvg",
    "jitterP95",
    "jitterWorst",
    "chunkCount",
    "chunkHosts",
    "chunkEvents",
    "chunkFailed",
    "dynamicPolicyCount",
    "dynamicActivePolicyCount",
    "dynamicAgentCount",
    "dynamicGroupCount",
  ].forEach((id) => {
    const node = el(id);
    if (node) node.textContent = "-";
  });
}

async function loadAlerts(options = {}) {
  const requestId = ++state.alertRequestId;
  if (options.reset) state.alertOffset = 0;
  const params = new URLSearchParams();
  const range = selectedRange();
  params.set("from", dateTimeInputIso(el("alertFrom")?.value, range.from));
  params.set("to", dateTimeInputIso(el("alertTo")?.value, range.to));
  params.set("limit", "100");
  params.set("offset", String(state.alertOffset || 0));
  const values = {
    q: el("alertKeyword")?.value.trim(),
    severity: el("alertSeverity")?.value,
    status: el("alertStatus")?.value,
    host: el("alertHost")?.value.trim() || el("hostFilter")?.value,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }

  el("alertsMeta").textContent = "Loading alerts...";
  try {
    const data = await api(`/api/alerts?${params.toString()}`);
    if (requestId !== state.alertRequestId) return;
    state.alertLoaded = true;
    state.alertResult = data;
    renderAlerts(data);
  } catch (error) {
    if (requestId !== state.alertRequestId) return;
    el("alertsMeta").textContent = "Alerts unavailable";
    el("alertsTable").innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Alerts unavailable")}</div>`;
    throw error;
  }
}

function renderAlerts(data) {
  const summary = data.summary || {};
  el("alertTotal").textContent = formatNumber(summary.total);
  el("alertCritical").textContent = formatNumber(summary.critical);
  el("alertHigh").textContent = formatNumber(summary.high);
  el("alertMedium").textContent = formatNumber(summary.medium);

  const rows = data.items || [];
  const start = data.total > 0 ? data.offset + 1 : 0;
  const end = data.offset + rows.length;
  el("alertsMeta").textContent = `Showing ${formatNumber(start)}-${formatNumber(end)} of ${formatNumber(data.total)} alerts`;
  el("alertsPrev").disabled = data.offset <= 0;
  el("alertsNext").disabled = !data.hasMore;
  renderAlertTable(el("alertsTable"), rows);
}

function renderAlertTable(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No alerts in the selected range</div>`;
    return;
  }

  const body = rows.map((alert) => `
    <tr>
      <td title="${escapeAttr(alert.detectedAt)}">${escapeHtml(formatDate(alert.detectedAt))}</td>
      <td><span class="severity-badge severity-${escapeAttr(alert.severity)}">${escapeHtml(String(alert.severity || "unknown").toUpperCase())}</span></td>
      <td title="${escapeAttr(alert.ruleId)}">${escapeHtml(alert.ruleId || "-")}</td>
      <td title="${escapeAttr(alert.title)}">${escapeHtml(alert.title || "-")}</td>
      <td title="${escapeAttr(alert.computer)}">${escapeHtml(alert.computer || "-")}</td>
      <td class="numeric">${formatNumber(alert.evidenceCount)}</td>
      <td title="${escapeAttr(alert.userName)}">${escapeHtml(alert.userName || "-")}</td>
      <td title="${escapeAttr(alert.sourceIp)}">${escapeHtml(alert.sourceIp || "-")}</td>
      <td title="${escapeAttr(alert.message)}">${escapeHtml(alert.message || "-")}</td>
      <td><button class="secondary-btn alert-view-btn" type="button" data-alert-id="${escapeAttr(alert.alertId)}">View</button></td>
    </tr>
  `).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Detected</th>
          <th>Severity</th>
          <th>Rule</th>
          <th>Alert</th>
          <th>Host</th>
          <th class="numeric">Evidence</th>
          <th>User</th>
          <th>Source IP</th>
          <th>Message</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
  container.querySelectorAll(".alert-view-btn").forEach((button) => {
    button.addEventListener("click", () => openAlertDetail(button.dataset.alertId));
  });
}


async function openAlertDetail(alertId) {
  const requestId = ++state.alertDetailRequestId;
  el("alertDetailModal").hidden = false;
  document.body.classList.add("modal-open");
  el("alertDetailContent").innerHTML = `<div class="empty-state">Loading alert evidence...</div>`;
  const params = new URLSearchParams();
  const appliedFilters = state.alertResult?.filters || {};
  const range = selectedRange();
  params.set("from", appliedFilters.from || range.from);
  params.set("to", appliedFilters.to || range.to);
  params.set("limit", "100");
  const host = appliedFilters.host || el("alertHost")?.value.trim() || el("hostFilter")?.value;
  if (host) params.set("host", host);
  try {
    const data = await api(`/api/alerts/${encodeURIComponent(alertId)}?${params.toString()}`);
    if (requestId !== state.alertDetailRequestId) return;
    renderAlertDetail(data);
  } catch (error) {
    if (requestId !== state.alertDetailRequestId) return;
    el("alertDetailContent").innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Alert details unavailable")}</div>`;
  }
}

function closeAlertDetail() {
  state.alertDetailRequestId += 1;
  el("alertDetailModal").hidden = true;
  document.body.classList.remove("modal-open");
}

function renderAlertDetail(data) {
  const alert = data.alert || {};
  const evidence = data.evidence || [];
  const fields = [
    ["Severity", `<span class="severity-badge severity-${escapeAttr(alert.severity)}">${escapeHtml(String(alert.severity || "unknown").toUpperCase())}</span>`],
    ["Detected", escapeHtml(formatDate(alert.detectedAt))],
    ["Host", escapeHtml(alert.computer || "-")],
    ["Rule", escapeHtml(alert.ruleId || "-")],
    ["Alert ID", `<code>${escapeHtml(alert.alertId || "-")}</code>`],
    ["Status", escapeHtml(alert.status || "-")],
    ["Channel / Event ID", escapeHtml(`${alert.channel || "-"} / ${alert.eventId || "-"}`)],
    ["Evidence", escapeHtml(formatNumber(data.evidenceTotal ?? alert.evidenceCount))],
    ["User", escapeHtml(alert.userName || "-")],
    ["Source IP", escapeHtml(alert.sourceIp || "-")],
    ["Agent ID", `<code>${escapeHtml(alert.agentId || "-")}</code>`],
    ["Host ID", `<code>${escapeHtml(alert.hostId || "-")}</code>`],
  ].map(([label, value]) => `<div class="alert-detail-field"><span>${label}</span><strong>${value}</strong></div>`).join("");

  const evidenceRows = evidence.length ? evidence.map((row) => `
    <tr>
      <td>${escapeHtml(formatDate(row.time))}</td>
      <td><span class="evidence-relation">${escapeHtml(row.relation || "evidence")}</span></td>
      <td>${escapeHtml(`${row.channel || "-"} / ${row.eventId || "-"}`)}</td>
      <td>${escapeHtml(row.userName || "-")}</td>
      <td title="${escapeAttr(row.processPath || row.sourceIp)}">${escapeHtml(row.processPath || row.sourceIp || "-")}</td>
      <td title="${escapeAttr(row.message)}">${escapeHtml(row.message || row.commandLine || "-")}</td>
    </tr>
  `).join("") : `<tr><td colspan="6">No related logs found</td></tr>`;

  const technical = [alert.commandLine, alert.scriptBlockText, alert.rawLog, alert.eventDataJson].filter(Boolean).join("\n\n");
  el("alertDetailTitle").textContent = alert.title || "Alert details";
  el("alertDetailContent").innerHTML = `
    <div class="alert-detail-summary">${fields}</div>
    <p class="alert-detail-message">${escapeHtml(alert.message || "No alert message")}</p>
    <article class="panel">
      <div class="panel-title"><h3>Related log evidence</h3><span>${formatNumber(evidence.length)} displayed</span></div>
      <div class="table-shell logs">
        <table><thead><tr><th>Time</th><th>Relation</th><th>Channel / Event</th><th>User</th><th>Process / Source</th><th>Message</th></tr></thead>
        <tbody>${evidenceRows}</tbody></table>
      </div>
    </article>
    ${technical ? `<details class="alert-detail-technical"><summary>Technical evidence</summary><pre>${escapeHtml(technical)}</pre></details>` : ""}
  `;
}

function changeAlertPage(direction) {
  const result = state.alertResult || {};
  const limit = Number(result.limit || 100);
  state.alertOffset = Math.max(0, Number(result.offset || 0) + direction * limit);
  loadAlerts().catch((error) => console.error(error));
}

async function loadLogSearch(options = {}) {
  const requestId = ++state.searchRequestId;
  if (options.reset) state.searchOffset = 0;
  const limit = Number(el("searchLimit")?.value || 100);
  const params = new URLSearchParams();
  const range = selectedRange();
  params.set("from", dateTimeInputIso(el("searchFrom")?.value, range.from));
  params.set("to", dateTimeInputIso(el("searchTo")?.value, range.to));
  params.set("limit", String(limit));
  params.set("offset", String(state.searchOffset || 0));

  const values = {
    q: el("searchKeyword")?.value.trim(),
    host: el("searchHost")?.value.trim() || el("hostFilter")?.value,
    channel: el("searchChannel")?.value.trim(),
    eventId: el("searchEventId")?.value.trim(),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }

  el("searchMeta").textContent = "Searching...";
  try {
    const data = await api(`/api/logs/search?${params.toString()}`);
    if (requestId !== state.searchRequestId) return;
    state.searchLoaded = true;
    state.searchResult = data;
    renderLogSearch(data);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    el("searchMeta").textContent = "Search failed";
    el("searchResultsTable").innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Search failed")}</div>`;
    throw error;
  }
}

function renderLogSearch(data) {
  const rows = data.items || [];
  const start = data.total > 0 ? data.offset + 1 : 0;
  const end = data.offset + rows.length;
  el("searchMeta").textContent = `Showing ${formatNumber(start)}-${formatNumber(end)} of ${formatNumber(data.total)} logs`;
  el("searchPrev").disabled = data.offset <= 0;
  el("searchNext").disabled = !data.hasMore;

  renderTable(el("searchResultsTable"), rows, [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Channel", "channel"],
    ["Event ID", "eventId", "numeric"],
    ["Level", "level"],
    ["User", "userName"],
    ["Process", "processPath"],
    ["Source IP", "sourceIp"],
    ["Destination IP", "destinationIp"],
    ["Message", "message"],
  ]);
}

function dateTimeInputIso(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function changeSearchPage(direction) {
  const result = state.searchResult || {};
  const limit = Number(result.limit || el("searchLimit")?.value || 100);
  state.searchOffset = Math.max(0, Number(result.offset || 0) + direction * limit);
  loadLogSearch().catch((error) => console.error(error));
}

async function loadSummaryAndHosts() {
  const [summary, topHosts] = await Promise.all([
    api(`/api/dashboard/overview/summary${query()}`),
    api(`/api/dashboard/overview/top-hosts${query({ limit: 50 })}`),
  ]);

  el("kpiEvents").textContent = formatNumber(summary.totalEvents);
  el("kpiEventsLabel").textContent = el("rangeSelect").value === "all"
    ? "All-time events"
    : "Events in selected range";
  el("kpiHosts").textContent = formatNumber(summary.totalHosts);
  el("kpiEventIds").textContent = formatNumber(summary.totalEventIds);
  el("kpiLastSeen").textContent = formatDate(summary.lastSeen);

  const select = el("hostFilter");
  const selected = select.value;
  state.hosts = topHosts.items || [];
  select.innerHTML = `<option value="">All hosts</option>` + state.hosts
    .map((host) => `<option value="${escapeAttr(host.computer)}">${escapeHtml(host.computer)} (${formatNumber(host.events)})</option>`)
    .join("");
  select.value = selected;
}

async function loadHostsScreen() {
  const data = await api(`/api/dashboard/hosts/summary${query({ limit: 5000 })}`);
  state.hostSummary = data;
  renderHostsScreen(data);
}

function renderHostsScreen(data) {
  const groups = data.groups || [];
  const hosts = data.hosts || [];
  const selectedLevel = el("hostLevelFilter")?.value || "";
  const visibleHosts = selectedLevel ? hosts.filter((host) => host.statusLevel === selectedLevel) : hosts;

  el("hostLevelCards").innerHTML = groups.map((group) => `
    <button class="host-level-card status-${escapeAttr(group.level)}" type="button" data-level="${escapeAttr(group.level)}">
      <span>${escapeHtml(group.label)}</span>
      <strong>${formatNumber(group.count)}</strong>
    </button>
  `).join("");

  el("hostLevelCards").querySelectorAll(".host-level-card").forEach((card) => {
    card.addEventListener("click", () => {
      const level = card.dataset.level || "";
      const select = el("hostLevelFilter");
      select.value = select.value === level ? "" : level;
      renderHostsScreen(state.hostSummary || { hosts: [], groups: [] });
    });
  });

  renderHostTable(el("hostsSummaryTable"), visibleHosts);
}

function renderHostTable(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No hosts in selected level</div>`;
    return;
  }

  const body = rows.map((host) => {
    const ackHttp = [host.lastAckStatus || "-", Number(host.statusCode || 0) || "-"].join(" / ");
    const agent = host.agentId || host.hostId || "-";
    return `
      <tr>
        <td title="${escapeAttr(host.computer)}">${escapeHtml(host.computer || "(empty)")}</td>
        <td title="${escapeAttr(host.shipperVersion || "")}">${escapeHtml(agent)}</td>
        <td><span class="status-badge status-${escapeAttr(host.statusLevel)}">${escapeHtml(host.statusLabel)}</span></td>
        <td><span class="status-badge status-${escapeAttr(host.collectionLevel)}">${escapeHtml(host.collectionLabel)}</span></td>
        <td title="${escapeAttr(host.lastLogSeen)}">${escapeHtml(formatDate(host.lastLogSeen))}</td>
        <td title="${escapeAttr(host.lastMetricSeen)}">${escapeHtml(formatDate(host.lastMetricSeen))}</td>
        <td title="${escapeAttr(ackHttp)}">${escapeHtml(ackHttp)}</td>
        <td class="numeric">${formatBytes(host.spoolDepthBytes)}</td>
        <td class="numeric">${formatNumber(host.pendingFileCount)}</td>
        <td class="numeric">${formatNumber(host.totalEvents)}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Host</th>
          <th>Agent</th>
          <th>Activity</th>
          <th>Collection health</th>
          <th>Last log</th>
          <th>Last upload</th>
          <th>ACK / HTTP</th>
          <th class="numeric">Spool</th>
          <th class="numeric">Pending</th>
          <th class="numeric">Events</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

async function loadOverview() {
  const [volume, hosts, eventTypes, timeline] = await Promise.all([
    api(`/api/dashboard/overview/log-volume${query({ bucket: selectedBucket() })}`),
    api(`/api/dashboard/overview/top-hosts${query({ limit: 8 })}`),
    api(`/api/dashboard/overview/event-types${query({ limit: 30 })}`),
    api(`/api/dashboard/overview/security-timeline${query({ limit: 80 })}`),
  ]);

  el("logVolumeMeta").textContent = `${volume.items?.length || 0} buckets`;
  renderLineChart(el("logVolumeChart"), volume.items || [], "time", "events", "#6dd17c");
  renderPie(el("topHostsPie"), hosts.items || [], "computer", "events");
  renderTable(el("eventTypesTable"), eventTypes.items || [], [
    ["Event type", "eventType"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("securityTimeline"), timeline.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Event type", "eventType"],
    ["User", "userName"],
    ["Message", "message"],
  ]);
}

async function loadProcess() {
  const [top, recent] = await Promise.all([
    api(`/api/dashboard/process/top-processes${query({ limit: 40 })}`),
    api(`/api/dashboard/process/recent${query({ limit: 80 })}`),
  ]);

  renderTable(el("topProcessesTable"), top.items || [], [
    ["Process", "processPath"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("processRecentTable"), recent.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Type", "eventType"],
    ["User", "userName"],
    ["Command line", "commandLine"],
  ]);
}

async function loadNetworkDns() {
  const [ips, network, domains, dns] = await Promise.all([
    api(`/api/dashboard/network/top-destination-ips${query({ limit: 40 })}`),
    api(`/api/dashboard/network/recent${query({ limit: 80 })}`),
    api(`/api/dashboard/dns/top-domains${query({ limit: 40 })}`),
    api(`/api/dashboard/dns/recent${query({ limit: 80 })}`),
  ]);

  renderTable(el("topIpsTable"), ips.items || [], [
    ["Destination IP", "destinationIp"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("networkRecentTable"), network.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["User", "userName"],
    ["Process GUID", "processGuid"],
    ["Destination IP", "destinationIp"],
    ["Port", "destinationPort", "numeric"],
  ]);
  renderTable(el("topDomainsTable"), domains.items || [], [
    ["Domain", "domain"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("dnsRecentTable"), dns.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["User", "userName"],
    ["Process GUID", "processGuid"],
    ["DNS query", "dnsQuery"],
  ]);
}

async function loadRegistryFileAccess() {
  const [registry, file, access] = await Promise.all([
    api(`/api/dashboard/registry/recent${query({ limit: 80 })}`),
    api(`/api/dashboard/file/recent${query({ limit: 80 })}`),
    api(`/api/dashboard/process-access/recent${query({ limit: 80 })}`),
  ]);

  renderTable(el("registryRecentTable"), registry.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Type", "eventType"],
    ["User", "userName"],
    ["Target", "targetObject"],
  ]);
  renderTable(el("fileRecentTable"), file.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Type", "eventType"],
    ["User", "userName"],
    ["Target file", "targetFilename"],
  ]);
  renderTable(el("processAccessTable"), access.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["User", "userName"],
    ["Source", "processPath"],
    ["Target", "targetImage"],
    ["Access", "grantedAccess"],
  ]);
}

async function loadPowerShell() {
  const [volume, recent] = await Promise.all([
    api(`/api/dashboard/powershell/volume${query({ bucket: "minute" })}`),
    api(`/api/dashboard/powershell/recent${query({ limit: 80 })}`),
  ]);

  renderLineChart(el("powershellVolumeChart"), volume.items || [], "time", "events", "#ff8200");
  renderTable(el("powershellRecentTable"), recent.items || [], [
    ["Time", "time", "date"],
    ["Host", "computer"],
    ["Event ID", "eventId", "numeric"],
    ["Level", "level"],
    ["Script block", "scriptBlockText"],
  ]);
}

async function loadJitter() {
  const [summary, hosts] = await Promise.all([
    api(`/api/dashboard/jitter/summary${query()}`),
    api(`/api/dashboard/jitter/hosts${query({ limit: 100 })}`),
  ]);

  const rows = hosts.items || [];
  el("jitterHosts").textContent = formatNumber(summary.hosts);
  el("jitterAvg").textContent = formatMs(summary.avgJitterMs);
  el("jitterP95").textContent = formatMs(summary.p95JitterMs);
  el("jitterWorst").textContent = summary.worstHost?.computer || "-";

  const configuredOnly = summary.source === "registered_config";
  el("jitterEvidenceNote").textContent = configuredOnly
    ? "Actual per-send jitter telemetry is not available yet; values below are the signed jitter windows registered for each Agent."
    : "Values are calculated from client-reported per-send runtime metrics.";
  el("jitterHostsLabel").textContent = configuredOnly ? "Configured Agents" : "Metric hosts";
  el("jitterAvgLabel").textContent = configuredOnly ? "Avg normal window" : "Avg jitter";
  el("jitterP95Label").textContent = configuredOnly ? "P95 normal window" : "P95 jitter";
  el("jitterWorstLabel").textContent = configuredOnly ? "Largest window host" : "Worst host";
  el("jitterChartTitle").textContent = configuredOnly ? "Configured normal jitter window by host" : "Planned jitter by host";

  renderBarChart(el("jitterChart"), rows.slice(0, 12), "computer", "p95JitterMs", "#3b82f6", formatMs);
  renderTable(el("jitterHostsTable"), rows, configuredOnly ? [
    ["Host", "computer"],
    ["Status", "statusLabel"],
    ["Normal window", "p95JitterMs", "duration"],
    ["Recovery window", "recoveryJitterWindowMs", "duration"],
    ["Max events", "maxBatchSize", "numeric"],
    ["Last registration", "lastSeen", "date"],
  ] : [
    ["Host", "computer"],
    ["Status", "statusLabel"],
    ["Samples", "samples", "numeric"],
    ["Avg jitter", "avgJitterMs", "duration"],
    ["P95 jitter", "p95JitterMs", "duration"],
    ["Batch avg", "avgBatchSize", "numeric"],
    ["Spool", "spoolDepthBytes", "bytes"],
    ["Pending", "pendingFileCount", "numeric"],
    ["Last seen", "lastSeen", "date"],
  ]);
}

async function loadChunks() {
  const [summary, hosts] = await Promise.all([
    api(`/api/dashboard/chunks/summary${query()}`),
    api(`/api/dashboard/chunks/hosts${query({ limit: 100 })}`),
  ]);

  const rows = hosts.items || [];
  el("chunkCount").textContent = formatNumber(summary.chunks);
  el("chunkHosts").textContent = formatNumber(summary.hosts);
  el("chunkEvents").textContent = formatNumber(summary.eventsSent);
  el("chunkFailed").textContent = formatNumber(summary.failedChunks);

  const ingestEvidence = summary.source === "ingest_chunks";
  el("chunkEvidenceNote").textContent = ingestEvidence
    ? "Chunk counts come from durable gateway/worker lineage in ClickHouse. Spool and client timing require Shipper runtime metrics."
    : "Chunk, spool, jitter, and send timing come from Shipper runtime metrics.";
  el("chunkChartTitle").textContent = ingestEvidence ? "Durably accepted events by host" : "Spool depth by host";
  renderBarChart(el("chunkSpoolChart"), rows.slice(0, 12), "computer", ingestEvidence ? "eventsSent" : "spoolDepthBytes", "#17b26a", ingestEvidence ? formatNumber : formatBytes);
  renderChunkHostTable(el("chunkHostsTable"), rows, ingestEvidence);
}

function renderChunkHostTable(container, rows, ingestEvidence = false) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No chunks</div>`;
    return;
  }

  const body = rows.map((row) => ingestEvidence ? `
    <tr class="clickable-row" data-host="${escapeAttr(row.computer)}" data-time="${escapeAttr(row.lastSeen)}">
      <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "(empty)")}</td>
      <td><span class="status-badge status-${escapeAttr(row.statusLevel)}">${escapeHtml(row.statusLabel)}</span></td>
      <td title="${escapeAttr(row.lastChunk)}">${escapeHtml(row.lastChunk || "-")}</td>
      <td class="numeric">${formatNumber(row.chunks)}</td>
      <td class="numeric">${formatNumber(row.eventsSent)}</td>
      <td class="numeric">${formatNumber(row.batchSize)}</td>
      <td title="${escapeAttr(row.lastSeen)}">${escapeHtml(formatDate(row.lastSeen))}</td>
    </tr>
  ` : `
    <tr class="clickable-row" data-host="${escapeAttr(row.computer)}" data-time="${escapeAttr(row.lastSeen)}">
      <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "(empty)")}</td>
      <td><span class="status-badge status-${escapeAttr(row.statusLevel)}">${escapeHtml(row.statusLabel)}</span></td>
      <td title="${escapeAttr(row.lastChunk)}">${escapeHtml(row.lastChunk || "-")}</td>
      <td class="numeric">${formatNumber(row.statusCode)}</td>
      <td class="numeric">${formatNumber(row.batchSize)}</td>
      <td class="numeric">${formatBytes(row.spoolDepthBytes)}</td>
      <td class="numeric">${formatMs(row.plannedJitterMs)}</td>
      <td class="numeric">${formatMs(row.sendDurationMs)}</td>
      <td class="numeric">${formatNumber(row.pendingFileCount)}</td>
      <td title="${escapeAttr(row.lastSeen)}">${escapeHtml(formatDate(row.lastSeen))}</td>
    </tr>
  `).join("");

  container.innerHTML = ingestEvidence ? `
    <table><thead><tr><th>Host</th><th>Latest state</th><th>Latest chunk ID</th><th class="numeric">Chunks</th><th class="numeric">Events</th><th class="numeric">Latest batch</th><th>Last seen</th></tr></thead><tbody>${body}</tbody></table>
  ` : `
    <table>
      <thead>
        <tr>
          <th>Host</th>
          <th>Status</th>
          <th>Last chunk</th>
          <th class="numeric">HTTP</th>
          <th class="numeric">Batch</th>
          <th class="numeric">Spool</th>
          <th class="numeric">Jitter</th>
          <th class="numeric">Send</th>
          <th class="numeric">Pending</th>
          <th>Last seen</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;

  container.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => openDetailForChunk(row.dataset.host, row.dataset.time));
  });
}

function openDetailForChunk(host, time) {
  if (!host || !time) return;
  const url = new URL("./detail.html", window.location.href);
  url.searchParams.set("host", host);
  url.searchParams.set("time", minuteBucket(time));
  url.searchParams.set("bucket", "minute");
  url.searchParams.set("view", "both");
  window.location.href = url.toString();
}

async function loadLossAlertThresholds() {
  const result = await api("/api/dashboard/admin/log-loss/thresholds");
  const policy = result.policy || {};
  el("thresholdLossRatio").value = policy.lossRatioPercent;
  el("thresholdBacklogEvents").value = policy.backlogEvents;
  el("thresholdDisconnectMinutes").value = policy.disconnectMinutes;
  el("thresholdInterruptionMinutes").value = policy.interruptionMinutes;
  if (el("lossAlertThreshold")?.dataset.override !== "true") {
    el("lossAlertThreshold").value = policy.lossRatioPercent;
  }
  if (el("lossInterruptionThreshold")?.dataset.override !== "true") {
    el("lossInterruptionThreshold").value = policy.interruptionMinutes;
  }
  const updated = policy.updatedAt ? formatDate(policy.updatedAt) : "system default";
  el("lossThresholdStatus").textContent = `Policy v${formatNumber(policy.version)} | source ${result.source} | updated ${updated} | ${policy.updatedBy || "-"}`;
  return policy;
}

async function saveLossAlertThresholds() {
  const button = el("lossThresholdSave");
  button.disabled = true;
  el("lossThresholdStatus").textContent = "Validating and saving the threshold policy...";
  try {
    const result = await api("/api/dashboard/admin/log-loss/thresholds", {
      method: "PUT",
      body: {
        lossRatioPercent: Number(el("thresholdLossRatio").value),
        backlogEvents: Number(el("thresholdBacklogEvents").value),
        disconnectMinutes: Number(el("thresholdDisconnectMinutes").value),
        interruptionMinutes: Number(el("thresholdInterruptionMinutes").value),
        updatedBy: "dashboard-admin",
      },
    });
    el("lossAlertThreshold").dataset.override = "false";
    el("lossInterruptionThreshold").dataset.override = "false";
    await loadLossAlertThresholds();
    el("lossThresholdStatus").textContent = `Policy v${formatNumber(result.policy.version)} saved at ${formatDate(result.policy.updatedAt)}.`;
    await Promise.all([loadLogLoss(), loadFleetLogLoss()]);
  } catch (error) {
    el("lossThresholdStatus").textContent = error.message || "Unable to save the threshold policy";
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function loadFleetLogLoss() {
  const result = await api(`/api/dashboard/admin/log-loss/fleet${query({
    riskState: el("fleetLossRiskState")?.value || "",
    top: el("fleetLossTop")?.value || "10",
  })}`);
  const summary = result.summary || {};
  el("fleetLossHosts").textContent = formatNumber(summary.hosts);
  el("fleetLossAffectedHosts").textContent = formatNumber(summary.affectedHosts);
  el("fleetLossRatio").textContent = summary.lossRatioPercent === null || summary.lossRatioPercent === undefined
    ? "-" : `${Number(summary.lossRatioPercent).toFixed(4)}%`;
  el("fleetLossDropped").textContent = formatNumber(summary.droppedEvents);
  el("fleetLossAtRisk").textContent = formatNumber(summary.atRiskEvents);
  el("fleetLossMeasured").textContent = `${formatNumber(summary.measuredHosts)}/${formatNumber(summary.hosts)}`;
  el("fleetLossPending").textContent = formatNumber(summary.pendingEvents);
  el("fleetLossDisconnected").textContent = formatNumber(summary.disconnectedHosts);
  el("fleetLossInterrupted").textContent = formatNumber(summary.interruptedHosts);
  el("fleetLossBacklog").textContent = formatNumber(summary.backlogHosts);
  el("fleetLossCoverage").textContent = summary.hosts
    ? `Measurement coverage: ${formatNumber(summary.measuredHosts)}/${formatNumber(summary.hosts)} hosts (${Number(summary.measurementCoveragePercent || 0).toFixed(2)}%). ${result.basis}`
    : "No agents or endpoints are within the selected scope.";
  renderFleetRiskDistribution(result.riskDistribution || []);
  el("fleetLossFocusMeta").textContent = `${formatNumber(result.focusTotal)} hosts match the selected priority state; showing up to ${formatNumber(el("fleetLossTop")?.value || 10)} hosts.`;
  renderFleetLossTopHosts(result.topHosts || []);
}

function renderFleetRiskDistribution(rows) {
  const container = el("fleetLossRiskDistribution");
  if (!container) return;
  container.innerHTML = rows.map((row) => `
    <article class="host-level-card">
      <span>${escapeHtml(row.label || row.state || "-")}</span>
      <strong>${formatNumber(row.hosts)}</strong>
    </article>
  `).join("");
}

function fleetLossStatusClass(state) {
  if (state === "normal") return "ok";
  if (state === "unknown") return "unknown";
  if (state === "backlog") return "bursty";
  if (state === "at_risk") return "delayed";
  return "failed";
}

function renderFleetLossTopHosts(rows) {
  const container = el("fleetLossTopHosts");
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No hosts match the state currently monitored by the administrator</div>';
    return;
  }
  const measured = (value, available) => available ? formatNumber(value) : "-";
  const body = rows.map((row) => {
    const available = row.coverage === "measured";
    const ratio = row.lossRatioPercent === null || row.lossRatioPercent === undefined
      ? "-" : `${Number(row.lossRatioPercent).toFixed(4)}%`;
    return `<tr>
      <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "-")}</td>
      <td title="${escapeAttr(row.agentId)}">${escapeHtml(row.agentId || "-")}</td>
      <td><span class="status-badge status-${escapeAttr(fleetLossStatusClass(row.riskState))}" title="${escapeAttr((row.riskFlags || []).join(", "))}">${escapeHtml(row.riskStateLabel || "-")}</span></td>
      <td>${escapeHtml(row.causeLabel || "-")}</td>
      <td class="numeric">${measured(row.droppedEventCount, available)}</td>
      <td class="numeric">${measured(row.atRiskEventCount, available)}</td>
      <td class="numeric">${measured(row.pendingEventCount, available)}</td>
      <td class="numeric">${ratio}</td>
      <td>${escapeHtml(available ? "Direct measurement" : "Counter unavailable")}</td>
      <td title="${escapeAttr(row.lastSeen)}">${escapeHtml(formatDate(row.lastSeen))}</td>
    </tr>`;
  }).join("");
  container.innerHTML = `
    <table>
      <thead><tr><th>Endpoint</th><th>Agent ID</th><th>Primary risk</th><th>Cause</th><th class="numeric">Dropped</th><th class="numeric">At risk</th><th class="numeric">Pending</th><th class="numeric">Loss ratio</th><th>Coverage</th><th>Latest evidence</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function currentLossFilters() {
  return {
    agent: el("lossAgentFilter")?.value?.trim() || "",
    channel: el("lossChannelFilter")?.value?.trim() || "",
    eventId: el("lossEventIdFilter")?.value?.trim() || "",
    machine: el("lossMachineFilter")?.value?.trim() || "",
    riskState: el("lossRiskStateFilter")?.value || "",
  };
}

async function loadLogLoss() {
  const filters = currentLossFilters();
  const thresholdMinutes = el("lossInterruptionThreshold")?.dataset.override === "true"
    ? el("lossInterruptionThreshold").value : "";
  const thresholdPercent = el("lossAlertThreshold")?.dataset.override === "true"
    ? el("lossAlertThreshold").value : "";
  const [summary, hosts, interruptions, retryBacklog, lossAlerts] = await Promise.all([
    api(`/api/dashboard/log-loss/summary${query(filters)}`),
    api(`/api/dashboard/log-loss/hosts${query({ ...filters, limit: 500 })}`),
    api(`/api/dashboard/log-loss/interruptions${query({ agent: filters.agent, thresholdMinutes, limit: 500 })}`),
    api(`/api/dashboard/log-loss/retry-backlog${query({ agent: filters.agent, limit: 500 })}`),
    api(`/api/dashboard/log-loss/alerts${query({ agent: filters.agent, thresholdPercent, limit: 500 })}`),
  ]);

  el("lossRatio").textContent = summary.lossRatioPercent === null || summary.lossRatioPercent === undefined
    ? "-" : `${Number(summary.lossRatioPercent).toFixed(4)}%`;
  el("lossCollected").textContent = formatNumber(summary.collectedEvents);
  el("lossSent").textContent = formatNumber(summary.sentEvents);
  el("lossPending").textContent = formatNumber(summary.pendingEvents);
  el("lossDropped").textContent = formatNumber(summary.droppedEvents);
  el("logLossCoverage").textContent = summary.measuredHosts
    ? `Measured ${formatNumber(summary.measuredHosts)}/${formatNumber(summary.hosts)} hosts. Windows-generated events remain unavailable until a reliable source counter is provided.`
    : "No endpoint reported UC-14 counters during the selected time range.";
  renderLossCauseSummary(el("lossCauseSummary"), summary.causeCounts || []);
  renderLossAlerts(lossAlerts);
  renderInterruptionHistory(interruptions);
  renderRetryBacklog(retryBacklog);
  renderLogLossTable(el("logLossHostsTable"), hosts.items || []);
}

async function exportLogLossReport() {
  const button = el("lossExport");
  const status = el("lossExportStatus");
  if (!button || button.disabled) return;
  button.disabled = true;
  status.textContent = "Generating a CSV file from the filtered evidence...";
  try {
    const response = await fetch(`${API_BASE}/api/dashboard/log-loss/export${query({
      ...currentLossFilters(),
      format: "csv",
    })}`, { cache: "no-store", headers: state.auth.token ? { authorization: `Bearer ${state.auth.token}` } : {} });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${message.slice(0, 160)}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || "hosteye-log-loss.csv";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Exported ${filename}`;
  } catch (error) {
    status.textContent = error.message || "Unable to export the report";
    throw error;
  } finally {
    button.disabled = false;
  }
}

function renderLossCauseSummary(container, causes) {
  if (!container) return;
  const active = causes.filter((item) => item.code !== "no_active_loss");
  container.innerHTML = active.length
    ? active.map((item) => `<article class="kpi"><span>${escapeHtml(item.label)}</span><strong>${formatNumber(item.count)}</strong></article>`).join("")
    : '<div class="empty-state">No log-loss cause was found within the selected scope</div>';
}

function renderLossAlerts(result) {
  const summary = result.summary || {};
  el("lossAlertTotal").textContent = formatNumber(summary.total);
  el("lossAlertCritical").textContent = formatNumber(summary.critical);
  el("lossAlertHigh").textContent = formatNumber(summary.high);
  el("lossAlertHosts").textContent = formatNumber(summary.affectedHosts);
  const thresholds = result.thresholds || {};
  el("lossAlertCoverage").textContent = `${result.basis || "Alerts are based on operational evidence."} Loss: ${Number(result.thresholdPercent || 0).toFixed(2)}%; backlog: ${formatNumber(thresholds.backlogEvents)}; disconnected: ${formatNumber(thresholds.disconnectMinutes)} minutes; interruption: ${formatNumber(thresholds.interruptionMinutes)} minutes.`;
  const container = el("lossAlertTable");
  const rows = result.items || [];
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No active log-loss alerts are within the selected scope</div>';
    return;
  }
  const body = rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatDate(row.detectedAt))}</td>
      <td><span class="severity-badge severity-${escapeAttr(row.severity)}">${escapeHtml(String(row.severity || "unknown").toUpperCase())}</span></td>
      <td>${escapeHtml(row.ruleId || "-")}</td>
      <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "-")}</td>
      <td>${escapeHtml(row.title || "-")}</td>
      <td title="${escapeAttr(row.message)}">${escapeHtml(row.message || "-")}</td>
    </tr>
  `).join("");
  container.innerHTML = `
    <table>
      <thead><tr><th>Detected</th><th>Severity</th><th>Rule</th><th>Endpoint</th><th>Alert</th><th>Evidence</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderInterruptionHistory(result) {
  const summary = result.summary || {};
  el("lossInterruptionCount").textContent = formatNumber(summary.interruptions);
  el("lossInterruptionOngoing").textContent = formatNumber(summary.ongoing);
  el("lossInterruptionRecovered").textContent = formatNumber(summary.recovered);
  el("lossInterruptionHosts").textContent = formatNumber(summary.affectedHosts);
  el("lossInterruptionCoverage").textContent = result.coverageTruncated
    ? `The result reached the evidence limit; narrow the filters to retrieve the complete history. Threshold: ${formatNumber(result.thresholdMinutes)} minutes.`
    : `${result.basis || "Observed operational evidence."} Threshold: ${formatNumber(result.thresholdMinutes)} minutes.`;

  const container = el("lossInterruptionTable");
  const rows = result.items || [];
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No interruption exceeding the threshold was recorded within the selected scope</div>';
    return;
  }

  const body = rows.map((row) => `
    <tr>
      <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "(empty)")}</td>
      <td title="${escapeAttr(row.agentId)}">${escapeHtml(row.agentId || "-")}</td>
      <td>${escapeHtml(formatDate(row.startedAt))}</td>
      <td>${row.endedAt ? escapeHtml(formatDate(row.endedAt)) : "-"}</td>
      <td class="numeric">${escapeHtml(formatAge(row.durationSeconds))}</td>
      <td><span class="status-badge status-${row.status === "ongoing" ? "failed" : "ok"}">${escapeHtml(row.statusLabel)}</span></td>
      <td title="${escapeAttr(row.evidenceMessage)}">${escapeHtml((row.evidenceSources || []).join(", ") || "-")}</td>
    </tr>
  `).join("");

  container.innerHTML = `
    <table>
      <thead><tr><th>Endpoint</th><th>Agent ID</th><th>Started</th><th>Ended</th><th class="numeric">Duration</th><th>Recovery</th><th>Evidence</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderRetryBacklog(result) {
  const summary = result.summary || {};
  el("lossRetryHosts").textContent = formatNumber(summary.backlogHosts);
  el("lossRetryEvents").textContent = formatNumber(summary.pendingEvents);
  el("lossRetryBytes").textContent = formatBytes(summary.pendingBytes);
  el("lossRetryResending").textContent = formatNumber(summary.resendingHosts);
  el("lossRetryWaiting").textContent = formatNumber(Number(summary.waitingHosts || 0) + Number(summary.backpressureHosts || 0));
  el("lossRetryCoverage").textContent = `${result.basis || "Direct counters from HostEyeShipper"} Measurement coverage: ${formatNumber(summary.measuredHosts)} hosts.`;

  const container = el("lossRetryTable");
  const rows = result.items || [];
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No logs are waiting for retry within the selected scope</div>';
    return;
  }

  const body = rows.map((row) => {
    const queue = Number(row.maxSpoolBytes || 0) > 0
      ? `${formatBytes(row.queueUsedBytes)} / ${formatBytes(row.maxSpoolBytes)}`
      : formatBytes(row.queueUsedBytes);
    return `
      <tr>
        <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "(empty)")}</td>
        <td><span class="status-badge status-${escapeAttr(row.retryStatusLevel)}">${escapeHtml(row.retryStatusLabel)}</span></td>
        <td class="numeric">${formatNumber(row.pendingEventCount)}</td>
        <td class="numeric">${escapeHtml(queue)}</td>
        <td class="numeric">${formatNumber(row.retryCount)}</td>
        <td class="numeric">${Number(row.retryAfterSeconds || 0) > 0 ? `${formatNumber(row.retryAfterSeconds)}s` : "-"}</td>
        <td title="${escapeAttr(row.retryObservedAt)}">${escapeHtml(formatDate(row.retryObservedAt))}</td>
        <td title="${escapeAttr(row.retryEvidence)}">${escapeHtml(row.retryEvidence || "-")}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <table>
      <thead><tr><th>Endpoint</th><th>Retry status</th><th class="numeric">Pending logs</th><th class="numeric">Spool / limit</th><th class="numeric">Retry count</th><th class="numeric">Retry after</th><th>Updated</th><th>Evidence</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderLogLossTable(container, rows) {
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No endpoints are within the selected scope</div>';
    return;
  }

  const measured = (value, available) => available ? formatNumber(value) : "-";
  const body = rows.map((row) => {
    const available = row.coverage === "measured";
    const queue = available && Number(row.maxSpoolBytes || 0) > 0
      ? `${formatBytes(row.queueUsedBytes)} / ${formatBytes(row.maxSpoolBytes)}`
      : "-";
    return `
      <tr>
        <td title="${escapeAttr(row.computer)}">${escapeHtml(row.computer || "(empty)")}</td>
        <td><button class="secondary-btn alert-view-btn loss-detail-button" type="button" data-machine="${escapeAttr(row.computer)}" data-agent="${escapeAttr(row.agentId)}">View details</button></td>
        <td><span class="status-badge status-${escapeAttr(row.statusLevel)}">${escapeHtml(row.statusLabel)}</span></td>
        <td><span class="status-badge status-${escapeAttr(row.riskState === "normal" ? "ok" : row.riskState === "unknown" ? "unknown" : row.riskState === "backlog" ? "bursty" : row.riskState === "at_risk" ? "delayed" : "failed")}" title="${escapeAttr((row.riskFlags || []).join(", "))}">${escapeHtml(row.riskStateLabel || "-")}</span></td>
        <td title="${escapeAttr(row.causeEvidence)}"><span class="status-badge status-${escapeAttr(row.causeLevel)}">${escapeHtml(row.causeLabel)}</span></td>
        <td title="${escapeAttr(row.causeEvidence)}">${escapeHtml(row.causeEvidence || "-")}</td>
        <td class="numeric" title="${escapeAttr(row.generatedMessage)}">-</td>
        <td class="numeric">${measured(row.collectedEventCount, available)}</td>
        <td class="numeric">${measured(row.sentEventCount, available)}</td>
        <td class="numeric">${measured(row.pendingEventCount, available)}</td>
        <td class="numeric">${measured(row.atRiskEventCount, available)}</td>
        <td class="numeric">${measured(row.droppedEventCount, available)}</td>
        <td class="numeric" title="${escapeAttr(row.ratioMessage)}">${row.lossRatioPercent === null || row.lossRatioPercent === undefined ? "-" : `${Number(row.lossRatioPercent).toFixed(4)}%`}</td>
        <td class="numeric">${formatNumber(row.serverReceivedEvents)}</td>
        <td class="numeric">${escapeHtml(queue)}</td>
        <td title="${escapeAttr(row.coverageMessage)}">${escapeHtml(row.coverage === "measured" ? "Direct measurement" : "Unsupported")}</td>
        <td title="${escapeAttr(row.lastSeen)}">${escapeHtml(formatDate(row.lastSeen))}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <table>
      <thead><tr>
        <th>Endpoint</th><th>Details</th><th>Status</th><th>Risk</th><th>Cause</th><th>Evidence</th>
        <th class="numeric">Generated</th><th class="numeric">Collected into spool</th>
        <th class="numeric">ACKed</th><th class="numeric">Pending</th>
        <th class="numeric">At risk</th><th class="numeric">Dropped</th><th class="numeric">Loss ratio</th>
        <th class="numeric">Gateway received</th><th class="numeric">Spool / limit</th>
        <th>Coverage</th><th>Last updated</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
  container.querySelectorAll(".loss-detail-button").forEach((button) => {
    button.addEventListener("click", () => openLossDetail(button.dataset.machine, button.dataset.agent));
  });
}

async function openLossDetail(machine, agent) {
  if (!machine) return;
  const requestId = ++state.lossDetailRequestId;
  el("lossDetailModal").hidden = false;
  document.body.classList.add("modal-open");
  el("lossDetailTitle").textContent = `Log-loss details - ${machine}`;
  el("lossDetailContent").innerHTML = '<div class="empty-state">Loading endpoint evidence...</div>';
  try {
    const data = await api(`/api/dashboard/log-loss/host-detail${query({
      machine,
      agent,
      thresholdMinutes: el("lossInterruptionThreshold")?.dataset.override === "true" ? el("lossInterruptionThreshold").value : "",
    })}`);
    if (requestId !== state.lossDetailRequestId) return;
    renderLossDetail(data);
  } catch (error) {
    if (requestId !== state.lossDetailRequestId) return;
    el("lossDetailContent").innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Unable to load log-loss details")}</div>`;
  }
}

function closeLossDetail() {
  state.lossDetailRequestId += 1;
  el("lossDetailModal").hidden = true;
  document.body.classList.remove("modal-open");
}

function renderLossDetail(data) {
  const host = data.host || {};
  const loss = data.loss || {};
  const period = data.affectedPeriod || {};
  const recovery = data.recovery || {};
  const available = loss.coverage === "measured";
  const value = (number) => available && number !== null && number !== undefined ? formatNumber(number) : "-";
  const ratio = loss.lossRatioPercent === null || loss.lossRatioPercent === undefined ? "-" : `${Number(loss.lossRatioPercent).toFixed(4)}%`;
  const fields = [
    ["Endpoint", host.computer || "-"],
    ["Agent ID", host.agentId || "-"],
    ["Host ID", host.hostId || "-"],
    ["Risk status", host.riskStateLabel || "-"],
    ["Cause", host.causeLabel || "-"],
    ["Recovery status", recovery.label || "-"],
    ["Impact started", period.startedAt ? formatDate(period.startedAt) : "-"],
    ["Impact ended", period.endedAt ? formatDate(period.endedAt) : (recovery.status === "ongoing" ? "Ongoing" : "-")],
  ].map(([label, fieldValue]) => `<div class="alert-detail-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(fieldValue)}</strong></div>`).join("");
  const counters = [
    ["Collected into spool", value(loss.collectedEventCount)],
    ["ACKed", value(loss.sentEventCount)],
    ["Pending", value(loss.pendingEventCount)],
    ["At risk", value(loss.atRiskEventCount)],
    ["Dropped by quota", value(loss.recordedDroppedEventCount)],
    ["Measured loss ratio", ratio],
    ["Interruption count", formatNumber(period.interruptionCount || 0)],
    ["Total impact duration", period.interruptionCount ? formatAge(period.totalDurationSeconds || 0) : "-"],
  ].map(([label, fieldValue]) => `<div class="alert-detail-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(fieldValue)}</strong></div>`).join("");
  const affectedKeys = new Set((data.affectedSources || []).map((source) => `${source.channel}\u001f${source.eventId}`));
  const sourceRows = (data.sourceBreakdown || []).map((source) => {
    const key = `${source.channel}\u001f${source.eventId}`;
    const sourceRatio = source.lossRatioPercent === null || source.lossRatioPercent === undefined ? "-" : `${Number(source.lossRatioPercent).toFixed(4)}%`;
    return `<tr>
      <td>${escapeHtml(source.channel || "-")}</td><td>${escapeHtml(source.eventId || "-")}</td>
      <td>${affectedKeys.has(key) ? '<span class="status-badge status-failed">Log loss detected</span>' : '<span class="status-badge status-ok">No loss recorded</span>'}</td>
      <td class="numeric">${formatNumber(source.collectedEventCount)}</td>
      <td class="numeric">${formatNumber(source.droppedEventCount)}</td>
      <td class="numeric">${escapeHtml(sourceRatio)}</td>
    </tr>`;
  }).join("");
  const interruptionRows = (data.interruptions || []).map((entry) => `<tr>
    <td>${escapeHtml(formatDate(entry.startedAt))}</td>
    <td>${entry.endedAt ? escapeHtml(formatDate(entry.endedAt)) : "-"}</td>
    <td class="numeric">${escapeHtml(formatAge(entry.durationSeconds))}</td>
    <td><span class="status-badge status-${entry.status === "recovered" ? "ok" : "failed"}">${escapeHtml(entry.status === "recovered" ? "Recovered" : "Interrupted")}</span></td>
    <td>${escapeHtml((entry.evidenceSources || []).join(", ") || "-")}</td>
  </tr>`).join("");

  el("lossDetailContent").innerHTML = `
    <div class="alert-detail-summary">${fields}</div>
    <div class="alert-detail-summary">${counters}</div>
    <p class="alert-detail-message">${escapeHtml(loss.message || host.coverageMessage || "Detailed evidence is unavailable")}</p>
    <section class="loss-detail-section">
      <h4>Related channels and Event IDs</h4>
      <p class="metric-note">Source coverage: ${escapeHtml(data.sourceCoverage || "unavailable")}. Log loss is marked only when the Shipper reports per-source dropped counters.</p>
      <div class="table-shell">${sourceRows ? `<table><thead><tr><th>Channel</th><th>Event ID</th><th>Status</th><th class="numeric">Collected into spool</th><th class="numeric">Dropped</th><th class="numeric">Ratio</th></tr></thead><tbody>${sourceRows}</tbody></table>` : '<div class="empty-state">The endpoint has not reported channel/Event ID counters</div>'}</div>
    </section>
    <section class="loss-detail-section">
      <h4>Affected time ranges</h4>
      <p class="metric-note">${escapeHtml(period.basis || "Only observed evidence is displayed.")}</p>
      <div class="table-shell">${interruptionRows ? `<table><thead><tr><th>Started</th><th>Ended</th><th class="numeric">Duration</th><th>Recovery</th><th>Evidence</th></tr></thead><tbody>${interruptionRows}</tbody></table>` : '<div class="empty-state">No interruption is within the selected scope</div>'}</div>
    </section>
  `;
}

async function loadEnrollment() {
  const data = await api("/api/dashboard/registrations/summary");
  state.enrollment.items = data.items || [];
  el("enrollmentDeviceCount").textContent = formatNumber(data.totals?.devices || 0);
  el("enrollmentPendingCount").textContent = formatNumber(data.totals?.pending || 0);
  el("enrollmentActiveCount").textContent = formatNumber(data.totals?.active || 0);
  el("enrollmentRevokedCount").textContent = formatNumber(data.totals?.revoked || 0);
  el("enrollmentServiceStatus").textContent = data.status === "ok" ? `online | ${formatNumber(data.latencyMs)} ms` : (data.message || "offline");
  renderEnrollmentDevices(data.items || []);
  const canWrite = hasPermission("enrollment:write");
  el("enrollmentTokenForm")?.querySelectorAll("input,button").forEach((node) => { node.disabled = !canWrite; });
  if (!canWrite) el("enrollmentCreateStatus").textContent = "Read-only permission";
}

function renderEnrollmentDevices(rows) {
  const container = el("enrollmentDevicesTable");
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">No endpoint has completed C_i enrollment.</div>';
    return;
  }
  container.innerHTML = `<table><thead><tr><th>C_i</th><th>Host</th><th>Agent</th><th>Owner</th><th>Group</th><th>Policy</th><th>Certificate</th><th>Expires</th><th>Status</th><th>Last update</th><th>Action</th></tr></thead><tbody>${rows.map((row) => `
    <tr>
      <td title="${escapeAttr(row.ciId)}"><code>${escapeHtml(row.ciId || "-")}</code></td>
      <td>${escapeHtml(row.actualHostname || row.expectedHostname || "-")}</td>
      <td title="${escapeAttr(row.agentId)}">${escapeHtml(row.agentId || "-")}</td>
      <td>${escapeHtml(row.owner || "-")}</td>
      <td>${escapeHtml(row.groupId || "default")}</td>
      <td>${escapeHtml(row.policyId || "-")}</td>
      <td title="${escapeAttr(row.certificateThumbprint)}"><code>${escapeHtml((row.certificateThumbprint || "-").slice(0, 16))}</code></td>
      <td>${row.certificateNotAfter ? escapeHtml(formatDate(row.certificateNotAfter)) : "-"}</td>
      <td><span class="status-pill ${row.status === "Active" ? "ok" : row.status === "Pending" ? "delayed" : "failed"}">${escapeHtml(row.status || "Unknown")}</span></td>
      <td>${row.updatedAt ? escapeHtml(formatDate(row.updatedAt)) : "-"}</td>
      <td>${row.status === "Active" && hasPermission("enrollment:write") ? `<button class="secondary-btn" type="button" data-enrollment-action="revoke" data-device-id="${escapeAttr(row.deviceRecordId)}">Revoke</button>` : "-"}</td>
    </tr>`).join("")}</tbody></table>`;
}

async function createEnrollmentToken() {
  if (!hasPermission("enrollment:write")) throw new Error("enrollment:write permission is required");
  const expectedHostname = el("enrollmentHostname").value.trim();
  if (expectedHostname && !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(expectedHostname)) {
    throw new Error("Expected hostname must be the literal Windows computer name (for example BRUH), not $env:COMPUTERNAME");
  }
  el("enrollmentCreateStatus").textContent = "Generating...";
  const result = await api("/api/dashboard/admin/enrollment-tokens", {
    method: "POST",
    body: {
      expectedHostname,
      owner: el("enrollmentOwner").value.trim(),
      groupId: el("enrollmentGroup").value.trim() || "default",
      policyId: el("enrollmentPolicy").value.trim() || "policy-default-windows-baseline",
      ttlMinutes: Number(el("enrollmentTtl").value || 60),
    },
  });
  state.enrollment.lastToken = result;
  el("enrollmentTokenValue").textContent = result.token;
  el("enrollmentCiValue").textContent = result.ciId;
  el("enrollmentTokenExpiry").textContent = formatDate(result.expiresAt);
  el("enrollmentInstallCommand").textContent = `HostEye_Endpoint_Installer.exe /ENROLLMENTTOKEN="${result.token}"`;
  el("enrollmentTokenResult").hidden = false;
  el("enrollmentCreateStatus").textContent = "Token generated";
  await loadEnrollment();
}

async function revokeEnrolledDevice(button) {
  if (!hasPermission("enrollment:write")) throw new Error("enrollment:write permission is required");
  button.disabled = true;
  try {
    await api(`/api/dashboard/admin/enrolled-devices/${encodeURIComponent(button.dataset.deviceId)}/revoke`, {
      method: "POST", body: { reason: "Revoked from HostEye Dashboard" },
    });
    await loadEnrollment();
  } finally { button.disabled = false; }
}

function showEnrollmentError(error) {
  const message = String(error?.message || "Enrollment operation failed");
  if (el("enrollmentCreateStatus")) el("enrollmentCreateStatus").textContent = message;
  if (el("enrollmentServiceStatus")) el("enrollmentServiceStatus").textContent = "error";
}

async function loadDynamicConfig() {
  try {
    const [summary, policies, agents, configStatus, audit, catalog] = await Promise.all([
      api("/api/dashboard/dynamic-config/summary"),
      api("/api/dashboard/dynamic-config/policies"),
      api("/api/dashboard/dynamic-config/agents"),
      api("/api/dashboard/dynamic-config/config-status"),
      api("/api/dashboard/dynamic-config/audit"),
      api("/api/dashboard/dynamic-config/catalog"),
    ]);

    const totals = summary.totals || {};
    el("dynamicPolicyCount").textContent = formatNumber(totals.policies);
    el("dynamicActivePolicyCount").textContent = formatNumber(totals.activePolicies);
    el("dynamicAgentCount").textContent = formatNumber(totals.agents);
    el("dynamicGroupCount").textContent = formatNumber(totals.groups);
    el("dynamicConfigStatus").textContent = summary.status === "ok" ? "control plane online" : (summary.message || "control plane offline");

    renderDynamicLogCatalog(
      catalog.items || [],
      catalog.defaults || [],
      catalog.fields || [],
      catalog.fieldDefaults || [],
    );
    const policyRows = policies.items || summary.policies || [];
    const agentRows = agents.items || summary.agents || [];
    const groupRows = summary.groups || [];
    renderDynamicPolicies(policyRows);
    renderDynamicAgents(configStatus.items || []);
    renderDynamicGroups(groupRows);
    renderDynamicAudit(audit.items || []);
    renderDynamicAssignmentOptions(policyRows, agentRows, groupRows);
  } catch (error) {
    el("dynamicPolicyCount").textContent = "-";
    el("dynamicActivePolicyCount").textContent = "-";
    el("dynamicAgentCount").textContent = "-";
    el("dynamicGroupCount").textContent = "-";
    el("dynamicConfigStatus").textContent = error.message || "control plane offline";
    el("dynamicLogTypeOptions").innerHTML = `<div class="empty-state">Dynamic Config service is offline</div>`;
    el("dynamicFieldOptions").innerHTML = `<div class="empty-state">Dynamic Config service is offline</div>`;
    ["dynamicPoliciesTable", "dynamicAgentsTable", "dynamicGroupsTable", "dynamicAuditTable"].forEach((id) => {
      el(id).innerHTML = `<div class="empty-state">Dynamic Config service is offline</div>`;
    });
    el("dynamicAssignmentPolicy").innerHTML = '<option value="">Control plane offline</option>';
    el("dynamicAssignmentSubmit").disabled = true;
    el("dynamicAssignmentStatus").textContent = "Assignment unavailable while the control plane is offline";
  }
}


function renderDynamicLogCatalog(items, defaults, fields, fieldDefaults) {
  const container = el("dynamicLogTypeOptions");
  if (!items.length) {
    container.innerHTML = `<div class="empty-state">No supported log types reported</div>`;
    return;
  }
  const selected = new Set(defaults || []);
  container.innerHTML = items.map((item) => `
    <label class="dynamic-log-option">
      <input type="checkbox" name="dynamicLogType" value="${escapeAttr(item.id)}" ${selected.has(item.id) ? "checked" : ""}>
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || "")}</small></span>
    </label>
  `).join("");

  const fieldContainer = el("dynamicFieldOptions");
  const selectedFields = new Set(fieldDefaults || []);
  fieldContainer.innerHTML = fields.map((item) => `
    <label class="dynamic-field-option ${item.required ? "is-required" : ""}">
      <input type="checkbox" name="dynamicField" value="${escapeAttr(item.id)}"
        ${selectedFields.has(item.id) ? "checked" : ""} ${item.required ? "disabled" : ""}>
      <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || "")}</small></span>
      ${item.required ? '<b>Required</b>' : ""}
    </label>
  `).join("");
}

function dynamicDraftFormValues() {
  return {
    name: el("dynamicPolicyName")?.value.trim() || "",
    logTypes: Array.from(document.querySelectorAll('input[name="dynamicLogType"]:checked'))
      .map((input) => input.value),
    selectedFields: Array.from(document.querySelectorAll('input[name="dynamicField"]:checked'))
      .map((input) => input.value),
  };
}

function validateDynamicDraftValues(values) {
  if (!values.name) {
    el("dynamicDraftStatus").textContent = "Configuration name is required";
    el("dynamicPolicyName")?.focus();
    return false;
  }
  if (!values.logTypes.length) {
    el("dynamicDraftStatus").textContent = "Select at least one log type";
    return false;
  }
  if (!values.selectedFields.length) {
    el("dynamicDraftStatus").textContent = "Select at least one data field";
    return false;
  }
  return true;
}

function clearDynamicPreview() {
  const panel = el("dynamicPreviewPanel");
  const wasVisible = panel && !panel.hidden;
  state.dynamicPreviewRequestId++;
  if (panel) panel.hidden = true;
  if (wasVisible) el("dynamicDraftStatus").textContent = "Configuration changed; preview again";
}

async function previewDynamicLogDraft() {
  const values = dynamicDraftFormValues();
  if (!validateDynamicDraftValues(values)) return;

  const requestId = ++state.dynamicPreviewRequestId;
  const button = el("dynamicDraftPreview");
  button.disabled = true;
  el("dynamicDraftStatus").textContent = "Building read-only preview...";
  try {
    const preview = await api("/api/dashboard/dynamic-config/preview", {
      method: "POST",
      body: { ...values, draft: true, targetType: "default" },
    });
    if (requestId !== state.dynamicPreviewRequestId) return;
    renderDynamicConfigPreview(preview);
    el("dynamicDraftStatus").textContent = "Preview ready; no policy saved";
  } catch (error) {
    if (requestId !== state.dynamicPreviewRequestId) return;
    el("dynamicDraftStatus").textContent = error.message || "Preview could not be generated";
    throw error;
  } finally {
    if (requestId === state.dynamicPreviewRequestId) button.disabled = false;
  }
}

function renderDynamicConfigPreview(preview) {
  const summary = preview.summary || {};
  const fields = summary.selectedFields || [];
  const required = fields.filter((item) => item.required);
  const sensors = Object.entries(summary.sensors || {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.replace(/_enabled$/, "").replace(/_/g, " "));
  const rows = [
    ["Configuration", summary.name || "-"],
    ["State", summary.state || "disabled draft"],
    ["Log types", (summary.logTypes || []).map((item) => item.name).join(", ") || "-"],
    ["Windows channels", (summary.channels || []).join(", ") || "-"],
    ["Selected fields", fields.map((item) => `${item.name} -> ${item.field}`).join(", ") || "-"],
    ["Required fields", required.map((item) => item.name).join(", ") || "-"],
    ["Retained internally", (summary.retainedInternalFields || []).join(", ") || "-"],
    ["Enabled sensors", sensors.join(", ") || "none"],
  ];
  el("dynamicPreviewSummary").innerHTML = rows.map(([label, value]) => `
    <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");
  el("dynamicPreviewJson").textContent = JSON.stringify(preview.policy || {}, null, 2);
  el("dynamicPreviewState").textContent = preview.previewOnly ? "Preview only" : "Draft";
  el("dynamicPreviewPanel").hidden = false;
}

function renderDynamicAssignmentOptions(policies, agents, groups) {
  const previousPolicy = el("dynamicAssignmentPolicy")?.value || "";
  const drafts = policies.filter((policy) => policy.enabled === false && policy.rollout?.enabled === false);
  state.dynamicAssignmentData = { policies: drafts, agents, groups };

  el("dynamicAssignmentPolicy").innerHTML = drafts.length
    ? drafts.map((policy) => `
      <option value="${escapeAttr(policy.policy_id)}">${escapeHtml(policy.name || policy.policy_id)} (v${formatNumber(policy.version || 1)})</option>
    `).join("")
    : '<option value="">No disabled drafts available</option>';
  if (previousPolicy && drafts.some((policy) => policy.policy_id === previousPolicy)) {
    el("dynamicAssignmentPolicy").value = previousPolicy;
  }
  el("dynamicAssignmentSubmit").disabled = !drafts.length;

  const activePolicyIds = new Set(
    policies.filter((policy) => policy.enabled !== false && policy.rollout?.enabled !== false)
      .map((policy) => policy.policy_id),
  );
  const latestAck = agents
    .filter((agent) => activePolicyIds.has(agent.last_policy_id || agent.current_policy_id || agent.policy_id))
    .sort((left, right) => String(right.last_seen_at || right.last_seen || "")
      .localeCompare(String(left.last_seen_at || left.last_seen || "")))[0];
  if (latestAck) {
    const status = latestAck.last_ack_status || latestAck.status || "seen";
    const policyId = latestAck.last_policy_id || latestAck.current_policy_id || latestAck.policy_id || "-";
    const version = latestAck.last_version || latestAck.current_version || latestAck.policy_version || 0;
    const message = latestAck.last_ack_message ? ` | ${latestAck.last_ack_message}` : "";
    el("dynamicAssignmentStatus").textContent =
      `Latest ACK: ${latestAck.agent_id || "agent"} ${status} ${policyId} v${version}${message}`;
  } else if (!drafts.length) {
    el("dynamicAssignmentStatus").textContent = "No disabled drafts available for assignment";
  }
  renderDynamicAssignmentTargets();
}

function renderDynamicAssignmentTargets() {
  const type = el("dynamicAssignmentTargetType")?.value || "group";
  const target = el("dynamicAssignmentTarget");
  if (!target) return;

  if (type === "default") {
    target.innerHTML = '<option value="">All eligible endpoints</option>';
    target.disabled = true;
    return;
  }

  target.disabled = false;
  if (type === "agent") {
    const agents = [...state.dynamicAssignmentData.agents]
      .sort((left, right) => String(left.agent_id || "").localeCompare(String(right.agent_id || "")));
    target.innerHTML = agents.length
      ? agents.map((agent) => `
        <option value="${escapeAttr(agent.agent_id)}">${escapeHtml(agent.agent_id)} | ${escapeHtml(agent.host_id || "unknown host")} | ${escapeHtml(agent.group_id || "unknown group")}</option>
      `).join("")
      : '<option value="">No agents have checked in</option>';
    return;
  }

  const counts = new Map();
  for (const agent of state.dynamicAssignmentData.agents) {
    const groupId = agent.group_id || "";
    if (groupId) counts.set(groupId, (counts.get(groupId) || 0) + 1);
  }
  target.innerHTML = counts.size
    ? [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([groupId, count]) => `
      <option value="${escapeAttr(groupId)}">${escapeHtml(groupId)} (${formatNumber(count)} agents)</option>
    `).join("")
    : '<option value="">No endpoint groups available</option>';
}

async function assignDynamicConfig() {
  if (state.dynamicAssignmentInFlight) return;
  const policyId = el("dynamicAssignmentPolicy")?.value || "";
  const targetType = el("dynamicAssignmentTargetType")?.value || "";
  const targetValue = targetType === "default" ? "" : (el("dynamicAssignmentTarget")?.value || "");
  if (!policyId) {
    el("dynamicAssignmentStatus").textContent = "Select a disabled Dynamic Logs draft";
    return;
  }
  if (targetType !== "default" && !targetValue) {
    el("dynamicAssignmentStatus").textContent = `No ${targetType} is available for assignment`;
    return;
  }

  state.dynamicAssignmentInFlight = true;
  el("dynamicAssignmentSubmit").disabled = true;
  el("dynamicAssignmentStatus").textContent = "Assigning and enabling signed policy...";
  try {
    const result = await api("/api/dashboard/dynamic-config/assignments", {
      method: "POST",
      body: { policyId, targetType, targetValue },
    });
    await loadDynamicConfig();
    const target = formatPolicyTarget(result.target);
    el("dynamicAssignmentStatus").textContent =
      `Assigned ${result.policy?.name || policyId} to ${target}. Waiting for endpoint poll and ACK.`;
  } catch (error) {
    el("dynamicAssignmentStatus").textContent = error.message || "Configuration assignment failed";
    throw error;
  } finally {
    state.dynamicAssignmentInFlight = false;
    el("dynamicAssignmentSubmit").disabled = !state.dynamicAssignmentData.policies.length;
  }
}

async function saveDynamicLogDraft() {
  if (state.dynamicSaveInFlight) return;
  const values = dynamicDraftFormValues();
  if (!validateDynamicDraftValues(values)) return;

  state.dynamicSaveInFlight = true;
  el("dynamicDraftSave").disabled = true;
  el("dynamicDraftStatus").textContent = "Saving disabled draft...";
  try {
    const saved = await api("/api/dashboard/dynamic-config/policies", {
      method: "POST",
      body: { ...values, draft: true, targetType: "default" },
    });
    el("dynamicDraftStatus").textContent = `Draft ${saved.policy_id || values.name} saved`;
    clearDynamicPreview();
    el("dynamicLogForm").reset();
    await loadDynamicConfig();
  } catch (error) {
    el("dynamicDraftStatus").textContent = error.message || "Draft could not be saved";
    throw error;
  } finally {
    state.dynamicSaveInFlight = false;
    el("dynamicDraftSave").disabled = false;
  }
}

function renderDynamicPolicies(rows) {
  const normalized = rows.map((policy) => ({
    policyId: policy.policy_id || policy.id || "-",
    name: policy.name || policy.policy_id || "-",
    target: formatPolicyTarget(policy.target),
    version: policy.version || 0,
    enabled: policy.enabled === false ? "draft" : "enabled",
    rollout: policy.rollout?.enabled === false ? "off" : String(policy.rollout?.percent ?? 100) + "%",
    channels: countChannels(policy.config?.vector?.channels),
    fields: countChannels(policy.config?.vector?.selected_fields),
    updatedAt: policy.updated_at || policy.updatedAt || "",
  }));
  renderTable(el("dynamicPoliciesTable"), normalized, [
    ["Policy", "policyId"],
    ["Name", "name"],
    ["Target", "target"],
    ["Version", "version", "numeric"],
    ["State", "enabled"],
    ["Rollout", "rollout"],
    ["Channels", "channels", "numeric"],
    ["Fields", "fields", "numeric"],
    ["Updated", "updatedAt", "date"],
  ]);
}

function renderDynamicAgents(rows) {
  const normalized = rows.map((agent) => ({
    agentId: agent.agentId || "-",
    hostId: agent.hostId || "-",
    groupId: agent.groupId || "unknown",
    assigned: formatConfigVersion(agent.assignedPolicyId, agent.assignedVersion),
    state: formatConfigState(agent.state),
    current: formatConfigVersion(agent.reportedPolicyId, agent.reportedVersion),
    ack: agent.lastAckStatus || "not acknowledged",
    lastPoll: agent.lastPollAt || "",
    message: agent.lastAckMessage || "",
  }));
  renderTable(el("dynamicAgentsTable"), normalized, [
    ["Agent", "agentId"],
    ["Host", "hostId"],
    ["Group", "groupId"],
    ["Assigned config", "assigned"],
    ["Delivery / apply", "state"],
    ["Current config", "current"],
    ["Latest ACK", "ack"],
    ["Last poll", "lastPoll", "date"],
    ["ACK detail", "message"],
  ]);
}

function formatConfigVersion(policyId, version) {
  if (!policyId) return "none";
  return `${policyId} v${formatNumber(version || 0)}`;
}

function formatConfigState(state) {
  const labels = {
    applied: "Applied",
    rendered: "Rendered only",
    apply_failed: "Apply failed",
    sent_waiting_ack: "Sent; waiting for ACK",
    pending_agent_poll: "Waiting for Agent poll",
    no_active_policy: "No active policy",
  };
  return labels[state] || state || "Unknown";
}

function renderDynamicGroups(rows) {
  const normalized = rows.map((group) => ({
    group: group.key || group.group || group.group_id || "unknown",
    agents: group.count || group.agents || 0,
  }));
  renderTable(el("dynamicGroupsTable"), normalized, [
    ["Group", "group"],
    ["Agents", "agents", "numeric"],
  ]);
}

function renderDynamicAudit(rows) {
  const normalized = rows.slice(0, 80).map((entry) => ({
    time: entry.timestamp || entry.time || entry.created_at || "",
    actor: entry.actor || entry.admin || entry.agent_id || "-",
    action: entry.action || entry.event || entry.type || "-",
    target: entry.target || entry.policy_id || entry.agent_id || "-",
    detail: entry.message || entry.detail || compactJson(entry),
  }));
  renderTable(el("dynamicAuditTable"), normalized, [
    ["Time", "time", "date"],
    ["Actor", "actor"],
    ["Action", "action"],
    ["Target", "target"],
    ["Detail", "detail"],
  ]);
}

function countChannels(channels) {
  if (Array.isArray(channels)) return channels.length;
  if (typeof channels === "string") return channels.split(/[\s,]+/).filter(Boolean).length;
  return 0;
}

function formatPolicyTarget(target) {
  if (!target) return "default";
  if (typeof target === "string") return target;
  if (target.type === "agent") return "agent:" + (target.agent_id || "");
  if (target.type === "group") return "group:" + (target.group_id || "");
  return target.type || "default";
}

function compactJson(value) {
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return String(value || "-");
  }
}

async function loadHeatmap() {
  const bucket = selectedHeatmapBucket();
  const data = await api(`/api/dashboard/hosts/heatmap${query({ top: 10, bucket })}`);
  renderHeatmap(el("hostHeatmap"), data.hosts || [], data.cells || [], bucket);
}

function renderTable(container, rows, columns) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data</div>`;
    return;
  }

  const head = columns.map(([label, , type]) => `<th class="${type === "numeric" ? "numeric" : ""}">${escapeHtml(label)}</th>`).join("");
  const body = rows.map((row) => {
    const cells = columns.map(([, key, type]) => {
      const raw = row[key] ?? "";
      const value = type === "date" ? formatDate(raw) : type === "numeric" ? formatNumber(raw) : type === "duration" ? formatMs(raw) : type === "bytes" ? formatBytes(raw) : String(raw);
      return `<td class="${type === "numeric" ? "numeric" : ""}" title="${escapeAttr(String(raw))}">${escapeHtml(value)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderBarChart(container, rows, labelKey, valueKey, color, formatter = formatNumber) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data</div>`;
    return;
  }

  const max = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  container.innerHTML = `
    <div class="bar-list">
      ${rows.map((row) => {
        const value = Number(row[valueKey] || 0);
        const width = Math.max(2, Math.round(value / max * 100));
        return `
          <div class="bar-row">
            <span title="${escapeAttr(row[labelKey])}">${escapeHtml(row[labelKey] || "(empty)")}</span>
            <div class="bar-track"><i style="width:${width}%;background:${color}"></i></div>
            <strong>${escapeHtml(formatter(value))}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderLineChart(container, rows, xKey, yKey, color) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data</div>`;
    return;
  }

  const width = 760;
  const height = 250;
  const pad = { left: 54, right: 18, top: 18, bottom: 34 };
  const values = rows.map((row) => Number(row[yKey] || 0));
  const max = Math.max(1, ...values);
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const x = (index) => pad.left + (rows.length === 1 ? 0 : index * plotW / (rows.length - 1));
  const y = (value) => pad.top + plotH - (value / max) * plotH;
  const points = rows.map((row, index) => `${x(index)},${y(Number(row[yKey] || 0))}`).join(" ");
  const area = `${pad.left},${pad.top + plotH} ${points} ${pad.left + plotW},${pad.top + plotH}`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const gy = pad.top + plotH - ratio * plotH;
    return `<line class="grid-line" x1="${pad.left}" y1="${gy}" x2="${pad.left + plotW}" y2="${gy}"></line><text class="axis-text" x="8" y="${gy + 4}">${formatNumber(Math.round(max * ratio))}</text>`;
  }).join("");
  const first = rows[0]?.[xKey] || "";
  const last = rows[rows.length - 1]?.[xKey] || "";

  container.innerHTML = `
    <svg class="line-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      ${grid}
      <polygon class="series-area" points="${area}" style="fill:${hexToAlpha(color, 0.16)}"></polygon>
      <polyline class="series-line" points="${points}" style="stroke:${color}"></polyline>
      <text class="axis-text" x="${pad.left}" y="${height - 8}">${escapeHtml(shortDate(first))}</text>
      <text class="axis-text" x="${width - 120}" y="${height - 8}">${escapeHtml(shortDate(last))}</text>
    </svg>
  `;
}

function renderPie(container, rows, labelKey, valueKey) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data</div>`;
    return;
  }

  const total = rows.reduce((sum, row) => sum + Number(row[valueKey] || 0), 0) || 1;
  let start = 0;
  const slices = rows.map((row, index) => {
    const value = Number(row[valueKey] || 0);
    const angle = value / total * Math.PI * 2;
    const path = describeArc(115, 115, 86, start, start + angle);
    start += angle;
    return `<path d="${path}" fill="${palette[index % palette.length]}"></path>`;
  }).join("");

  const legend = rows.map((row, index) => `
    <div class="legend-item">
      <span class="legend-swatch" style="background:${palette[index % palette.length]}"></span>
      <span title="${escapeAttr(row[labelKey])}">${escapeHtml(row[labelKey] || "(empty)")}</span>
      <strong>${formatNumber(row[valueKey])}</strong>
    </div>
  `).join("");

  container.innerHTML = `
    <svg class="pie-svg" viewBox="0 0 230 230">${slices}<circle cx="115" cy="115" r="44" fill="#171c23"></circle></svg>
    <div class="legend">${legend}</div>
  `;
}

function renderHeatmap(container, hosts, cells, bucket = selectedHeatmapBucket()) {
  if (!hosts.length) {
    container.innerHTML = `<div class="empty-state">No data</div>`;
    return;
  }

  const times = [...new Set(cells.map((cell) => cell.bucketTime))].sort();
  const cellMap = new Map(cells.map((cell) => [`${cell.computer}|${cell.bucketTime}`, cell]));
  const cols = Math.max(1, times.length);

  const rows = hosts.map((host) => {
    const blocks = times.map((time) => {
      const cell = cellMap.get(`${host.computer}|${time}`) || { events: 0, level: 0, bucketTime: time, computer: host.computer };
      return `<button class="heat-cell level-${cell.level || 0}" title="${escapeAttr(`${host.alias} ${host.computer} ${time}: ${cell.events || 0} events`)}" data-host="${escapeAttr(host.computer)}" data-time="${escapeAttr(time)}"></button>`;
    }).join("");
    return `<div class="host-label">${escapeHtml(host.alias)}</div>${blocks}`;
  }).join("");

  const mapping = hosts.map((host) => `<div><strong>${escapeHtml(host.alias)}</strong> - ${escapeHtml(host.computer)} (${formatNumber(host.totalEvents)})</div>`).join("");

  container.innerHTML = `
    <div class="heatmap-grid" style="--cols:${cols}">${rows}</div>
    <div class="host-map">${mapping}</div>
  `;

  container.querySelectorAll(".heat-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      const url = new URL("./detail.html", window.location.href);
      url.searchParams.set("host", cell.dataset.host);
      url.searchParams.set("time", cell.dataset.time);
      url.searchParams.set("bucket", bucket);
      window.location.href = url.toString();
    });
  });
}

async function api(path, options = {}) {
  const request = { cache: "no-store", method: options.method || "GET", headers: {} };
  if (options.auth !== false && state.auth.token) request.headers.authorization = `Bearer ${state.auth.token}`;
  if (options.body !== undefined) {
    request.headers["content-type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API_BASE}${path}`, request);
  if (response.status === 401 && options.auth !== false && state.auth.required) {
    state.auth.token = "";
    state.auth.user = null;
    localStorage.removeItem("hosteyeDashboardSession");
    renderCurrentUser();
    showLogin("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  }
  return response.json();
}

function query(extra = {}) {
  const params = new URLSearchParams();
  const { from, to } = selectedRange();
  params.set("from", from);
  params.set("to", to);

  const host = el("hostFilter")?.value;
  if (host) params.set("host", host);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  }

  return `?${params.toString()}`;
}

function selectedRange() {
  const now = new Date();
  const value = el("rangeSelect").value;
  if (value === "all") {
    return { from: new Date(0).toISOString(), to: now.toISOString() };
  }
  const hours = value === "1h" ? 1 : value === "6h" ? 6 : value === "24h" ? 24 : 24 * 30;
  return {
    from: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

function selectedBucket() {
  const value = el("rangeSelect").value;
  if (value === "1h") return "second";
  if (value === "all") return "day";
  if (value === "30d") return "minute";
  return "minute";
}

function selectedHeatmapBucket() {
  return el("heatmapBucket")?.value || "minute";
}

function setStatus(text, ok, detail = "") {
  el("statusText").textContent = text;
  el("rowCount").textContent = detail || "ClickHouse";
  el("statusDot").className = `status-dot ${ok ? "ok" : "bad"}`;
}

function renderErrorEverywhere(message) {
  document.querySelectorAll(".table-shell,.chart,.pie-wrap,.heatmap,.cell-detail").forEach((node) => {
    node.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  });
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatAge(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "-";
  const value = Number(seconds);
  if (!Number.isFinite(value)) return "-";
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function formatMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0s";
  if (number < 1000) return `${Math.round(number)}ms`;
  return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)}s`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = number;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return "-";
  const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function shortDate(value) {
  if (!value) return "";
  const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function minuteBucket(value) {
  if (!value) return "";
  const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16) + ":00";
  date.setSeconds(0, 0);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function describeArc(cx, cy, r, start, end) {
  const startPoint = polar(cx, cy, r, end);
  const endPoint = polar(cx, cy, r, start);
  const large = end - start <= Math.PI ? 0 : 1;
  return `M ${cx} ${cy} L ${startPoint.x} ${startPoint.y} A ${r} ${r} 0 ${large} 0 ${endPoint.x} ${endPoint.y} Z`;
}

function polar(cx, cy, r, angle) {
  return {
    x: cx + r * Math.cos(angle - Math.PI / 2),
    y: cy + r * Math.sin(angle - Math.PI / 2),
  };
}

function hexToAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

// Agent Chunk Errors

const ERROR_TYPE_LABELS = {
  checksum_invalid:     "Checksum error",
  event_count_mismatch: "Event count mismatch",
  missing_fields:       "Missing fields",
  schema_invalid:       "Invalid schema",
  conflict_409:         "Conflict (409)",
};

/**
 * Load the rejected-chunk summary for all Agents over the last 24 hours.
 * Calls the authenticated Dashboard API backed by ClickHouse evidence.
 */
async function loadAgentErrors() {
  try {
    const data = await api(`/api/dashboard/agent-errors/summary${query()}`);
    const agents = data.agents || [];

    // Calculate summary KPIs.
    let totalErrors = 0, totalChecksum = 0, totalEventCount = 0;
    agents.forEach((a) => {
      totalErrors     += Number(a.total)                || 0;
      totalChecksum   += Number(a.checksum_invalid)     || 0;
      totalEventCount += Number(a.event_count_mismatch) || 0;
    });

    const setKpi = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    setKpi("agentErrTotal",      formatNumber(totalErrors));
    setKpi("agentErrAgents",     agents.length);
    setKpi("agentErrChecksum",   formatNumber(totalChecksum));
    setKpi("agentErrEventCount", formatNumber(totalEventCount));
    el("agentErrorEvidenceNote").textContent = agents.length
      ? "Rejected chunks reported by HostEyeShipper and stored in ClickHouse."
      : "No rejected chunks were reported during the selected range; this is an observed empty state, not simulated data.";

    renderAgentErrorSummary(agents);
  } catch (e) {
    el("agentErrorEvidenceNote").textContent = "Rejected-chunk evidence could not be loaded.";
    const t = el("agentErrorSummaryTable");
    if (t) t.innerHTML = `<p class="table-empty">Failed to load data: ${escapeHtml(e.message)}</p>`;
  }
}

/**
 * Render an error summary for each Agent.
 * Clicking a row opens rejected chunk details on the right.
 */
function renderAgentErrorSummary(agents) {
  const container = el("agentErrorSummaryTable");
  if (!container) return;

  if (!agents.length) {
    container.innerHTML = "<p class=\"table-empty\">No errors were reported in the last 24 hours.</p>";
    return;
  }

  const headers = ["Agent ID", "Checksum", "Event Count", "Missing", "Schema", "Conflict", "Total"];
  const rows = agents.map((a) => {
    const total = Number(a.total) || 0;
    const badge = total > 0
      ? `<span class="err-badge">${total}</span>`
      : `<span class="ok-badge">0</span>`;
    return `<tr class="clickable-row" data-agent-id="${escapeAttr(a.agent_id)}" title="Click to view details">
      <td>${escapeHtml(a.agent_id)}</td>
      <td>${a.checksum_invalid     || 0}</td>
      <td>${a.event_count_mismatch || 0}</td>
      <td>${a.missing_fields       || 0}</td>
      <td>${a.schema_invalid       || 0}</td>
      <td>${a.conflict_409         || 0}</td>
      <td>${badge}</td>
    </tr>`;
  });

  container.innerHTML = `
    <table class="data-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;

  // Open the selected Agent's rejected chunk details.
  container.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => {
      const agentId = row.dataset.agentId;
      loadAgentErrorDetail(agentId);
      // Highlight the selected row.
      container.querySelectorAll(".clickable-row").forEach((r) => r.classList.remove("selected-row"));
      row.classList.add("selected-row");
    });
  });
}

/**
 * Load rejected chunk details for one Agent.
 * Calls the authenticated Dashboard API for one Agent.
 */
async function loadAgentErrorDetail(agentId) {
  const titleEl = el("agentErrorDetailTitle");
  const metaEl  = el("agentErrorDetailMeta");
  const tableEl = el("agentErrorDetailTable");
  if (!tableEl) return;

  if (titleEl) titleEl.textContent = `Details: ${agentId}`;
  if (metaEl)  metaEl.textContent  = "Loading...";
  tableEl.innerHTML = "";

  try {
    const data = await api(`/api/dashboard/agent-errors${query({ agent_id: agentId, limit: 200 })}`);
    const errors = data.errors || [];

    if (metaEl) metaEl.textContent = `${errors.length} rejected chunks`;

    if (!errors.length) {
      tableEl.innerHTML = "<p class=\"table-empty\">No rejected chunks were found.</p>";
      return;
    }

    const headers = ["Chunk ID", "Error type", "Quarantined at", "Reported at"];
    const rows = errors.map((e) => {
      const label = ERROR_TYPE_LABELS[e.error_type] || e.error_type;
      const badgeClass = e.error_type === "checksum_invalid" ? "err-badge"
                       : e.error_type === "conflict_409"    ? "warn-badge"
                       : "err-badge";
      return `<tr>
        <td><code>${escapeHtml(e.chunk_id)}</code></td>
        <td><span class="${badgeClass}">${escapeHtml(label)}</span></td>
        <td>${escapeHtml(e.quarantined_at)}</td>
        <td>${escapeHtml(e.reported_at)}</td>
      </tr>`;
    });

    tableEl.innerHTML = `
      <table class="data-table">
        <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>`;
  } catch (err) {
    if (metaEl) metaEl.textContent = "Failed to load details";
    tableEl.innerHTML = `<p class="table-empty">Error: ${escapeHtml(err.message)}</p>`;
  }
}
