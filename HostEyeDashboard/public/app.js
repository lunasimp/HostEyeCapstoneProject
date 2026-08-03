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
  dynamicSaveInFlight: false,
  dynamicPreviewRequestId: 0,
  dynamicAssignmentInFlight: false,
  dynamicAssignmentData: { policies: [], agents: [], groups: [] },
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
  "dynamic-config": { title: "Cau hinh dong", eyebrow: "[ CONTROL PLANE ]" },
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
    });
  });
  window.addEventListener("hashchange", () => showPage(pageFromHash(window.location.hash)));

  el("refreshBtn").addEventListener("click", loadDashboard);
  el("rangeSelect").addEventListener("change", loadDashboard);
  el("hostFilter").addEventListener("change", loadDashboard);
  el("heatmapBucket")?.addEventListener("change", loadHeatmap);
  el("hostLevelFilter")?.addEventListener("change", () => renderHostsScreen(state.hostSummary || { hosts: [], groups: [] }));
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
  el("alertDetailClose")?.addEventListener("click", closeAlertDetail);
  el("alertDetailModal")?.addEventListener("click", (event) => {
    if (event.target === el("alertDetailModal")) closeAlertDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el("alertDetailModal")?.hidden) closeAlertDetail();
  });
  document.querySelectorAll(".section-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.closest(".section-card");
      const isOpen = section.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(isOpen));
    });
  });
  showPage(pageFromHash(window.location.hash));
  loadDashboard();
});

function pageFromHash(hash) {
  const value = String(hash || "").replace(/^#/, "");
  return pages[value] ? value : "overview";
}

function showPage(page) {
  const selectedPage = pages[page] ? page : "overview";
  document.querySelectorAll(".page-view").forEach((view) => {
    view.hidden = view.dataset.page !== selectedPage;
  });
  document.querySelectorAll(".nav-item").forEach((link) => {
    link.classList.toggle("active", pageFromHash(link.getAttribute("href")) === selectedPage);
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

    await loadSummaryAndHosts();
    await Promise.all([
      loadHostsScreen(),
      loadOverview(),
      loadProcess(),
      loadNetworkDns(),
      loadRegistryFileAccess(),
      loadPowerShell(),
      loadJitter(),
      loadChunks(),
      loadDynamicConfig(),
      loadHeatmap(),
      loadAgentErrors(),
    ]);
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
    ["Loại sự kiện", "eventType"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("securityTimeline"), timeline.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
    ["Loại sự kiện", "eventType"],
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
    ["Tiến trình", "processPath"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("processRecentTable"), recent.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
    ["Loại", "eventType"],
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
    ["IP đích", "destinationIp"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("networkRecentTable"), network.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
    ["User", "userName"],
    ["Process GUID", "processGuid"],
    ["IP đích", "destinationIp"],
    ["Port", "destinationPort", "numeric"],
  ]);
  renderTable(el("topDomainsTable"), domains.items || [], [
    ["Domain", "domain"],
    ["volume", "volume", "numeric"],
  ]);
  renderTable(el("dnsRecentTable"), dns.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
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
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
    ["Loại", "eventType"],
    ["User", "userName"],
    ["Target", "targetObject"],
  ]);
  renderTable(el("fileRecentTable"), file.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
    ["Loại", "eventType"],
    ["User", "userName"],
    ["Target file", "targetFilename"],
  ]);
  renderTable(el("processAccessTable"), access.items || [], [
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
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
    ["Thời gian", "time", "date"],
    ["Máy trạm", "computer"],
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

  renderBarChart(el("jitterChart"), rows.slice(0, 12), "computer", "p95JitterMs", "#3b82f6", formatMs);
  renderTable(el("jitterHostsTable"), rows, [
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

  renderBarChart(el("chunkSpoolChart"), rows.slice(0, 12), "computer", "spoolDepthBytes", "#17b26a", formatBytes);
  renderChunkHostTable(el("chunkHostsTable"), rows);
}

function renderChunkHostTable(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No chunks</div>`;
    return;
  }

  const body = rows.map((row) => `
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

  container.innerHTML = `
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
  if (options.body !== undefined) {
    request.headers["content-type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API_BASE}${path}`, request);
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

// ── Agent Chunk Errors ──────────────────────────────────────────────────────

const ERROR_TYPE_LABELS = {
  checksum_invalid:     "Checksum lỗi",
  event_count_mismatch: "Event count lỗi",
  missing_fields:       "Thiếu fields",
  schema_invalid:       "Schema lỗi",
  conflict_409:         "Conflict (409)",
};

/**
 * Tải bảng tổng hợp lỗi chunk từ tất cả Agent trong 24h gần nhất.
 * Gọi GET /api/v1/control/agent/telemetry/errors/summary
 */
async function loadAgentErrors() {
  try {
    const data = await api("/api/v1/control/agent/telemetry/errors/summary");
    const agents = data.agents || [];

    // Tính KPI tổng hợp
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

    renderAgentErrorSummary(agents);
  } catch (e) {
    const t = el("agentErrorSummaryTable");
    if (t) t.innerHTML = `<p class="table-empty">Lỗi tải dữ liệu: ${escapeHtml(e.message)}</p>`;
  }
}

/**
 * Vẽ bảng tổng hợp lỗi theo từng Agent.
 * Click vào hàng → drill-down chi tiết chunk_id bên phải.
 */
function renderAgentErrorSummary(agents) {
  const container = el("agentErrorSummaryTable");
  if (!container) return;

  if (!agents.length) {
    container.innerHTML = "<p class=\"table-empty\">Không có lỗi nào trong 24h qua 🎉</p>";
    return;
  }

  const headers = ["Agent ID", "Checksum", "Event Count", "Missing", "Schema", "Conflict", "Tổng"];
  const rows = agents.map((a) => {
    const total = Number(a.total) || 0;
    const badge = total > 0
      ? `<span class="err-badge">${total}</span>`
      : `<span class="ok-badge">0</span>`;
    return `<tr class="clickable-row" data-agent-id="${escapeAttr(a.agent_id)}" title="Click để xem chi tiết">
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

  // Click handler → drill-down
  container.querySelectorAll(".clickable-row").forEach((row) => {
    row.addEventListener("click", () => {
      const agentId = row.dataset.agentId;
      loadAgentErrorDetail(agentId);
      // Highlight hàng được chọn
      container.querySelectorAll(".clickable-row").forEach((r) => r.classList.remove("selected-row"));
      row.classList.add("selected-row");
    });
  });
}

/**
 * Tải danh sách chi tiết chunk_id bị lỗi của 1 Agent cụ thể.
 * Gọi GET /api/v1/control/agent/telemetry/errors?agent_id=xxx
 */
async function loadAgentErrorDetail(agentId) {
  const titleEl = el("agentErrorDetailTitle");
  const metaEl  = el("agentErrorDetailMeta");
  const tableEl = el("agentErrorDetailTable");
  if (!tableEl) return;

  if (titleEl) titleEl.textContent = `Chi tiết: ${agentId}`;
  if (metaEl)  metaEl.textContent  = "Đang tải...";
  tableEl.innerHTML = "";

  try {
    const data = await api(`/api/v1/control/agent/telemetry/errors?agent_id=${encodeURIComponent(agentId)}`);
    const errors = data.errors || [];

    if (metaEl) metaEl.textContent = `${errors.length} chunk bị lỗi`;

    if (!errors.length) {
      tableEl.innerHTML = "<p class=\"table-empty\">Không có chunk lỗi nào</p>";
      return;
    }

    const headers = ["Chunk ID", "Loại lỗi", "Thời điểm lỗi", "Được ghi nhận lúc"];
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
    if (metaEl) metaEl.textContent = "Lỗi tải chi tiết";
    tableEl.innerHTML = `<p class="table-empty">Lỗi: ${escapeHtml(err.message)}</p>`;
  }
}
