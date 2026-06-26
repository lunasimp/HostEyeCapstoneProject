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

  if (el("detailChannel")) el("detailChannel").value = channel;
  if (el("detailEventId")) el("detailEventId").value = eventId;
  if (el("detailQuery")) el("detailQuery").value = q;
  if (el("detailLimit")) el("detailLimit").value = limit;

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

function setOptionalParam(url, key, value) {
  const trimmed = String(value || "").trim();
  if (trimmed) url.searchParams.set(key, trimmed);
  else url.searchParams.delete(key);
}

async function api(path) {
  const response = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
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
      const value = type === "date" ? formatDate(raw) : type === "numeric" ? formatNumber(raw) : String(raw);
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
