import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import { encodeResource, validateFrame, LIMITS } from './protocol/wire.mjs';
import { sha256 } from './capture/capture.mjs';
import { adaptCanvasKitGlue } from './live/canvaskit-glue.mjs';

export async function startServer({ directory = 'artifacts/capture', port = 4173 } = {}) {
  const root = resolve(directory);
  const manifest = validateFrame(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
  if (manifest.resources?.length !== 1) throw new Error('Expected one exported resource');
  const item = manifest.resources[0];
  if (item.id !== manifest.requiredResources[0] || item.file !== `${item.id}.skp` || item.kind !== 'skp')
    throw new Error('Invalid manifest resource');
  const payload = await readFile(join(root, item.file));
  if (payload.length !== item.bytes || sha256(payload) !== item.id) throw new Error('Resource integrity mismatch');
  const binary = encodeResource(item.id, payload);
  const wasm = await readFile(new URL('./node_modules/canvaskit-wasm/bin/full/canvaskit.wasm', import.meta.url));
  if (manifest.renderer?.canvaskit !== '0.42.0' || manifest.renderer.wasmSha256 !== sha256(wasm))
    throw new Error('Capture renderer build does not match local CanvasKit');
  const canvasKitGlue = adaptCanvasKitGlue(await readFile(new URL('./node_modules/canvaskit-wasm/bin/full/canvaskit.js', import.meta.url)));
  const key = randomBytes(24).toString('hex');
  const allowed = new Map([
    ['/', ['./viewer/index.html', 'text/html; charset=utf-8']],
    ['/viewer.mjs', ['./viewer/viewer.mjs', 'text/javascript']],
    ['/style.css', ['./viewer/style.css', 'text/css']],
    ['/protocol/wire.mjs', ['./protocol/wire.mjs', 'text/javascript']],
    ['/vendor/canvaskit.js', ['./node_modules/canvaskit-wasm/bin/full/canvaskit.js', 'text/javascript']],
    ['/vendor/canvaskit.wasm', ['./node_modules/canvaskit-wasm/bin/full/canvaskit.wasm', 'application/wasm']],
  ]);
  const server = createServer(async (req, res) => {
    try {
      const file = allowed.get(new URL(req.url, 'http://localhost').pathname);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': file[1] }); res.end(file[0].endsWith('/canvaskit.js') ? canvasKitGlue : await readFile(new URL(file[0], import.meta.url)));
    } catch { res.writeHead(500); res.end('Internal error'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.jsonBytes, perMessageDeflate: false });
  let origin;
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(req.url, 'http://localhost');
    const supplied = Buffer.from(target.searchParams.get('key') ?? '');
    const valid = supplied.length === key.length && timingSafeEqual(supplied, Buffer.from(key));
    if (target.pathname !== '/stream' || req.headers.origin !== origin || !valid) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    let sent = false, retries = 0;
    const timer = setTimeout(() => ws.close(1008, 'Handshake timeout'), 10_000);
    const sendSnapshot = () => {
      if (ws.bufferedAmount > LIMITS.resourceBytes || retries++ > 2) { ws.close(1013, 'Reconnect for snapshot'); return; }
      ws.send(binary);
      // Send only frame metadata. Source HTML, URLs and screenshots stay server-side.
      const { protocol, pageEpoch, frameId, baseFrameId, viewportVersion, viewport, scene,
        requiredResources, lastProcessedInputSeq } = manifest;
      ws.send(JSON.stringify({ type: 'SceneUpdate', frame: { protocol, pageEpoch, frameId, baseFrameId,
        viewportVersion, viewport, scene, requiredResources, lastProcessedInputSeq } }));
      ws.send(JSON.stringify({ type: 'FrameCommit', pageEpoch, frameId }));
    };
    ws.on('message', (bytes, isBinary) => {
      try {
        if (isBinary) throw new Error('Client binary messages unsupported');
        const message = JSON.parse(bytes.toString());
        if (!sent) {
          if (message.type !== 'Hello' || message.protocol !== manifest.protocol ||
              message.renderer?.canvaskit !== manifest.renderer.canvaskit || message.renderer?.wasmSha256 !== manifest.renderer.wasmSha256)
            throw new Error('Incompatible protocol or renderer');
          sent = true; clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'Welcome', protocol: 1, producer: manifest.producer,
            renderer: manifest.renderer, mode: 'static-keyframe', input: false }));
          sendSnapshot();
        } else if (message.type === 'RequestKeyframe') sendSnapshot();
        else if (message.type !== 'FrameAck' || message.frameId !== manifest.frameId || message.pageEpoch !== manifest.pageEpoch)
          throw new Error('Unsupported client message');
      } catch (error) { ws.close(1008, error.message.slice(0, 100)); }
    });
    ws.on('close', () => clearTimeout(timer));
    ws.on('error', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, key, url: `${origin}/#key=${key}`, manifest,
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, port: { type: 'string' } } });
  const server = await startServer({ directory: values.directory ?? process.env.CAPTURE_DIR,
    port: Number(values.port ?? process.env.PORT ?? 4173) });
  console.log(`Remote Paint Viewer: ${server.url}`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
