import argparse
import csv
import html
import subprocess
from datetime import datetime
from pathlib import Path

parser = argparse.ArgumentParser(description="Export ClickHouse SOC log aggregates and generate SVG/HTML charts.")
parser.add_argument("--output", default="visualizations", help="Output directory for CSV, SVG, and HTML files.")
parser.add_argument("--container", default="local-clickhouse", help="ClickHouse Docker container name.")
args = parser.parse_args()

OUT = Path(args.output).resolve()
OUT.mkdir(parents=True, exist_ok=True)


def run_query(sql: str):
    cmd = [
        "docker",
        "exec",
        args.container,
        "clickhouse-client",
        "--query",
        sql + " FORMAT CSVWithNames",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", check=True)
    rows = list(csv.DictReader(proc.stdout.splitlines()))
    return rows


def write_csv(name: str, rows):
    if not rows:
        return
    path = OUT / name
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def fmt_int(value):
    return f"{int(float(value)):,}"


def short_label(value, max_chars=54):
    value = str(value) if value is not None else "(empty)"
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3] + "..."


def svg_bar_chart(path, title, rows, label_key, value_key, width=1600, height=720, color="#2563eb", label_chars=54):
    margin_l, margin_r, margin_t, margin_b = 560, 170, 80, 70
    plot_w = width - margin_l - margin_r
    bar_h = 34
    gap = 14
    usable_h = max(height - margin_t - margin_b, len(rows) * (bar_h + gap))
    height = margin_t + margin_b + usable_h
    max_v = max(int(float(r[value_key])) for r in rows) or 1
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{margin_l}" y="42" font-family="Segoe UI, Arial" font-size="26" font-weight="700" fill="#111827">{html.escape(title)}</text>',
        f'<line x1="{margin_l}" y1="{height-margin_b}" x2="{width-margin_r}" y2="{height-margin_b}" stroke="#d1d5db"/>',
    ]
    y = margin_t
    for r in rows:
        label = str(r[label_key]) or "(empty)"
        val = int(float(r[value_key]))
        bw = max(2, int(plot_w * val / max_v))
        value_x = min(margin_l + bw + 10, width - margin_r + 8)
        parts += [
            f'<text x="24" y="{y+bar_h*0.68:.1f}" font-family="Segoe UI, Arial" font-size="15" fill="#374151"><title>{html.escape(label)}</title>{html.escape(short_label(label, label_chars))}</text>',
            f'<rect x="{margin_l}" y="{y}" width="{bw}" height="{bar_h}" rx="4" fill="{color}"/>',
            f'<text x="{value_x}" y="{y+bar_h*0.68:.1f}" font-family="Segoe UI, Arial" font-size="15" fill="#111827">{fmt_int(val)}</text>',
        ]
        y += bar_h + gap
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def color_for(value, max_value):
    if value <= 0 or max_value <= 0:
        return "#f8fafc"
    import math
    intensity = math.log1p(value) / math.log1p(max_value)
    palette = [
        "#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd",
        "#60a5fa", "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af",
    ]
    idx = min(len(palette) - 1, max(0, int(intensity * (len(palette) - 1))))
    return palette[idx]


def svg_host_time_heatmap(path, title, host_time_rows, host_rows, width=1700, height=700):
    host_order = [r["computer"] for r in host_rows[:10]]
    host_alias = {host: f"C{i+1}" for i, host in enumerate(host_order)}
    minutes = sorted({r["minute"] for r in host_time_rows})
    values = {(r["computer"], r["minute"]): int(float(r["events"])) for r in host_time_rows}
    max_v = max(values.values()) if values else 1

    margin_l, margin_r, margin_t, margin_b = 120, 360, 95, 120
    row_h = 42
    gap_y = 8
    plot_w = width - margin_l - margin_r
    plot_h = max(len(host_order) * (row_h + gap_y), height - margin_t - margin_b)
    height = margin_t + margin_b + plot_h
    cell_w = plot_w / max(1, len(minutes))

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{margin_l}" y="42" font-family="Segoe UI, Arial" font-size="26" font-weight="700" fill="#111827">{html.escape(title)}</text>',
        f'<text x="{margin_l}" y="68" font-family="Segoe UI, Arial" font-size="14" fill="#6b7280">Rows C1..C10 are hosts ordered by total event volume. Darker cells mean more logs in that minute; pale/blank cells indicate drops or no ingest.</text>',
    ]

    for row_idx, host in enumerate(host_order):
        y = margin_t + row_idx * (row_h + gap_y)
        alias = host_alias[host]
        parts.append(f'<text x="36" y="{y + row_h * 0.62:.1f}" font-family="Segoe UI, Arial" font-size="18" font-weight="700" fill="#111827">{alias}</text>')
        parts.append(f'<line x1="{margin_l}" y1="{y + row_h + 4}" x2="{margin_l + plot_w}" y2="{y + row_h + 4}" stroke="#eef2f7"/>')
        for col_idx, minute in enumerate(minutes):
            x = margin_l + col_idx * cell_w
            val = values.get((host, minute), 0)
            fill = color_for(val, max_v)
            parts.append(
                f'<rect x="{x:.2f}" y="{y}" width="{max(cell_w - 1, 1):.2f}" height="{row_h}" rx="3" fill="{fill}">'
                f'<title>{html.escape(alias)} / {html.escape(host)} / {html.escape(minute)}: {fmt_int(val)} events</title></rect>'
            )

    axis_y = margin_t + len(host_order) * (row_h + gap_y) + 18
    parts.append(f'<line x1="{margin_l}" y1="{axis_y}" x2="{margin_l + plot_w}" y2="{axis_y}" stroke="#d1d5db"/>')
    step = max(1, len(minutes) // 10)
    for col_idx in range(0, len(minutes), step):
        minute = minutes[col_idx]
        x = margin_l + col_idx * cell_w
        label = minute[5:16]
        parts.append(f'<text transform="translate({x:.1f},{axis_y + 24}) rotate(35)" font-family="Segoe UI, Arial" font-size="12" fill="#6b7280">{html.escape(label)}</text>')

    legend_x = margin_l + plot_w + 35
    parts.append(f'<text x="{legend_x}" y="{margin_t}" font-family="Segoe UI, Arial" font-size="16" font-weight="700" fill="#111827">Host mapping</text>')
    ly = margin_t + 28
    for host in host_order:
        alias = host_alias[host]
        parts.append(f'<text x="{legend_x}" y="{ly}" font-family="Segoe UI, Arial" font-size="14" fill="#374151"><tspan font-weight="700">{alias}</tspan> - {html.escape(short_label(host, 28))}</text>')
        ly += 24

    scale_y = ly + 18
    parts.append(f'<text x="{legend_x}" y="{scale_y}" font-family="Segoe UI, Arial" font-size="14" font-weight="700" fill="#111827">Volume scale</text>')
    sw = 22
    for i, fill in enumerate(["#f8fafc", "#dbeafe", "#93c5fd", "#3b82f6", "#1e40af"]):
        parts.append(f'<rect x="{legend_x + i * (sw + 4)}" y="{scale_y + 14}" width="{sw}" height="18" fill="{fill}" stroke="#e5e7eb"/>')
    parts.append(f'<text x="{legend_x}" y="{scale_y + 52}" font-family="Segoe UI, Arial" font-size="12" fill="#6b7280">low / no logs -> high logs</text>')

    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


def svg_line_chart(path, title, rows, time_key, value_key, width=1400, height=720):
    margin_l, margin_r, margin_t, margin_b = 90, 40, 80, 110
    plot_w = width - margin_l - margin_r
    plot_h = height - margin_t - margin_b
    values = [int(float(r[value_key])) for r in rows]
    max_v = max(values) if values else 1
    min_v = min(values) if values else 0
    span = max(max_v - min_v, 1)
    points = []
    for i, r in enumerate(rows):
        x = margin_l + (plot_w * i / max(1, len(rows) - 1))
        v = int(float(r[value_key]))
        y = margin_t + plot_h - ((v - min_v) / span * plot_h)
        points.append((x, y, r[time_key], v))
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y, _, _ in points)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{margin_l}" y="42" font-family="Segoe UI, Arial" font-size="26" font-weight="700" fill="#111827">{html.escape(title)}</text>',
    ]
    for i in range(5):
        y = margin_t + plot_h * i / 4
        val = int(max_v - span * i / 4)
        parts += [
            f'<line x1="{margin_l}" y1="{y:.1f}" x2="{width-margin_r}" y2="{y:.1f}" stroke="#e5e7eb"/>',
            f'<text x="18" y="{y+5:.1f}" font-family="Segoe UI, Arial" font-size="14" fill="#6b7280">{fmt_int(val)}</text>',
        ]
    parts += [
        f'<polyline fill="none" stroke="#dc2626" stroke-width="3" points="{poly}"/>',
        f'<line x1="{margin_l}" y1="{height-margin_b}" x2="{width-margin_r}" y2="{height-margin_b}" stroke="#d1d5db"/>',
    ]
    for idx in range(0, len(points), max(1, len(points)//8)):
        x, _, label, _ = points[idx]
        short = label[5:16]
        parts.append(f'<text transform="translate({x:.1f},{height-72}) rotate(45)" font-family="Segoe UI, Arial" font-size="13" fill="#6b7280">{html.escape(short)}</text>')
    for x, y, _, v in points:
        if v == max_v:
            parts += [
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="5" fill="#dc2626"/>',
                f'<text x="{x+8:.1f}" y="{y-8:.1f}" font-family="Segoe UI, Arial" font-size="14" font-weight="700" fill="#111827">peak {fmt_int(v)}</text>',
            ]
    parts.append("</svg>")
    path.write_text("\n".join(parts), encoding="utf-8")


summary = run_query("SELECT count() AS total_events, countDistinct(computer) AS hosts, min(kafka_timestamp) AS first_received, max(kafka_timestamp) AS last_received FROM default.windows_system_logs")
timeseries = run_query("SELECT toStartOfMinute(kafka_timestamp) AS minute, count() AS events FROM default.windows_system_logs GROUP BY minute ORDER BY minute")
hosts = run_query("SELECT computer, count() AS events FROM default.windows_system_logs GROUP BY computer ORDER BY events DESC LIMIT 20")
channels = run_query("SELECT channel, count() AS events FROM default.windows_system_logs GROUP BY channel ORDER BY events DESC")
event_ids = run_query("SELECT concat(toString(event_id), ' - ', provider_name) AS event, count() AS events FROM default.windows_system_logs GROUP BY event_id, provider_name ORDER BY events DESC LIMIT 15")
host_time = run_query("SELECT toStartOfMinute(kafka_timestamp) AS minute, computer, count() AS events FROM default.windows_system_logs GROUP BY minute, computer ORDER BY minute, computer")

write_csv("summary.csv", summary)
write_csv("events_over_time.csv", timeseries)
write_csv("events_by_host.csv", hosts)
write_csv("events_by_channel.csv", channels)
write_csv("top_event_ids.csv", event_ids)
write_csv("events_by_host_time.csv", host_time)

svg_line_chart(OUT / "events_over_time.svg", "Events Over Time (server receive time)", timeseries, "minute", "events")
svg_bar_chart(OUT / "events_by_host.svg", "Events By Host", hosts, "computer", "events", color="#2563eb")
svg_host_time_heatmap(OUT / "host_time_heatmap.svg", "Host Activity Over Time (C1-C10)", host_time, hosts)
svg_bar_chart(OUT / "events_by_channel.svg", "Events By Channel", channels, "channel", "events", color="#059669", label_chars=58)
svg_bar_chart(OUT / "top_event_ids.svg", "Top Event IDs", event_ids, "event", "events", color="#7c3aed", label_chars=58)

total = summary[0]["total_events"] if summary else "0"
hosts_n = summary[0]["hosts"] if summary else "0"
first = summary[0]["first_received"] if summary else ""
last = summary[0]["last_received"] if summary else ""
generated = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

html_doc = f"""<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <title>SOC Log Visualizations</title>
  <style>
    body {{ font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #111827; background: #f8fafc; }}
    .cards {{ display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 16px; margin: 24px 0; }}
    .card {{ background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 18px; }}
    .label {{ color: #6b7280; font-size: 13px; }}
    .value {{ font-size: 24px; font-weight: 700; margin-top: 6px; }}
    .chart {{ background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin: 18px 0; }}
    img {{ width: 100%; height: auto; }}
    code {{ background: #eef2ff; padding: 2px 5px; border-radius: 4px; }}
  </style>
</head>
<body>
  <h1>SOC Log Visualizations</h1>
  <p>Generated by Python from ClickHouse at <code>{html.escape(generated)}</code>.</p>
  <div class="cards">
    <div class="card"><div class="label">Total events</div><div class="value">{fmt_int(total)}</div></div>
    <div class="card"><div class="label">Distinct hosts</div><div class="value">{fmt_int(hosts_n)}</div></div>
    <div class="card"><div class="label">First received</div><div class="value" style="font-size:16px">{html.escape(first)}</div></div>
    <div class="card"><div class="label">Last received</div><div class="value" style="font-size:16px">{html.escape(last)}</div></div>
  </div>
  <div class="chart"><img src="events_over_time.svg" alt="Events over time"></div>
  <div class="chart"><img src="host_time_heatmap.svg" alt="Host activity over time heatmap"></div>
  <div class="chart"><img src="events_by_host.svg" alt="Events by host"></div>
  <div class="chart"><img src="events_by_channel.svg" alt="Events by channel"></div>
  <div class="chart"><img src="top_event_ids.svg" alt="Top event IDs"></div>
</body>
</html>"""
(OUT / "dashboard.html").write_text(html_doc, encoding="utf-8")
print(OUT)
