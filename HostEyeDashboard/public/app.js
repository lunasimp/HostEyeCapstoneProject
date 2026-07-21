const API_BASE = window.HOSTEYE_API_BASE || "";
const palette = ["#ff8200", "#4c8dff", "#6dd17c", "#ff5364", "#b184ff", "#f7c948", "#59c3c3", "#f97090"];

const state = {
  hosts: [],
  loading: false,
};

const el = (id) => document.getElementById(id);

const pages = {
  overview: { title: "Overview", eyebrow: "[ SOC OVERVIEW ]" },
  hosts: { title: "Host Inventory", eyebrow: "[ ENDPOINTS ]" },
  process: { title: "Process Activity", eyebrow: "[ PROCESS TELEMETRY ]" },
  network: { title: "Network & DNS", eyebrow: "[ NETWORK TELEMETRY ]" },
  registry: { title: "Registry & File", eyebrow: "[ ENDPOINT CHANGES ]" },
  powershell: { title: "PowerShell Monitoring", eyebrow: "[ SCRIPT ACTIVITY ]" },
  jitter: { title: "Shipper Jitter", eyebrow: "[ AGENT QUEUE ]" },
  chunks: { title: "Chunk Monitor", eyebrow: "[ SHIPPER BATCHES ]" },
  heatmap: { title: "Host Activity Heatmap", eyebrow: "[ TIME SERIES ]" },
  "agent-errors": { title: "Agent Chunk Errors", eyebrow: "[ AGENT DIAGNOSTICS ]" },
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
}

async function loadDashboard() {
  if (state.loading) return;
  state.loading = true;
  setStatus("Connecting", false);

  try {
    const health = await api("/api/health");
    setStatus("Connected", true, `${formatNumber(health.rows)} rows`);

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
  ].forEach((id) => {
    const node = el(id);
    if (node) node.textContent = "-";
  });
}

function renderDemoDashboard() {
  el("kpiEvents").textContent = "152,988";
  el("kpiHosts").textContent = "8";
  el("kpiEventIds").textContent = "42";
  el("kpiLastSeen").textContent = "demo";

  const volume = [
    { time: "2026-06-24 09:30:00", events: 120 },
    { time: "2026-06-24 09:31:00", events: 212 },
    { time: "2026-06-24 09:32:00", events: 88 },
    { time: "2026-06-24 09:33:00", events: 301 },
    { time: "2026-06-24 09:34:00", events: 144 },
  ];
  const hosts = [
    { computer: "DESKTOP-2G18GQQ", events: 688 },
    { computer: "LAPTOP-H4A6KTGQ", events: 412 },
    { computer: "SOC-VM03", events: 221 },
    { computer: "LOCALTEST", events: 64 },
  ];
  const eventTypes = [
    { eventType: "Sysmon: Registry Object Created/Deleted", volume: 101 },
    { eventType: "Sysmon: Process Access", volume: 51 },
    { eventType: "PowerShell: Script Block", volume: 35 },
    { eventType: "Security: Successful Logon", volume: 16 },
  ];
  const timeline = eventTypes.map((row, index) => ({
    time: `2026-06-24 09:3${index}:10`,
    computer: hosts[index % hosts.length].computer,
    eventType: row.eventType,
    userName: "NT AUTHORITY\\SYSTEM",
    message: "Demo event rendered while API is offline",
  }));
  const processes = [
    { processPath: "C:\\Program Files\\Vector\\vector.exe", volume: 319575 },
    { processPath: "C:\\Windows\\System32\\svchost.exe", volume: 31092 },
    { processPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", volume: 3560 },
  ];
  const networkRows = [
    { destinationIp: "10.53.64.62", volume: 3132 },
    { destinationIp: "142.250.197.142", volume: 965 },
    { destinationIp: "35.223.238.178", volume: 831 },
  ];
  const domains = [
    { domain: "wpad", volume: 201 },
    { domain: "login.microsoftonline.com", volume: 36 },
    { domain: "p2p-hkg1.discovery.steamserver.net", volume: 30 },
  ];
  const recent = timeline.map((row) => ({
    ...row,
    processGuid: "{demo-guid}",
    destinationIp: "10.53.64.62",
    destinationPort: 443,
    dnsQuery: "login.microsoftonline.com",
    targetObject: "HKLM\\SOFTWARE\\Microsoft\\Wbem\\Tracing",
    targetFilename: "C:\\ProgramData\\Vector\\spool\\events.ndjson",
    targetImage: "Code.exe",
    grantedAccess: "0x1410",
    commandLine: "powershell.exe -NoProfile",
    scriptBlockText: "Get-Process | Select-Object Name, Id",
    eventId: 4104,
    level: "Warning",
  }));

  el("logVolumeMeta").textContent = "demo buckets";
  renderLineChart(el("logVolumeChart"), volume, "time", "events", "#ff4b12");
  renderPie(el("topHostsPie"), hosts, "computer", "events");
  renderTable(el("eventTypesTable"), eventTypes, [["Event type", "eventType"], ["volume", "volume", "numeric"]]);
  renderTable(el("securityTimeline"), timeline, [["Time", "time", "date"], ["Host", "computer"], ["Event type", "eventType"], ["User", "userName"], ["Message", "message"]]);
  renderTable(el("topProcessesTable"), processes, [["Process", "processPath"], ["volume", "volume", "numeric"]]);
  renderTable(el("processRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["Type", "eventType"], ["User", "userName"], ["Command line", "commandLine"]]);
  renderTable(el("topIpsTable"), networkRows, [["Destination IP", "destinationIp"], ["volume", "volume", "numeric"]]);
  renderTable(el("networkRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["User", "userName"], ["Process GUID", "processGuid"], ["Destination IP", "destinationIp"], ["Port", "destinationPort", "numeric"]]);
  renderTable(el("topDomainsTable"), domains, [["Domain", "domain"], ["volume", "volume", "numeric"]]);
  renderTable(el("dnsRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["User", "userName"], ["Process GUID", "processGuid"], ["DNS query", "dnsQuery"]]);
  renderTable(el("registryRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["Type", "eventType"], ["User", "userName"], ["Target", "targetObject"]]);
  renderTable(el("fileRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["Type", "eventType"], ["User", "userName"], ["Target file", "targetFilename"]]);
  renderTable(el("processAccessTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["User", "userName"], ["Source", "processPath"], ["Target", "targetImage"], ["Access", "grantedAccess"]]);
  renderLineChart(el("powershellVolumeChart"), volume, "time", "events", "#ff4b12");
  renderTable(el("powershellRecentTable"), recent, [["Time", "time", "date"], ["Host", "computer"], ["Event ID", "eventId", "numeric"], ["Level", "level"], ["Script block", "scriptBlockText"]]);

  renderHostsScreen({
    groups: [
      { level: "online", label: "Online <= 5m", count: 2 },
      { level: "active", label: "Active <= 1h", count: 1 },
      { level: "delayed", label: "Delayed <= 24h", count: 1 },
      { level: "stale", label: "Stale > 24h", count: 0 },
    ],
    hosts: hosts.map((host, index) => ({
      computer: host.computer,
      totalEvents: host.events,
      firstSeen: volume[0].time,
      lastSeen: volume[Math.min(index, volume.length - 1)].time,
      channels: 3,
      eventIds: 8,
      statusLevel: index === 0 ? "online" : index === 1 ? "active" : "delayed",
      statusLabel: index === 0 ? "Online <= 5m" : index === 1 ? "Active <= 1h" : "Delayed <= 24h",
      ageSeconds: index * 1800,
    })),
  });

  const heatHosts = hosts.slice(0, 4).map((host, index) => ({ rank: index + 1, alias: `C${index + 1}`, computer: host.computer, totalEvents: host.events }));
  const heatCells = [];
  heatHosts.forEach((host, hostIndex) => {
    volume.forEach((bucket, bucketIndex) => {
      heatCells.push({
        alias: host.alias,
        computer: host.computer,
        bucketTime: bucket.time,
        events: Math.max(1, Math.round(bucket.events / (hostIndex + 1))),
        level: Math.max(1, 5 - Math.abs(hostIndex - bucketIndex) % 5),
      });
    });
  });
  renderHeatmap(el("hostHeatmap"), heatHosts, heatCells);
}

async function loadSummaryAndHosts() {
  const [summary, topHosts] = await Promise.all([
    api(`/api/dashboard/overview/summary${query()}`),
    api(`/api/dashboard/overview/top-hosts${query({ limit: 50 })}`),
  ]);

  el("kpiEvents").textContent = formatNumber(summary.totalEvents);
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

  const body = rows.map((host) => `
    <tr>
      <td title="${escapeAttr(host.computer)}">${escapeHtml(host.computer || "(empty)")}</td>
      <td><span class="status-badge status-${escapeAttr(host.statusLevel)}">${escapeHtml(host.statusLabel)}</span></td>
      <td title="${escapeAttr(host.lastSeen)}">${escapeHtml(formatDate(host.lastSeen))}</td>
      <td class="numeric">${formatAge(host.ageSeconds)}</td>
      <td class="numeric">${formatNumber(host.totalEvents)}</td>
      <td class="numeric">${formatNumber(host.channels)}</td>
      <td class="numeric">${formatNumber(host.eventIds)}</td>
    </tr>
  `).join("");

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Host</th>
          <th>Level</th>
          <th>Last seen</th>
          <th class="numeric">Age</th>
          <th class="numeric">Events</th>
          <th class="numeric">Channels</th>
          <th class="numeric">Event IDs</th>
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

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
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
  const hours = value === "1h" ? 1 : value === "6h" ? 6 : value === "24h" ? 24 : 24 * 30;
  return {
    from: new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
  };
}

function selectedBucket() {
  const value = el("rangeSelect").value;
  if (value === "1h") return "second";
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
