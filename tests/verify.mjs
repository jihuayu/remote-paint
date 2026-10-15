import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { startFixtureServer } from '../capture/fixture.mjs';
import { capture } from '../capture/capture.mjs';
import { browserExecutable } from '../capture/browser.mjs';
import { startServer } from '../server.mjs';

const out = resolve('artifacts/verification');
await mkdir(out, { recursive: true });
const fixture = await startFixtureServer();
const captureStarted = performance.now();
let manifest, captureMs;
const captureRejections = [];
try {
  manifest = await capture({ url: fixture.url, output: join(out, 'capture') });
  captureMs = performance.now() - captureStarted;
  for (const [file, pattern] of [['iframe.html', /iframe/], ['composited.html', /Compositor transforms|Expected one paint layer/]]) {
    const url = new URL(file, fixture.url).href;
    await assert.rejects(capture({ url, output: join(out, 'unsupported') }), error => {
      assert.match(error.message, pattern); captureRejections.push({ fixture: file, reason: error.message }); return true;
    });
  }
}
finally { await fixture.close(); }
// Original page is offline before the viewer starts. Replay cannot reload its assets.
const server = await startServer({ directory: join(out, 'capture'), port: 0 });
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 1 });
  const requests = [], errors = [], frames = [];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => ws.on('framereceived', event => {
    if (typeof event.payload === 'string') frames.push({ kind: JSON.parse(event.payload).type, bytes: Buffer.byteLength(event.payload) });
    else frames.push({ kind: 'ResourcePut', bytes: event.payload.length, magic: event.payload.subarray(0, 4).toString() });
  }));
  const start = performance.now();
  await page.goto(server.url);
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 30_000 });
  const firstPaintMs = performance.now() - start;
  const viewerResult = await page.evaluate(() => window.remotePaintResult);
  const dataUrl = await page.locator('#viewport').evaluate(canvas => canvas.toDataURL('image/png'));
  const replay = Buffer.from(dataUrl.split(',')[1], 'base64');
  await writeFile(join(out, 'replay.png'), replay);
  await page.screenshot({ path: join(out, 'viewer.png'), fullPage: true });
  assert.equal(await page.locator('iframe,input,textarea').count(), 0, 'Viewer must not contain source page DOM');
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => new URL(url).origin === server.origin));
  const allowed = ['/', '/style.css', '/viewer.mjs', '/protocol/wire.mjs', '/vendor/canvaskit.js', '/vendor/canvaskit.wasm'];
  assert.ok(requests.every(url => allowed.includes(new URL(url).pathname)));
  assert.deepEqual(frames.map(f => f.kind), ['Welcome', 'ResourcePut', 'SceneUpdate', 'FrameCommit']);
  assert.equal(frames[1].magic, 'RPNT');
  const a = PNG.sync.read(await readFile(join(out, 'capture/server.png')));
  const b = PNG.sync.read(replay);
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  const diff = new PNG({ width: a.width, height: a.height });
  let changed = 0, totalError = 0, maxError = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const e = Math.max(...[0, 1, 2].map(c => Math.abs(a.data[i + c] - b.data[i + c])));
    totalError += [0, 1, 2].reduce((sum, c) => sum + Math.abs(a.data[i + c] - b.data[i + c]), 0);
    maxError = Math.max(maxError, e); if (e > 16) changed++;
    diff.data.set(e > 16 ? [240, 50, 80, 255] : [240, 244, 248, 255], i);
  }
  const pixelMetrics = { width: a.width, height: a.height, changedPixelsAbove16: changed,
    changedRatioAbove16: changed / (a.width * a.height), meanAbsoluteChannelError: totalError / (a.width * a.height * 3), maxChannelError: maxError };
  await writeFile(join(out, 'diff.png'), PNG.sync.write(diff));
  // Known interior of the fixture's PNG: not affected by the rounded image border.
  let imageChangedChannels = 0;
  for (let y = 240; y < 375; y++) for (let x = 710; x < 898; x++) for (let c = 0; c < 3; c++) {
    const i = (y * a.width + x) * 4 + c;
    if (a.data[i] !== b.data[i]) imageChangedChannels++;
  }
  pixelMetrics.pngInteriorChangedChannels = imageChangedChannels;
  assert.equal(imageChangedChannels, 0, 'Embedded PNG must retain its colors');
  assert.ok(pixelMetrics.changedRatioAbove16 < 0.02, `Visual mismatch exceeds 2%: ${JSON.stringify(pixelMetrics)}`);
  assert.ok(pixelMetrics.meanAbsoluteChannelError < 1.5, 'Mean channel error exceeds 1.5/255');
  // A new connection must reconstruct the same keyframe without relying on prior cache.
  await page.locator('#reconnect').click();
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 15_000 });
  const reconnectPng = await page.locator('#viewport').evaluate(canvas => canvas.toDataURL('image/png'));
  assert.equal(reconnectPng, dataUrl);
  // The same bytes must replay at a different browser viewport and client DPR.
  const context2 = await browser.newContext({ viewport: { width: 700, height: 900 }, deviceScaleFactor: 2 });
  const page2 = await context2.newPage(); await page2.goto(server.url);
  await page2.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 15_000 });
  assert.equal(await page2.locator('#viewport').evaluate(c => c.toDataURL('image/png')), dataUrl);
  await page2.screenshot({ path: join(out, 'viewer-mobile.png'), fullPage: true });
  await context2.close();
  const report = { verifiedAt: new Date().toISOString(), producer: manifest.producer, renderer: manifest.renderer,
    captureBackend: manifest.captureBackend, captureMs, firstPaintMs, viewerResult, pixelMetrics,
    checks: { sourceOfflineDuringReplay: true, noSourceDomOrNetwork: true, reconnectExact: true,
      differentClientViewportAndDprExact: true, separateViewerBrowserFromCapture: true },
    captureRejections,
    requests: requests.map(url => new URL(url).pathname), firstConnectionFrames: frames.slice(0, 4),
    limits: ['Single local machine; not tested on another physical machine', 'Static single-layer fixture only',
      'Unmatched Chromium/CanvasKit Skia revisions; not general format compatibility', 'No realtime capture, input, Steel, iframe composition or GPU fallback'],
  };
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await server.close(); }
