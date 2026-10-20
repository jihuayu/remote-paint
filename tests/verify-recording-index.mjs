import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {NativeBroker} from '../native/broker.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

assert.equal(process.platform,'linux');
const side=512,poolLimit=65536,output='artifacts/recording-index';
const image=n=>{const p=new PNG({width:side,height:side});let v=n+1;for(let i=0;i<p.data.length;i+=4){v^=v<<13;v^=v>>>17;v^=v<<5;p.data.set([v&255,(v>>>8)&255,(v>>>16)&255,255],i);}for(let y=0;y<4;y++)for(let x=0;x<4;x++)p.data.set([n&255,(n>>>8)&255,199,255],(y*side+x)*4);return PNG.sync.write(p,{deflateLevel:1,filterType:0});};
const fixture=createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(url.pathname==='/image'){res.setHeader('content-type','image/png');res.end(image(Number(url.searchParams.get('n'))));return;}res.end(`<!doctype html><style>html,body{margin:0;overflow:hidden;background:white}img{position:absolute;left:0;top:32px;width:512px;height:512px;will-change:transform}#patch{position:absolute;left:256px;top:0;width:32px;height:24px;will-change:transform;background:rgb(31,79,191)}</style><img><div id="patch"></div><script>window.update=async n=>{const img=document.querySelector('img');img.src='/image?n='+n;await img.decode();};window.patch=()=>document.querySelector('#patch').style.background='rgb(43,161,89)';window.loaded=update(0);</script>`);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`,ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')}),variants=[];
let browser,viz,current,handles=[];
const closeHandle=async h=>{if(!h||h.closed)return;h.closed=true;await h.capture.close();await h.driver.close();await h.page.close();h.renderer.clear();await h.broker.close();};
try{
 for(const tiled of [false,true]){
  current={tiled,samples:[],errors:[]};const token=nativeToken();viz=await startVizIPC();
  browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'0',REMOTE_PAINT_TILED_CAPTURE:tiled?'1':'0',REMOTE_PAINT_RECORDING_INDEX_BYTES:String(poolLimit)},args:[...nativeLaunchArgs(token,{beginFrames:true}),'--process-per-site']});
  const context=await browser.newContext({viewport:{width:512,height:576}});
  const prepare=async(page,navigate)=>{const driver=await startBeginFrames(page);if(navigate)await page.goto(origin);await page.waitForFunction(()=>typeof window.loaded?.then==='function');await page.evaluate(()=>window.loaded);const capture=new NativeCapture(page,{token,viz,frameDriver:driver});await capture.initialize();await driver.stop();const h={page,driver,capture,broker:new NativeBroker(),renderer:new SceneRenderer(ck),resources:new Map(),label:handles.length};handles.push(h);return h;};
  const first=await prepare(await context.newPage(),true);
  const take=async(h,n,patch=[31,79,191,255])=>{
   current.phase={owner:h.label,n};await h.driver.step();const native=await h.capture.capture(),t=native.timing,p=t.recordingIndexPool;
   assert.equal(p.scope,'renderer-process-scalar-recording-index');assert.equal(p.limit,poolLimit);assert.ok(p.bytes<=p.limit&&p.peak<=p.limit);assert.equal(p.cacheCharge,poolLimit);
   for(const r of native.resources)if(r.skp)h.resources.set(r.resourceId,Buffer.from(r.skp,'base64'));
   const mapped=await h.broker.map(native,{epoch:1,viewportVersion:1,viewport:{cssWidth:512,cssHeight:576,deviceScaleFactor:1}}),required=new Set(mapped.payloads.keys());
   for(const id of h.resources.keys())if(!required.has(id))h.resources.delete(id);
   const rendered=h.renderer.render(mapped.scene,h.resources,ck.WHITE);
   let pixels;try{pixels=[[2,34],[258,2]].map(([x,y])=>[...rendered.image.readPixels(x,y,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})]);}finally{rendered.image.delete();rendered.surface?.dispose();}
   const sample={producer:native.producer,resources:native.resources.length,hashOnly:native.resources.filter(r=>!r.skp).length,hits:t.recordingCacheHits,misses:t.recordingCacheMisses,encodingMisses:t.recordingEncodingMisses,cachedLayers:t.cachedLayers,indexEnabled:t.recordingIndexEnabled,indexEntries:t.recordingIndexEntries,pool:p,hosts:t.captureHosts,pixels};current.samples.push(sample);
   assert.deepEqual(pixels,[[n&255,(n>>>8)&255,199,255],patch]);return sample;
  };
  await take(first,0);const stable=await take(first,0);assert.ok(stable.hits>0);assert.equal(stable.misses,0);assert.equal(stable.hashOnly,stable.resources);assert.equal(stable.cachedLayers,stable.resources);assert.ok(stable.indexEnabled&&stable.indexEntries>0);
  await first.page.evaluate(()=>window.patch());await delay(50);const solidChanged=await take(first,0,[43,161,89,255]);assert.ok(solidChanged.hits>0,'A Viz solid-color update must preserve the independent image encoding');
  await first.page.evaluate(()=>window.update(1));await delay(30);const changed=await take(first,1,[43,161,89,255]);assert.ok(changed.misses>0,'An actual image recording change must invalidate its encoding key');
  const updatedStable=await take(first,1,[43,161,89,255]);assert.equal(updatedStable.misses,0);
  const popupPromise=context.waitForEvent('page');await first.page.evaluate(url=>window.open(url,'recording-pressure'),origin);const second=await prepare(await popupPromise,false);const denied=await take(second,0);
  assert.equal(denied.producer.split(':')[0],stable.producer.split(':')[0],'Both native owners must actually share the renderer pool');assert.notEqual(denied.producer,stable.producer);assert.equal(denied.indexEnabled,false);assert.equal(denied.pool.bytes,poolLimit);assert.equal(denied.pool.caches,1);assert.ok(denied.pool.denied>0);assert.ok(denied.misses>0);
  const prePressure=await take(first,1,[43,161,89,255]),prePressureStable=await take(first,1,[43,161,89,255]);assert.equal(prePressureStable.misses,0);
  for(let n=1;n<=80;n++){await second.page.evaluate(n=>window.update(n),n);await delay(20);const sample=await take(second,n);assert.equal(sample.indexEnabled,false);}
  const replayed=await take(first,1,[43,161,89,255]);assert.ok(replayed.encodingMisses>0,'Real global encoding eviction must force replay of the current RasterSource');assert.ok(replayed.misses>0);assert.ok(replayed.hosts.evictions>0);
  await closeHandle(first);let recovered;const deadline=Date.now()+5000;do{await delay(30);recovered=await take(second,80);}while(!recovered.indexEnabled&&Date.now()<deadline);
  assert.equal(recovered.indexEnabled,true,'Real compositor destruction must return the64KiB credit');assert.equal(recovered.producer.split(':')[0],denied.producer.split(':')[0]);assert.equal(recovered.pool.caches,1);assert.equal(recovered.pool.bytes,poolLimit);
  const restable=await take(second,80);assert.equal(restable.misses,0);assert.ok(restable.hits>0);assert.equal(restable.hashOnly,restable.resources);
  variants.push({tiled,status:'passed',sameRenderer:true,updates:80,stable,solidChanged,changed,updatedStable,denied,prePressure,prePressureStable,replayed,recovered,restable,samples:current.samples.length,maximumPoolBytes:Math.max(...current.samples.map(s=>s.pool.bytes)),maximumPoolPeak:Math.max(...current.samples.map(s=>s.pool.peak))});
  await closeHandle(second);handles=[];await browser.close();browser=null;await viz.close();viz=null;
 }
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux native Chromium full-layer and256px-tiled captures → real private Viz IPC → Rust Mapper → CPU CanvasKit with exact image/DOM pixels. Scalar recording-index admission is shared by two distinct compositor hosts in the same verified renderer;64KiB exhaustion bypasses caching while preserving content,80noisy image changes cause actual encoded-cache eviction and current-source replay,and actual first-host destruction admits the surviving host without renderer restart. Index owns no raw recording references;active RasterSource/transient recording/serialization,allocator/VM/process/Session memory remain separate.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants};await mkdir(output,{recursive:true});await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,diagnostics:error.captureDiagnostics??null,drivers:handles.map(h=>({label:h.label,closed:h.closed??false,stats:h.driver.stats})),viz:viz?.stats,current,variants},null,2));throw error;}
finally{for(const h of handles)await closeHandle(h).catch(()=>{});await browser?.close();await viz?.close();await new Promise(resolve=>fixture.close(resolve));}
