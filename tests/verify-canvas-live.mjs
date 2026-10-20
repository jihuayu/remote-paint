import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

const output='artifacts/canvas-live',budget=process.env.REMOTE_PAINT_CANVAS_TEST==='pressure',large=process.env.REMOTE_PAINT_CANVAS_TEST==='large';
if(budget)process.env.REMOTE_PAINT_CANVAS_PIXEL_BYTES=String(32*1024*1024);
const palette=['rgb(31,79,191)','rgb(191,61,43)','rgb(43,161,89)'];
const documentFor=path=>`<!doctype html><style>
html,body{margin:0;background:white;overflow:hidden}canvas{position:absolute;left:0;top:0}
#alpha{left:88px;top:16px;width:48px;height:48px;opacity:.5;transform:translate(8px,4px)}
#clip{position:absolute;left:164px;top:8px;width:64px;height:64px;border-radius:16px;overflow:hidden;transform:translateZ(0)}
#clip canvas{width:96px;height:96px}#marker{position:absolute;left:80px;top:0;width:64px;height:64px}
#text{position:absolute;left:8px;top:100px;font:18px Arial;color:#123456}</style>
<canvas id="main" width="64" height="64"></canvas>${path==='/dynamic'?'<div id="marker"></div>':'<canvas id="alpha" width="192" height="192"></canvas><div id="clip"><canvas width="192" height="192"></canvas></div>'}
<div id="text">Canvas + DOM</div><script>
window.ticks=0;window.dynamic=${path==='/dynamic'};const palette=${JSON.stringify(palette)};
const main=document.querySelector('#main'),ctx=main.getContext('2d');
window.paint=()=>{ctx.fillStyle=dynamic?palette[ticks%palette.length]:'rgb(31,79,191)';ctx.fillRect(0,0,main.width,main.height);const marker=document.querySelector('#marker');if(marker)marker.style.background=ctx.fillStyle;};
window.resizeCanvas=size=>{main.width=main.height=size;main.style.width=main.style.height='64px';paint();};
paint();for(const c of document.querySelectorAll('canvas:not(#main)')){const x=c.getContext('2d');x.fillStyle='rgba(0,128,64,.5)';x.fillRect(0,0,c.width,c.height);x.fillStyle='rgba(200,20,40,.75)';x.fillRect(0,0,c.width/2,c.height/2);}
function step(){ticks++;if(dynamic)paint();requestAnimationFrame(step);}requestAnimationFrame(step);window.fixtureReady=true;</script>`;
const fixture=createServer((req,res)=>res.end(documentFor(req.url)));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));await mkdir(output,{recursive:true});
const base=`http://127.0.0.1:${fixture.address().port}`,gate=new LiveFrameGate(),errors=[],pressure=[],history=[],timings=[],navigationInvalidations=[];
const hash=b=>createHash('sha256').update(b).digest('hex'),pixel=(png,x,y)=>[...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
let source,transport,socket,renderer,current,phase='static',progress;
const until=async(check,label)=>{const end=Date.now()+15000;while(!await check()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(10);}};
try{
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 source=await startLiveSource({url:base+'/static',viewport:{width:300,height:180}});
 source.on('captureError',e=>{if(e.code==='RESOURCE_BUDGET_PRESSURE')pressure.push({phase,code:e.code});else if(phase==='navigation'&&/Navigation invalidated|Execution context was destroyed|Cannot find context|Inspected target navigated or closed/.test(e.message)){navigationInvalidations.push({phase,message:e.message,diagnostics:e.captureDiagnostics??null});}else errors.push(e.stack);});
 source.capture.on('capture',native=>{timings.push({phase,...native.timing});if(timings.length>128)timings.shift();});
 const activity=source.acquirePageActivity();await source.page.waitForFunction(()=>window.fixtureReady&&window.ticks>=5);
 transport=await startLiveTransport(source,{port:0});socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',e=>errors.push(e.stack));
 socket.on('message',(bytes,binary)=>{let rendered;try{
  if(binary){const r=decodeResource(bytes);assert.equal(hash(r.payload),r.id);gate.put(r.id,r.payload);return;}
  const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);
  if(m.type==='FrameCommit'){
   const frame=gate.commit(m.pageEpoch,m.frameId,(f,resources)=>{rendered=renderer.render(f.scene,resources,ck.WHITE);current=PNG.sync.read(Buffer.from(rendered.image.encodeToBytes()));});assert.ok(frame);
   history.push({phase,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,canvas:pixel(current,2,2),marker:pixel(current,82,2)});if(history.length>128)history.shift();
   renderer.retain(new Set(frame.requiredResources));gate.collect();
   // ACK only after actual CanvasKit pixels have been read.
   socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));
  }
 }catch(e){errors.push(e.stack);}finally{rendered?.image.delete();rendered?.surface.dispose();}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer}));activity();
 await until(()=>history.length>=4,'initial Canvas pixels');assert.deepEqual(pixel(current,2,2),[31,79,191,255]);
 const reference=PNG.sync.read(await source.page.screenshot());let changed=0;
 for(let i=0;i<reference.data.length;i+=4){let d=0;for(let c=0;c<4;c++)d=Math.max(d,Math.abs(reference.data[i+c]-current.data[i+c]));if(d>24)changed++;}
 const pixelFractionOver24=changed/(reference.width*reference.height);assert.ok(pixelFractionOver24<.04,`Canvas alpha/transform/clip and DOM differ at ${pixelFractionOver24}`);
 for(const [x,y]of [[100,24],[120,56],[166,10],[180,24],[215,58]]){const a=pixel(reference,x,y),b=pixel(current,x,y);assert.ok(a.every((v,i)=>Math.abs(v-b[i])<=3),`Canvas geometry pixel(${x},${y}):${a} vs${b}`);}
 await writeFile(output+'/static-source.png',PNG.sync.write(reference));await writeFile(output+'/static-replay.png',PNG.sync.write(current));
 const native=timings.at(-1);assert.ok(native.canvasCopies>=3);assert.ok(native.canvasMappedCopies+native.canvasGpuReadbacks>=3);assert.ok(native.canvasPixelPool.peak<=native.canvasPixelPool.limit);
 const pid=source.broker.child.pid;
 if(budget){
  phase='pressure';const count=history.length,ticks=await source.page.evaluate(()=>window.ticks);await source.page.evaluate(()=>resizeCanvas(4096));source.requestCapture();
  await until(()=>pressure.length>0,'native pre-copy budget rejection');await delay(150);assert.ok(await source.page.evaluate(()=>window.ticks)>ticks,'Page clock stopped under native pressure');
  phase='recovery';await source.page.evaluate(()=>resizeCanvas(256));source.requestCapture();await until(()=>history.some(x=>x.phase==='recovery'&&x.frameId>history[Math.max(0,count-1)].frameId),'smaller Canvas recovery');
  assert.deepEqual(pixel(current,2,2),[31,79,191,255]);assert.equal(source.broker.child.pid,pid);assert.ok(timings.at(-1).canvasPixelPool.denied>0);assert.ok(timings.at(-1).canvasPixelPool.peak<=32*1024*1024);assert.ok(source.stats.resourcePressureResumes>0);
  progress={pixelFractionOver24,pressureEvents:pressure.length,recovered:true,pidUnchanged:true,native:timings.at(-1),sourceStats:source.stats};
 }else if(large){
  phase='large';const before=history.at(-1).frameId;await source.page.evaluate(()=>resizeCanvas(4096));source.requestCapture();await until(()=>history.some(x=>x.phase==='large'&&x.frameId>before)&&timings.at(-1).canvasPixelPool.peak>=64*1024*1024,'existing64MiB decoded Canvas limit');
  assert.deepEqual(pixel(current,2,2),[31,79,191,255]);assert.equal(timings.at(-1).canvasPixelPool.denied,0);assert.equal(timings.at(-1).canvasPixelPool.bytes,0);assert.equal(timings.at(-1).assetCache.imageEntries,0);
  const largeNative=timings.at(-1);phase='shrink';const last=history.at(-1).frameId;await source.page.evaluate(()=>resizeCanvas(256));source.requestCapture();await until(()=>history.some(x=>x.phase==='shrink'&&x.frameId>last),'large Canvas shrink');progress={pixelFractionOver24,decodedBytes:64*1024*1024,shrank:true,native:largeNative,sourceStats:source.stats};
 }else{
  phase='navigation';const oldEpoch=source.pageEpoch;await until(()=>source.capture.running,'navigation during native capture');await source.page.goto(base+'/dynamic',{waitUntil:'commit'});await source.page.waitForFunction(()=>window.fixtureReady&&window.ticks>=5);assert.equal(source.page.url(),base+'/dynamic');assert.equal(source.browser.isConnected(),true);assert.equal(source.page.isClosed(),false);assert.notEqual(source.targetCrashed,true);assert.ok(navigationInvalidations.length<=3,'Unbounded navigation invalidations');phase='dynamic';source.requestCapture();
  await until(()=>history.filter(x=>x.phase==='dynamic'&&x.pageEpoch>oldEpoch).length>=12,'same-frame animated Canvas and DOM');
  const dynamic=history.filter(x=>x.phase==='dynamic'&&x.pageEpoch>oldEpoch);for(const f of dynamic)assert.deepEqual(f.canvas,f.marker,'Canvas pixels came from a different frame than DOM geometry');assert.ok(new Set(dynamic.map(f=>f.canvas.join(','))).size>=2);
  phase='resize';const version=source.viewportVersion;await source.resize({width:320,height:200});await until(()=>history.some(x=>x.phase==='resize'&&x.viewportVersion>version),'viewport resize');assert.equal(current.width,320);assert.equal(current.height,200);
  progress={pixelFractionOver24,sameFrameSamples:dynamic.length,distinctColors:new Set(dynamic.map(f=>f.canvas.join(','))).size,navigationEpochAdvanced:true,resizeVersionAdvanced:true,navigationInvalidations,native:timings.at(-1),sourceStats:source.stats};
 }
 if(process.env.REMOTE_PAINT_CANVAS_REQUIRE_GPU==='1')assert.ok(timings.some(t=>t.canvasGpuReadbacks>0),'Actual GPU Canvas readback was not exercised');
 assert.deepEqual(errors,[]);const report={at:new Date().toISOString(),status:'passed',mode:budget?'pressure':large?'large':'pixels',scope:'Actual native Chromium Canvas2D capture, Rust Mapper/Gateway and CPU CanvasKit pixels. Static intrinsic/CSS scaling, alpha/opacity, transform, rounded clip, mixed tiled DOM and text; dynamic same-frame pairing or native32MiB pre-copy rejection/recovery. No allSession/VM/eight-hour acceptance.',browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CANVAS_BINARY??process.env.REMOTE_PAINT_CHROMIUM)),launchWrapper:process.env.REMOTE_PAINT_CANVAS_BINARY?{sha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),kind:'test-only ANGLE SwiftShader GPU API path'}:null,brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress,history,timings};
 await writeFile(output+`/${report.mode}-contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,mode:report.mode,...progress}));
}catch(e){await writeFile(output+`/${budget?'pressure':large?'large':'pixels'}-failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:e.stack,errors,phase,history,timings,progress,sourceStats:source?.stats},null,2));throw e;}
finally{socket?.terminate();gate.clear();renderer?.clear();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));}
