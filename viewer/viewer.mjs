import { VERSION, LIMITS, decodeResource, FrameGate } from '/protocol/wire.mjs';
const $ = id => document.getElementById(id);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
let socket, surface, generation = 0;
const status = text => { $('status').textContent = text; };
function fail(error) {
  document.body.dataset.ready = 'false'; status('绘制中断');
  $('error').hidden = false; $('error').textContent = error.message;
}
let ck, renderer;
async function init() {
  const wasmBinary = await (await fetch('/vendor/canvaskit.wasm')).arrayBuffer();
  renderer = { canvaskit: '0.42.0', wasmSha256: await digest(wasmBinary) };
  ck = await CanvasKitInit({ wasmBinary, locateFile: file => `/vendor/${file}` });
}

function draw(frame, gate) {
  const { cssWidth: width, cssHeight: height } = frame.viewport;
  const picture = ck.MakePicture(gate.resources.get(frame.requiredResources[0]));
  if (!picture) throw new Error('CanvasKit refused this SKP; a matched Skia build may be required');
  let staging, image;
  try {
    const cull = picture.cullRect();
    if (cull[0] !== 0 || cull[1] !== 0 || cull[2] !== width || cull[3] !== height) throw new Error('Picture viewport mismatch');
    staging = ck.MakeSurface(width, height);
    if (!staging) throw new Error('Staging surface allocation failed');
    staging.getCanvas().clear(ck.WHITE); staging.getCanvas().drawPicture(picture); staging.flush();
    image = staging.makeImageSnapshot();
    if (!image) throw new Error('Snapshot allocation failed');
    const canvas = $('viewport');
    if (!surface || canvas.width !== width || canvas.height !== height) {
      surface?.delete(); canvas.width = width; canvas.height = height;
      surface = ck.MakeSWCanvasSurface(canvas);
      if (!surface) throw new Error('Viewer surface allocation failed');
    }
    surface.getCanvas().clear(ck.WHITE); surface.getCanvas().drawImage(image, 0, 0); surface.flush();
  } finally { image?.delete(); staging?.delete(); picture.delete(); }
}

async function connect() {
  const current = ++generation;
  socket?.close(); document.body.dataset.ready = 'false'; $('error').hidden = true;
  const gate = new FrameGate(); let welcome = false, receivedBytes = 0;
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  if (!key) throw new Error('请使用服务端启动时输出的完整 Viewer 链接');
  status('连接绘制通道');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?key=${encodeURIComponent(key)}`);
  socket = ws; ws.binaryType = 'arraybuffer';
  ws.onopen = () => ws.send(JSON.stringify({ type: 'Hello', protocol: VERSION, renderer }));
  // Preserve WebSocket order across asynchronous SHA-256 checks.
  let queue = Promise.resolve(); let queuedBytes = 0;
  ws.onmessage = event => {
    const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data.byteLength;
    queuedBytes += size;
    if (queuedBytes > LIMITS.totalBytes + LIMITS.jsonBytes) { fail(new Error('Receive queue budget exceeded')); ws.close(); return; }
    queue = queue.then(async () => {
      try {
        if (current !== generation) return;
        receivedBytes += size;
        if (event.data instanceof ArrayBuffer) {
          if (!welcome) throw new Error('Resource before handshake');
          const { id, payload } = decodeResource(event.data);
          if (await digest(payload) !== id) throw new Error('Resource SHA-256 mismatch');
          gate.put(id, payload); return;
        }
        if (size > LIMITS.jsonBytes) throw new Error('Metadata budget exceeded');
        const message = JSON.parse(event.data);
        if (message.type === 'Welcome') {
          if (welcome || message.protocol !== VERSION || message.renderer?.wasmSha256 !== renderer.wasmSha256 ||
              message.renderer?.canvaskit !== renderer.canvaskit || message.mode !== 'static-keyframe' || message.input !== false)
            throw new Error('Invalid server handshake');
          welcome = true;
          $('build').textContent = `${message.producer.chromium} · SKP ${message.producer.skpVersion} · CanvasKit ${renderer.canvaskit}`;
        } else if (!welcome) throw new Error('Scene before handshake');
        else if (message.type === 'SceneUpdate') gate.stage(message.frame);
        else if (message.type === 'ResourceRelease') gate.release(message.id);
        else if (message.type === 'FrameCommit') {
          const frame = gate.commit(message.pageEpoch, message.frameId);
          if (!frame) { ws.send(JSON.stringify({ type: 'RequestKeyframe' })); return; }
          const started = performance.now(); draw(frame, gate);
          $('renderTime').textContent = `${(performance.now() - started).toFixed(1)} ms`;
          $('dimensions').textContent = `${frame.viewport.cssWidth} × ${frame.viewport.cssHeight} CSS px`;
          $('bytes').textContent = `${(gate.bytes / 1024).toFixed(1)} KiB`;
          $('frame').textContent = `#${frame.frameId}`;
          document.body.dataset.ready = 'true'; status('快照已重放');
          window.remotePaintResult = { frameId: frame.frameId, resourceBytes: gate.bytes, receivedBytes,
            renderMs: performance.now() - started, wasmSha256: renderer.wasmSha256 };
          ws.send(JSON.stringify({ type: 'FrameAck', pageEpoch: frame.pageEpoch, frameId: frame.frameId }));
        } else throw new Error('Unknown message');
      } catch (error) { if (current === generation) { fail(error); ws.close(1008, 'Viewer rejected frame'); } }
      finally { queuedBytes -= size; }
    });
  };
  ws.onclose = event => {
    if (current === generation && !$('error').hidden) return;
    if (current === generation) { status(event.code === 1008 ? '连接被拒绝' : '连接已关闭，可重新连接'); document.body.dataset.ready = 'false'; }
  };
  ws.onerror = () => { if (current === generation) fail(new Error('WebSocket connection failed')); };
}
$('reconnect').onclick = () => connect().catch(fail);
await init().then(connect).catch(fail);
window.addEventListener('pagehide', () => { socket?.close(); surface?.delete(); });
