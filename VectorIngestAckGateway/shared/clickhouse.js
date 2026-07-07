function createClickHouseClient(clickhouseUrl) {
  async function query(sql) {
    const response = await fetch(`${clickhouseUrl}/?query=${encodeURIComponent(sql)}`, {
      method: "POST"
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse ${response.status}: ${text}`);
    }
    return text;
  }

  async function insert(table, row) {
    const sql = `INSERT INTO ${table} FORMAT JSONEachRow`;
    const response = await fetch(`${clickhouseUrl}/?query=${encodeURIComponent(sql)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row) + "\n"
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse insert ${response.status}: ${text}`);
    }
  }

  async function getChunk(agentId, chunkId) {
    const sql = [
      "SELECT checksum, event_count, status",
      "FROM default.ingest_chunks FINAL",
      `WHERE agent_id='${escapeSql(agentId)}' AND chunk_id='${escapeSql(chunkId)}'`,
      "ORDER BY last_seen DESC",
      "LIMIT 1",
      "FORMAT JSONEachRow"
    ].join(" ");
    const text = (await query(sql)).trim();
    if (!text) return null;
    return JSON.parse(text.split(/\r?\n/)[0]);
  }

  return {
    query,
    insert,
    getChunk
  };
}

function escapeSql(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

module.exports = {
  createClickHouseClient,
  escapeSql
};
