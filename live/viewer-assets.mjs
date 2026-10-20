import {readFile} from 'node:fs/promises';
import {makeStaticAssets} from './static-assets.mjs';
import {adaptCanvasKitGlue} from './canvaskit-glue.mjs';
const root=new URL('../',import.meta.url);
export async function prepareViewerAssets(){
 const files=new Map([
  ['/', ['viewer/live.html','text/html; charset=utf-8']],['/live.mjs',['viewer/live.mjs','text/javascript']],
  ['/input.mjs',['viewer/input.mjs','text/javascript']],
  ['/control-channel.mjs',['viewer/control-channel.mjs','text/javascript']],
  ['/lifecycle.mjs',['viewer/lifecycle.mjs','text/javascript']],
  ['/frame-presenter.mjs',['viewer/frame-presenter.mjs','text/javascript']],
  ['/renderer-runtime.mjs',['viewer/renderer-runtime.mjs','text/javascript']],
  ['/damage.mjs',['viewer/damage.mjs','text/javascript']],
  ['/live.css',['viewer/live.css','text/css']],['/scene-renderer.mjs',['viewer/scene-renderer.mjs','text/javascript']],
  ['/protocol/asset-wire.mjs',['protocol/asset-wire.mjs','text/javascript']],
  ['/protocol/client-memory.mjs',['protocol/client-memory.mjs','text/javascript']],
  ['/protocol/resource-memory.mjs',['protocol/resource-memory.mjs','text/javascript']],
  ['/protocol/metadata-json.mjs',['protocol/metadata-json.mjs','text/javascript']],
  ['/protocol/live-wire.mjs',['protocol/live-wire.mjs','text/javascript']],['/protocol/wire.mjs',['protocol/wire.mjs','text/javascript']],
  ['/stream-worker.mjs',['viewer/stream-worker.mjs','text/javascript']],
  ['/vendor/canvaskit.js',['node_modules/canvaskit-wasm/bin/full/canvaskit.js','text/javascript']],
  ['/vendor/canvaskit.wasm',['node_modules/canvaskit-wasm/bin/full/canvaskit.wasm','application/wasm']],
 ]);
 const inputs=new Map(await Promise.all([...files].map(async([path,[file,type]])=>[path,{type,bytes:await readFile(new URL(file,root))}])));
 inputs.get('/vendor/canvaskit.js').bytes=adaptCanvasKitGlue(inputs.get('/vendor/canvaskit.js').bytes);
 inputs.set('/canvaskit-worker.mjs',{type:'text/javascript',bytes:Buffer.concat([inputs.get('/vendor/canvaskit.js').bytes,Buffer.from('\nexport default CanvasKitInit;')])});
 return makeStaticAssets(inputs);
}
