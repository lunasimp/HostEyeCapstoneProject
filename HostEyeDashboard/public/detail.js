const API_BASE = window.HOSTEYE_API_BASE || "";

const el = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", () => {
  const form = el("detailFilterForm");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const url = new URL(window.location.href);
    setOptionalParam(url, "channel", el("detailChannel")?.value);
    setOptionalParam(url, "eventId", el("detailEventId")?.value);
    setOptionalParam(url, "q", el("detailQuery")?.value);
    setOptionalParam(url, "limit", el("detailLimit")?.value);
    setOptionalParam(url, "view", el("detailView")?.value);
    window.history.replaceState(null, "", url.toString());
    loadDetail();
  });
  loadDetail();
});

async function loadDetail() {
  const params = new URLSearchParams(window.location.search);
  const host = params.get("host");
  const time = params.get("time");
  const bucket = params.get("bucket") || "minute";
  const channel = params.get("channel") || "";
  const eventId = params.get("eventId") || "";
  const q = params.get("q") || "";
  const limit = params.get("limit") || "200";
  const view = params.get("view") || "both";

  if (el("detailChannel")) el("detailChannel").value = channel;
  if (el("detailEventId")) el("detailEventId").value = eventId;
  if (el("detailQuery")) el("detailQuery").value = q;
  if (el("detailLimit")) el("detailLimit").value = limit;
  if (el("detailView")) el("detailView").value = view;
  applyDetailView(view);

  if (!host || !time) {
    renderError("Missing host or time query parameter.");
    return;
  }

  el("detailTitle").textContent = `${host}`;
  el("detailSubtitle").textContent = `${time} / bucket: ${bucket}`;

  try {
    const request = new URLSearchParams({ host, time, bucket, limit });
    if (channel) request.set("channel", channel);
    if (eventId) request.set("eventId", eventId);
    if (q) request.set("q", q);
    const detail = await api(`/api/dashboard/hosts/heatmap/cell?${request.toString()}`);
    const byType = detail.breakdown?.byEventType || [];
    const byChannel = detail.breakdown?.byChannel || [];
    const byEventId = detail.breakdown?.byEventId || [];
    const logs = detail.recentLogs || [];
    const chunks = detail.chunks || [];

    el("detailTotal").textContent = formatNumber(detail.totalEvents);
    el("detailChannels").textContent = formatNumber(byChannel.length);
    el("detailTypes").textContent = formatNumber(byType.length);
    el("detailLogs").textContent = formatNumber(logs.length);

    renderTable(el("detailByType"), byType, [
      ["Event type", "eventType"],
      ["events", "events", "numeric"],
    ]);
    renderTable(el("detailByChannel"), byChannel, [
      ["Channel", "channel"],
      ["events", "events", "numeric"],
    ]);
    renderTable(el("detailByEventId"), byEventId, [
      ["Event ID", "eventId", "numeric"],
      ["events", "events", "numeric"],
    ]);
    renderTable(el("detailChunks"), chunks, [
      ["Sent at", "sentAt", "date"],
      ["Agent", "agentId"],
      ["Spool file", "spoolFile"],
      ["Line offset", "lineOffset", "numeric"],
      ["Next offset", "nextLineOffset", "numeric"],
      ["Batch", "batchSize", "numeric"],
      ["Bytes", "batchBytes", "numeric"],
      ["Gzip", "compressedBytes", "numeric"],
      ["Jitter", "plannedJitterMs", "duration"],
      ["Window", "jitterWindowMs", "duration"],
      ["Retry", "retryAttempt", "numeric"],
      ["Backoff", "plannedBackoffMs", "duration"],
      ["Spool depth", "spoolDepthBytes", "bytes"],
      ["Files", "spoolFileCount", "numeric"],
      ["Pending", "pendingFileCount", "numeric"],
      ["HTTP", "statusCode", "numeric"],
      ["Send", "sendDurationMs", "duration"],
      ["OK", "success", "boolean"],
      ["Data loss", "dataLoss", "boolean"],
    ]);
    renderTable(el("detailRecentLogs"), logs, [
      ["Time", "time", "date"],
      ["Channel", "channel"],
      ["Event", "eventType"],
      ["User", "userName"],
      ["Process", "processPath"],
      ["Command line", "commandLine"],
      ["Source IP", "sourceIp"],
      ["Destination IP", "destinationIp"],
      ["DNS", "dnsQuery"],
      ["Target file", "targetFilename"],
      ["Registry target", "targetObject"],
      ["Message", "message"],
    ]);
  } catch (error) {
    renderError(error.message);
  }
}

function applyDetailView(view) {
  const normalized = ["both", "logs", "chunks"].includes(view) ? view : "both";
  const showLogs = normalized === "both" || normalized === "logs";
  const showChunks = normalized === "both" || normalized === "chunks";
  if (el("detailLogsSection")) el("detailLogsSection").hidden = !showLogs;
  if (el("detailChunksSection")) el("detailChunksSection").hidden = !showChunks;
}

function setOptionalParam(url, key, value) {
  const trimmed = String(value || "").trim();
  if (trimmed) url.searchParams.set(key, trimmed);
  else url.searchParams.delete(key);
}

async function api(path) {
  const token = localStorage.getItem("hosteyeDashboardSession") || "";
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store", headers });
  if (response.status === 401) {
    localStorage.removeItem("hosteyeDashboardSession");
    window.location.replace(new URL("./index.html#heatmap", window.location.href));
    throw new Error("Authentication expired. Returning to the Dashboard sign-in page.");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
  }
  return response.json();
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
      const value = type === "date"
        ? formatDate(raw)
        : type === "numeric"
          ? formatNumber(raw)
          : type === "duration"
            ? formatDuration(raw)
            : type === "bytes"
              ? formatBytes(raw)
              : type === "boolean"
                ? formatBoolean(raw)
                : String(raw);
      return `<td class="${type === "numeric" ? "numeric" : ""}" title="${escapeAttr(String(raw))}">${escapeHtml(value)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderError(message) {
  el("detailSubtitle").textContent = message;
  document.querySelectorAll(".table-shell").forEach((node) => {
    node.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
  });
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

function formatDuration(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "-";
  if (number >= 1000) return `${(number / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })}s`;
  return `${number.toLocaleString()}ms`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0 B";
  if (number >= 1024 * 1024) return `${(number / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`;
  if (number >= 1024) return `${(number / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} KB`;
  return `${number.toLocaleString()} B`;
}

function formatBoolean(value) {
  return Number(value) === 1 || value === true ? "yes" : "no";
}

function formatDate(value) {
  if (!value) return "-";
  const normalized = String(value).includes("T") ? value : String(value).replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
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
