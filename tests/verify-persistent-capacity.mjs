import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {fixture, KEY, renderer} from './fixtures/viewer-access-harness.mjs';
import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';

// Real browser/IndexedDB and public ticket/WS authority. The named Node Source
// is a fixture; this does not qualify Native transport or physical RSS.
const output = resolve(process.argv[2] ?? 'outputs/persistent-capacity-proof');
await mkdir(output, {recursive: true});
const cleanups = [];
let browser, server;
try {
  const h = await fixture({after: fn => cleanups.push(fn)}, {ttlSeconds: 300});
  const routes = new Set(['/viewer/persistent-resources.mjs', '/protocol/wire.mjs', '/protocol/resource-cache.mjs', '/protocol/client-memory.mjs', '/sdk/viewer-connection.mjs']);
  server = createServer(async (req, res) => {
    if (req.url === '/') { res.writeHead(200, {'content-type': 'text/html'}); res.end('<title>Owned cache pressure verifier</title>'); return; }
    if (!routes.has(req.url)) { res.writeHead(404); res.end(); return; }
    try { const bytes = await readFile(new URL('..' + req.url, import.meta.url)); res.writeHead(200, {'content-type': 'text/javascript'}); res.end(bytes); }
    catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launchPersistentContext(output + '/owned-chrome-profile', cacheBrowserOptions());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('fixtureTicket', async () => {
    const r = await h.api(h.tickets, {method: 'POST', key: KEY, body: {role: 'readonly', audience: origin, ttlSeconds: 120}});
    assert.equal(r.status, 200); return r.data;
  });
  await page.exposeFunction('pressureProgress', row => console.log(JSON.stringify({pressure: row})));
  await page.goto(origin);
  const result = await page.evaluate(async ({base, sessionId, renderer}) => {
    const {PersistentResources} = await import('/viewer/persistent-resources.mjs');
    const {ViewerConnection} = await import('/sdk/viewer-connection.mjs');
    const {ClientMemory, memoryPolicy} = await import('/protocol/client-memory.mjs');
    const MiB = 1024 * 1024, checks = [];
    const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
    const until = async fn => { const end = performance.now() + 2500; while (!fn()) { if (performance.now() >= end) throw new Error('Pressure authority observation deadline'); await new Promise(r => setTimeout(r, 5)); } };
    const sha = async b => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), n => n.toString(16).padStart(2, '0')).join('');
    const memory = new ClientMemory(memoryPolicy({profile: 'compact'}));
    const connection = new ViewerConnection({gatewayOrigin: base, audience: location.origin, sessionId, role: 'readonly', refreshBeforeMs: 50, getTicket: () => window.fixtureTicket(), onSocket: (ws, _grant, authority) => {
      ws.onopen = () => ws.send(JSON.stringify({type: 'Hello', protocol: 4, renderer, capabilities: ['frame-window-v1'], frameWindow: 6}));
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'Welcome') authority.acceptWelcome(m); else if (m.type === 'FrameCommit') ws.send(JSON.stringify({type: 'FrameAck', pageEpoch: m.pageEpoch, frameId: m.frameId, stage: 'scene-submitted'})); };
    }});
    await connection.start(); await until(() => connection.resourceCachePermission);
    const permission = connection.resourceCachePermission;
    const snapshot = async name => {
      const request = indexedDB.open(name, 1); await new Promise((yes, no) => { request.onsuccess = yes; request.onerror = no; }); const db = request.result;
      try { return await new Promise((yes, no) => { const tx = db.transaction(['meta', 'bodies'], 'readonly'), rows = tx.objectStore('meta').getAll(), count = tx.objectStore('bodies').count(); tx.oncomplete = () => yes({rows: rows.result, bodies: count.result}); tx.onabort = no; }); }
      finally { db.close(); }
    };
    const remove = name => new Promise((yes, no) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = yes; r.onerror = no; });
    const cases = [];
    for (const [name, entries, bytes] of [['remote-paint-full-default-pressure-v1', 512, 128 * 1024], ['remote-paint-entry-pressure-v1', 512, 256], ['remote-paint-byte-pressure-v1', 64, MiB]]) {
      const cache = new PersistentResources({name, getPermission: () => connection.resourceCachePermission}), durations = [];
      await cache.state({state: 'authorized', permission});
      for (let i = 0; i < entries; i++) {
        const body = new Uint8Array(bytes).fill(i % 251); new DataView(body.buffer).setUint32(0, i, true);
        const id = await sha(body), start = performance.now();
        check(await cache.write('chunk', id, body, {memory}), name + ': physical write ' + i);
        durations.push(performance.now() - start);
        if ((i + 1) % 64 === 0) await window.pressureProgress({name, written: i + 1, lastWriteMs: durations.at(-1)});
      }
      const full = await snapshot(name), sum = full.rows.reduce((n, r) => n + r.bytes, 0);
      check(full.rows.length === entries && full.bodies === entries && sum === entries * bytes, name + ': actual capacity committed');
      const oldest = [...full.rows].sort((a, b) => a.writtenAt - b.writtenAt || a.key.localeCompare(b.key))[0];
      const signal = AbortSignal.timeout(150), offerStart = performance.now(), offer = await cache.offer({memory, signal});
      const offerMs = performance.now() - offerStart;
      check(!!offer && offer.offer.resources.length === 128 || entries < 128 && offer?.offer.resources.length === entries, name + ': full-capacity offer within original observer');
      offer?.release();
      const extra = new Uint8Array(bytes).fill(253); new DataView(extra.buffer).setUint32(0, entries + 1, true); const extraId = await sha(extra);
      check(await cache.write('chunk', extraId, extra, {memory}), name + ': overflow write committed');
      const overflow = await snapshot(name);
      check(overflow.rows.length === entries && overflow.bodies === entries && overflow.rows.reduce((n, r) => n + r.bytes, 0) === sum, name + ': quota enforced atomically');
      check(!overflow.rows.some(r => r.id === oldest.id) && cache.stats.evictions === 1, name + ': deterministic oldest metadata and body evicted together');
      check(await cache.read('chunk', oldest.id, {memory}) === null, name + ': evicted entry is a recoverable miss');
      const newest = await cache.read('chunk', extraId, {memory}); check(newest?.payload.length === bytes, name + ': newest SHA-verified body readable'); newest?.release();
      check(memory.totals().owners === 0 && cache.stats.pendingBytes === 0, name + ': transient charges fully released');
      const sorted = [...durations].sort((a, b) => a - b);
      cases.push({name, entries, payloadBytes: sum, maxWriteMs: sorted.at(-1), p95WriteMs: sorted[Math.floor(sorted.length * .95)], offerMs, offeredEntries: offer?.offer.resources.length, stats: cache.stats});
      check(await cache.close(), name + ': close physically purged'); const cleared = await snapshot(name); check(cleared.rows.length === 0 && cleared.bodies === 0, name + ': no stale bodies after purge'); await remove(name);
    }
    connection.destroy();
    return {status: 'passed', checks: checks.length, cases, actualIndexedDb: true, actualPublicTicketAndWebSocketAuthority: true, unchangedOfferObserverMs: 150, cacheOperationTimeoutMs: 1000, source: 'virtual Node Source fixture', actualNativeTransportQualified: false, wholeProcessMemoryQualified: false};
  }, {base: h.base, sessionId: h.sessionId, renderer});
  assert.deepEqual(errors, []); result.browserVersion = browser.browser()?.version();
  await writeFile(output + '/result.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(output + '/failure.json', JSON.stringify({status: 'failed', name: error.name, message: error.message, stack: error.stack}, null, 2) + '\n'); throw error;
} finally {
  await browser?.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } for (const cleanup of cleanups.reverse()) await cleanup();
}
