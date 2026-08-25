const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { decodeChunk, enrichEvents, parseChunkFilename } = require('../mirror-hosteye-spool-local');

test('parseChunkFilename reads HostEye durable chunk metadata', () => {
  const id = 'a'.repeat(64);
  const checksum = 'b'.repeat(64);
  assert.deepEqual(parseChunkFilename(`chunk_${id}_${checksum}_100.gz`), {
    chunkId: id,
    checksum,
    eventCount: 100,
  });
  assert.equal(parseChunkFilename('events.ndjson'), null);
});

test('decodeChunk accepts the current HostEye envelope', () => {
  const payload = {
    protocol: 'hosteye.telemetry.v1',
    chunk_id: 'c'.repeat(64),
    event_count: 1,
    events: [{ channel: 'System', event_id: 1 }],
  };
  assert.deepEqual(decodeChunk(zlib.gzipSync(JSON.stringify(payload))), payload);
});


test('enrichEvents preserves endpoint data and adds chunk identity', () => {
  const [event] = enrichEvents({
    schema_version: '1.0.0',
    chunk_id: 'd'.repeat(64),
    checksum: 'e'.repeat(64),
    sequence_number: 7,
    computer: 'HOST-01',
    events: [{ channel: 'System', event_id: 1, record_id: 2, timestamp: '2026-08-05T00:00:00Z' }],
  });
  assert.equal(event.chunk_id, 'd'.repeat(64));
  assert.equal(event.sequence_number, 7);
  assert.equal(event.processing_version, 'local-spool-mirror-1.0.0');
  assert.match(event.idempotency_key, /^[a-f0-9]{64}$/);
});
