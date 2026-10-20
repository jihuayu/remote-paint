import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {makeStaticAssets} from './static-assets.mjs';
import {adaptCanvasKitGlue} from './canvaskit-glue.mjs';
const root=new URL('../',import.meta.url);
export async function prepareViewerAssets({mode='local'}={}){
 if(!['local','public'].includes(mode))throw new TypeError('Invalid Viewer asset mode');
 const files=new Map([
  ['/', ['viewer/live.html','text/html; charset=utf-8']],['/live.mjs',['viewer/live.mjs','text/javascript']],
  ['/input.mjs',['viewer/input.mjs','text/javascript']],
  ['/control-channel.mjs',['viewer/control-channel.mjs','text/javascript']],
  ['/lifecycle.mjs',['viewer/lifecycle.mjs','text/javascript']],
  ['/connection.mjs',['sdk/viewer-connection.mjs','text/javascript']],
  ['/viewer-channel.mjs',['sdk/viewer-channel.mjs','text/javascript']],
  ['/viewer-control.mjs',['sdk/viewer-control.mjs','text/javascript']],
  ['/embed-bridge.mjs',['viewer/embed-bridge.mjs','text/javascript']],
  ['/public-config.mjs',['viewer/public-config.mjs','text/javascript']],
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
 const assets=await makeStaticAssets(inputs);
 if(mode==='local')return Object.freeze({...assets,mode});
 // Boot policy is a no-store entry variant. Both modes keep the exact same
 // immutable modules/build expected by the same-version private data gateway.
 const entry=assets.get('/'),html=entry.bytes.toString('utf8');
 if(!html.includes('<head>'))throw new Error('Viewer entry has no head');
 const bytes=Buffer.from(html.replace('<head>','<head><meta name="remote-paint-mode" content="public">'));
 const rootEntry=Object.freeze({...entry,bytes,gzip:null,gzipEtag:null,etag:`"${createHash('sha256').update(bytes).digest('hex')}"`});
 return Object.freeze({...assets,mode,get(path){return path==='/'?rootEntry:assets.get(path);}});
}
