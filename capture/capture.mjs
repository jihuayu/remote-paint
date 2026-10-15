import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchCaptureBrowser } from './browser.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

export async function capture({ url, output, width = 960, height = 640 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096)
    throw new Error('Viewport must be integers between 1 and 4096');
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Capture requires HTTP(S)');
  const browser = await launchCaptureBrowser();
  const scratch = await mkdtemp(join(tmpdir(), 'remote-paint-'));
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const cdp = await page.context().newCDPSession(page);
    let layers = [];
    cdp.on('LayerTree.layerTreeDidChange', event => { layers = event.layers ?? []; });
    await cdp.send('LayerTree.enable');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(i => i.decode()));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    if (page.frames().length !== 1) throw new Error('Phase A exporter does not compose iframe surfaces');
    const screenshot = await page.screenshot({ animations: 'disabled' });
    if (layers.some(l => l.transform)) throw new Error('Compositor transforms require the future scene adapter');
    const api = await page.evaluate(() => typeof globalThis.chrome?.gpuBenchmarking?.printToSkPicture);
    if (api !== 'function') throw new Error('Chromium benchmarking SKP export API unavailable');
    await page.evaluate(dir => chrome.gpuBenchmarking.printToSkPicture(dir), scratch);
    const files = (await readdir(scratch)).filter(f => f.endsWith('.skp'));
    if (files.length !== 1) throw new Error(`Expected one paint layer, got ${files.length}; cannot infer composition from SKP filenames`);
    const skp = await readFile(join(scratch, files[0]));
    if (skp.length > MAX_RESOURCE_BYTES) throw new Error(`SKP is ${skp.length} bytes; limit is ${MAX_RESOURCE_BYTES}. Use subset fonts; native subsetting is not implemented.`);
    if (skp.subarray(0, 8).toString() !== 'skiapict') throw new Error('Not an SKP file');
    const cull = [12, 16, 20, 24].map(offset => skp.readFloatLE(offset));
    if (cull[0] !== 0 || cull[1] !== 0 || cull[2] !== width || cull[3] !== height)
      throw new Error(`Single-layer cull ${cull} does not match viewport; scrolling/oversized layers need scene composition`);
    const version = await cdp.send('Browser.getVersion');
    const resourceId = sha256(skp);
    const wasm = await readFile(new URL('../node_modules/canvaskit-wasm/bin/full/canvaskit.wasm', import.meta.url));
    const manifest = {
      protocol: 1, captureBackend: 'chromium-gpu-benchmarking-single-layer',
      capturedAt: new Date().toISOString(),
      producer: { chromium: version.product, chromiumRevision: version.revision, skpVersion: skp.readUInt32LE(8) },
      renderer: { canvaskit: '0.42.0', wasmSha256: sha256(wasm), compatibility: 'experimental-unmatched-skia-builds' },
      pageEpoch: 1, frameId: 1, baseFrameId: null, viewportVersion: 1,
      viewport: { cssWidth: width, cssHeight: height, deviceScaleFactor: 1 },
      resources: [{ id: resourceId, kind: 'skp', file: `${resourceId}.skp`, bytes: skp.length }],
      scene: [{ resourceId, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], clip: [0, 0, width, height], opacity: 1 }],
      requiredResources: [resourceId], lastProcessedInputSeq: 0,
    };
    const dir = resolve(output);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${resourceId}.skp`), skp);
    await writeFile(join(dir, 'server.png'), screenshot);
    // Publish the manifest last so partially exported captures cannot be served.
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  } finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
}
