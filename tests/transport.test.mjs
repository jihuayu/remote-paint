import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startServer } from '../server.mjs';
import { sha256 } from '../capture/capture.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'remote-paint-test-'));
  // Transport tests deliberately use a synthetic envelope; browser verification uses real SKP.
  const bytes = Buffer.from('skiapict' + ' '.repeat(40)); const id = sha256(bytes);
  const wasm = await readFile(new URL('../node_modules/canvaskit-wasm/bin/full/canvaskit.wasm', import.meta.url));
  const manifest = { protocol: 1, pageEpoch: 1, frameId: 1, baseFrameId: null, viewportVersion: 1,
    viewport: { cssWidth: 100, cssHeight: 100, deviceScaleFactor: 1 },
    renderer: { canvaskit: '0.42.0', wasmSha256: sha256(wasm) }, producer: {},
    requiredResources: [id], resources: [{ id, file: `${id}.skp`, kind: 'skp', bytes: bytes.length }],
    scene: [{ resourceId: id, matrix: [1,0,0,0,1,0,0,0,1], clip: [0,0,100,100], opacity: 1 }] };
  await writeFile(join(directory, `${id}.skp`), bytes);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { directory, manifest, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('transport rejects bad origin/key and mismatched Wasm; serves each client a complete snapshot', async () => {
  const f = await fixture(); const server = await startServer({ directory: f.directory, port: 0 });
  const open = (key, origin) => new WebSocket(`${server.origin.replace('http:', 'ws:')}/stream?key=${key}`, { origin });
  try {
    for (const [key, origin] of [['bad', server.origin], [server.key, 'http://other.invalid']]) {
      await new Promise((resolve, reject) => {
        const ws = open(key, origin);
        ws.on('open', () => { ws.close(); reject(new Error('Unauthorized client connected')); });
        ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 403); res.resume(); ws.terminate(); resolve(); });
        ws.on('error', () => {});
      });
    }
    await new Promise((resolve, reject) => {
      const ws = open(server.key, server.origin); let received = 0;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'Hello', protocol: 1, renderer: { ...f.manifest.renderer, wasmSha256: 'bad' } })));
      ws.on('message', () => received++); ws.on('error', reject);
      ws.on('close', code => { assert.equal(code, 1008); assert.equal(received, 0); resolve(); });
    });
    async function receive() {
      return new Promise((resolve, reject) => {
        const ws = open(server.key, server.origin); const messages = [];
        ws.on('error', reject);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'Hello', protocol: 1, renderer: f.manifest.renderer })));
        ws.on('message', (data, binary) => {
          messages.push(binary ? 'ResourcePut' : JSON.parse(data).type);
          if (messages.at(-1) === 'FrameCommit') { ws.close(); resolve(messages); }
        });
      });
    }
    const clients = await Promise.all([receive(), receive()]);
    for (const messages of clients) assert.deepEqual(messages, ['Welcome', 'ResourcePut', 'SceneUpdate', 'FrameCommit']);
    assert.equal((await fetch(`${server.origin}/manifest.json`)).status, 404);
    assert.equal((await fetch(`${server.origin}/server.png`)).status, 404);
  } finally { await server.close(); await f.cleanup(); }
});

test('do not serve a capture whose resource has been modified', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, f.manifest.resources[0].file), 'tampered');
    await assert.rejects(startServer({ directory: f.directory, port: 0 }), /integrity/);
  } finally { await f.cleanup(); }
});
