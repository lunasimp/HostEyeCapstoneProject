const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://host.docker.internal:8080/clickhouse/";
const opensearchUrl = (process.env.OPENSEARCH_URL || "http://host.docker.internal:9200").replace(/\/$/, "");
const intervalMs = Number(process.env.INDEX_INTERVAL_MS || 10000);
const featureSchemaVersion = process.env.FEATURE_SCHEMA_VERSION || "hosteye-feature-v1";
const indexPrefix = process.env.OPENSEARCH_INDEX_PREFIX || "hosteye-feature-windows-v1";

async function ch(sql) {
  const res = await fetch(clickhouseUrl, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text}\nSQL=${sql}`);
  return text;
}

async function os(method, path, body) {
  const res = await fetch(`${opensearchUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenSearch ${res.status}: ${text}`);
  return text;
}

async function ensureTemplate() {
  const body = JSON.stringify({
    index_patterns: [`${indexPrefix}-*`],
    template: {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: {
        dynamic: true,
        properties: {
          window_id: { type: "keyword" },
          feature_schema_version: { type: "keyword" },
          behavior_group: { type: "keyword" },
          entity_type: { type: "keyword" },
          entity_id: { type: "keyword" },
          host_id: { type: "keyword" },
          window_start: { type: "date" },
          window_end: { type: "date" },
          computed_at: { type: "date" },
          revision: { type: "long" },
          is_final: { type: "boolean" },
        },
      },
    },
  });
  await os("PUT", `/_index_template/${indexPrefix}`, body);
}

function indexName(row) {
  const day = String(row.window_start || new Date().toISOString()).slice(0, 10).replace(/-/g, ".");
  return `${indexPrefix}-${day}`;
}

async function fetchFeatures() {
  const sql = `SELECT * FROM default.feature_windows FINAL WHERE is_final = 1 AND feature_schema_version = '${featureSchemaVersion}' AND computed_at >= now() - INTERVAL 2 HOUR ORDER BY computed_at, window_id LIMIT 1000 FORMAT JSONEachRow`;
  const text = await ch(sql);
  return text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value) return value;
  if (value.includes("T")) return value;
  return value.replace(" ", "T") + "Z";
}

function cleanDoc(row) {
  delete row.evidence_event_ids;
  for (const field of ["window_start", "window_end", "watermark_at", "computed_at", "peer_first_seen", "peer_last_seen"]) {
    if (row[field]) row[field] = normalizeDate(row[field]);
  }
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === "") continue;
    if (typeof value === "string" && /^\d+$/.test(value) && key.endsWith("_count")) row[key] = Number(value);
  }
  row.is_final = row.is_final === 1 || row.is_final === true;
  return row;
}

async function indexOnce() {
  const rows = await fetchFeatures();
  if (!rows.length) {
    console.log("feature-indexer no feature rows yet");
    return;
  }
  let bulk = "";
  for (const row of rows) {
    bulk += JSON.stringify({ index: { _index: indexName(row), _id: row.window_id } }) + "\n";
    bulk += JSON.stringify(cleanDoc(row)) + "\n";
  }
  const resText = await os("POST", "/_bulk?refresh=true", bulk);
  const res = JSON.parse(resText);
  if (res.errors) throw new Error(`OpenSearch bulk had item errors: ${resText.slice(0, 1000)}`);
  console.log(`feature-indexer indexed ${rows.length} feature rows`);
}

async function main() {
  console.log(`feature-indexer starting clickhouse=${clickhouseUrl} opensearch=${opensearchUrl}`);
  await ensureTemplate();
  while (true) {
    try {
      await indexOnce();
    } catch (err) {
      console.error(`feature-indexer error: ${err.stack || err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

