const crypto = require("crypto");

const clickhouseUrl = process.env.CLICKHOUSE_URL || "http://host.docker.internal:8080/clickhouse/";
const opensearchUrl = (process.env.OPENSEARCH_URL || "http://host.docker.internal:9200").replace(/\/$/, "");
const intervalMs = Number(process.env.RAW_INDEX_INTERVAL_MS || 2000);
const lookbackSeconds = Number(process.env.RAW_LOOKBACK_SECONDS || 10);
const bootstrapMinutes = Number(process.env.RAW_BOOTSTRAP_MINUTES || 240);
const batchSize = Number(process.env.RAW_BATCH_SIZE || 5000);
const indexPrefix = process.env.OPENSEARCH_RAW_INDEX_PREFIX || "hosteye-raw-windows-v1";

let lastKafkaTimestamp = "";
let bootstrapped = false;

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
          kafka_timestamp: { type: "date" },
          timestamp: { type: "date" },
          indexed_at: { type: "date" },
          agent_id: { type: "keyword" },
          host_id: { type: "keyword" },
          computer: { type: "keyword" },
          source_platform: { type: "keyword" },
          channel: { type: "keyword" },
          event_id: { type: "integer" },
          record_id: { type: "long" },
          provider_name: { type: "keyword" },
          level: { type: "keyword" },
          user_name: { type: "keyword" },
          process_name: { type: "keyword" },
          process_path: { type: "keyword" },
          source_ip: { type: "ip", ignore_malformed: true },
          destination_ip: { type: "ip", ignore_malformed: true },
          destination_port: { type: "integer" },
          dns_query: { type: "keyword", ignore_above: 2048 },
          message: { type: "text" },
          raw_log: { type: "text" },
          idempotency_key: { type: "keyword" },
          opensearch_doc_id: { type: "keyword" },
        },
      },
    },
  });
  await os("PUT", `/_index_template/${indexPrefix}`, body);
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value) return value;
  if (value.includes("T")) return value;
  return value.replace(" ", "T") + "Z";
}

function indexName(row) {
  const day = String(row.kafka_timestamp || row.timestamp || new Date().toISOString()).slice(0, 10).replace(/-/g, ".");
  return `${indexPrefix}-${day}`;
}

function docId(row) {
  const host = row.host_id || row.computer || row.agent_id || "unknown-host";
  if (row.record_id && row.channel) return `${host}|${row.channel}|${row.record_id}`;
  const fingerprint = JSON.stringify({
    host,
    channel: row.channel || "",
    event_id: row.event_id || 0,
    timestamp: row.timestamp || "",
    message: row.message || "",
  });
  return crypto.createHash("sha256").update(fingerprint).digest("hex");
}

function cleanDoc(row) {
  for (const field of ["kafka_timestamp", "timestamp", "first_seen", "last_seen"]) {
    if (row[field]) row[field] = normalizeDate(row[field]);
  }
  row.indexed_at = new Date().toISOString();
  for (const field of ["event_id", "record_id", "sequence_number", "process_id", "parent_process_id", "target_process_id", "source_port", "destination_port"]) {
    if (row[field] !== undefined && row[field] !== "") row[field] = Number(row[field]);
  }
  row.opensearch_doc_id = docId(row);
  return row;
}

async function fetchRows() {
  const where = !bootstrapped
    ? `kafka_timestamp >= now64(3) - INTERVAL ${bootstrapMinutes} MINUTE`
    : `kafka_timestamp >= parseDateTime64BestEffort('${lastKafkaTimestamp}', 3) - INTERVAL ${lookbackSeconds} SECOND`;
  const sql = `
SELECT *
FROM default.windows_system_logs
WHERE channel != '' AND ${where}
ORDER BY kafka_timestamp ASC, channel ASC, record_id ASC
LIMIT ${batchSize}
FORMAT JSONEachRow`;
  const text = await ch(sql);
  return text.trim() ? text.trim().split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

async function indexOnce() {
  const rows = await fetchRows();
  bootstrapped = true;
  if (!rows.length) {
    console.log("raw-log-indexer no raw rows yet");
    return;
  }

  let bulk = "";
  let maxTimestamp = lastKafkaTimestamp;
  for (const row of rows) {
    if (!maxTimestamp || String(row.kafka_timestamp) > maxTimestamp) maxTimestamp = String(row.kafka_timestamp);
    bulk += JSON.stringify({ index: { _index: indexName(row), _id: docId(row) } }) + "\n";
    bulk += JSON.stringify(cleanDoc(row)) + "\n";
  }

  const resText = await os("POST", "/_bulk?refresh=true", bulk);
  const res = JSON.parse(resText);
  if (res.errors) throw new Error(`OpenSearch raw bulk had item errors: ${resText.slice(0, 1000)}`);
  lastKafkaTimestamp = maxTimestamp;
  console.log(`raw-log-indexer indexed ${rows.length} raw rows through kafka_timestamp=${lastKafkaTimestamp}`);
}

async function main() {
  console.log(`raw-log-indexer starting clickhouse=${clickhouseUrl} opensearch=${opensearchUrl}`);
  await ensureTemplate();
  while (true) {
    try {
      await indexOnce();
    } catch (err) {
      console.error(`raw-log-indexer error: ${err.stack || err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
