const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DEFAULT_SPOOL = 'C:\\ProgramData\\HostEye\\spool';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8687/';

function cliOption(name) {
  const prefix = '--' + name + '=';
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : '';
}

function parseChunkFilename(name) {
  const match = /^chunk_([a-f0-9]{64})_([a-f0-9]{64})_(\d+)\.gz$/i.exec(String(name || ''));
  if (!match) return null;
  return { chunkId: match[1].toLowerCase(), checksum: match[2].toLowerCase(), eventCount: Number(match[3]) };
}

function decodeChunk(buffer) {
  const payload = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'));
  if (payload?.protocol !== 'hosteye.telemetry.v1' || !payload.chunk_id || !Array.isArray(payload.events)) {
    throw new Error('Unsupported spool payload');
  }
  return payload;
}

function enrichEvents(payload) {
  return payload.events.map((event, index) => {
    const enriched = {
      ...event,
      schema_version: String(payload.schema_version || ''),
      parser_status: 'valid',
      parser_error: '',
      validation_errors: '',
      processing_version: 'local-spool-mirror-1.0.0',
      chunk_id: String(payload.chunk_id || ''),
      chunk_checksum: String(payload.checksum || ''),
      sequence_number: Number(payload.sequence_number || 0),
      chunk_event_index: index,
    };
    if (!enriched.idempotency_key) {
      const seed = [enriched.computer || payload.computer || '', enriched.channel || '', enriched.record_id || '', enriched.timestamp || '', enriched.event_id || ''].join('|');
      enriched.idempotency_key = crypto.createHash('sha256').update(seed).digest('hex');
    }
    return enriched;
  });
}

function createMirror(options = {}) {
  const spoolDir = options.spoolDir || cliOption('spool') || process.env.HOSTEYE_SPOOL_DIR || DEFAULT_SPOOL;
  const endpoint = options.endpoint || cliOption('endpoint') || process.env.HOSTEYE_LOCAL_MIRROR_URL || DEFAULT_ENDPOINT;
  const stateDir = options.stateDir || cliOption('state') || process.env.HOSTEYE_LOCAL_MIRROR_STATE || path.resolve('.runtime', 'local-spool-mirror');
  const maxQueue = Math.max(10, Number(options.maxQueue || process.env.HOSTEYE_LOCAL_MIRROR_MAX_QUEUE || 250));
  const concurrency = Math.max(1, Math.min(4, Number(options.concurrency || process.env.HOSTEYE_LOCAL_MIRROR_CONCURRENCY || 2)));
  const queue = [];
  const queued = new Set();
  const completed = new Set();
  const inFlight = new Set();
  const stateFile = path.join(stateDir, 'state.json');
  let stopped = false;
  let mirrored = 0;
  let failed = 0;

  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const id of state.completed || []) completed.add(id);
  } catch {}

  function saveState() {
    const values = [...completed].slice(-5000);
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ updatedAt: new Date().toISOString(), mirrored, failed, completed: values }, null, 2));
    fs.renameSync(temp, stateFile);
  }

  function enqueue(name) {
    const parsed = parseChunkFilename(name);
    if (!parsed || completed.has(parsed.chunkId) || inFlight.has(parsed.chunkId) || queued.has(name)) return false;
    while (queue.length >= maxQueue) {
      const dropped = queue.shift();
      queued.delete(dropped);
    }
    queue.push(name);
    queued.add(name);
    return true;
  }

  async function postChunk(file, parsed) {
    const compressed = await fs.promises.readFile(file);
    const payload = decodeChunk(compressed);
    if (payload.chunk_id.toLowerCase() !== parsed.chunkId || Number(payload.event_count) !== parsed.eventCount) {
      throw new Error('Spool metadata mismatch for ' + path.basename(file));
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'HostEyeLocalMirror/1.0' },
      body: JSON.stringify(enrichEvents(payload)),
      signal: AbortSignal.timeout(30000),
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error('Local Vector gateway ' + response.status + ': ' + responseText.slice(0, 240));
    return { status: 'vector_acked' };
  }

  async function mirror(name) {
    const parsed = parseChunkFilename(name);
    if (!parsed) return;
    const file = path.join(spoolDir, name);
    let lastError;
    for (let attempt = 0; attempt < 5 && !stopped; attempt += 1) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 250 + attempt * 500));
        const result = await postChunk(file, parsed);
        completed.add(parsed.chunkId);
        mirrored += 1;
        saveState();
        console.log(`${new Date().toISOString()} mirrored chunk=${parsed.chunkId} events=${parsed.eventCount} status=${result.status}`);
        return;
      } catch (error) {
        lastError = error;
        if (error?.code === 'ENOENT') return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 500 * (2 ** attempt))));
      }
    }
    failed += 1;
    saveState();
    console.error(`${new Date().toISOString()} mirror failed file=${name}: ${lastError?.message || lastError}`);
  }

  async function worker() {
    while (!stopped) {
      const name = queue.shift();
      if (!name) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      queued.delete(name);
      const parsed = parseChunkFilename(name);
      if (!parsed || completed.has(parsed.chunkId) || inFlight.has(parsed.chunkId)) continue;
      inFlight.add(parsed.chunkId);
      try { await mirror(name); } finally { inFlight.delete(parsed.chunkId); }
    }
  }

  function start() {
    if (!fs.existsSync(spoolDir)) throw new Error(`Spool directory not found: ${spoolDir}`);
    const watcher = fs.watch(spoolDir, { persistent: true }, (_event, name) => enqueue(name));
    for (let index = 0; index < concurrency; index += 1) worker().catch(console.error);
    const timer = setInterval(() => console.log(`${new Date().toISOString()} mirror status queue=${queue.length} mirrored=${mirrored} failed=${failed}`), 60000);
    console.log(`${new Date().toISOString()} watching ${spoolDir} -> ${endpoint} (new chunks only)`);
    return () => { stopped = true; clearInterval(timer); watcher.close(); saveState(); };
  }

  return { start, enqueue, postChunk, stats: () => ({ queued: queue.length, mirrored, failed }) };
}

if (require.main === module) {
  const pidFile = cliOption('pid-file');
  if (pidFile) {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));
  }
  const mirror = createMirror();
  const stop = mirror.start();
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
}

module.exports = { createMirror, decodeChunk, enrichEvents, parseChunkFilename };
