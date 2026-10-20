import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {WebSocket} from 'ws';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_LARGE_CACHE_OUTPUT??'artifacts/large-native-cache';
const originalTiled=process.env.REMOTE_PAINT_TILED_CAPTURE,originalPlane=process.env.REMOTE_PAINT_DATA_PLANE;
process.env.REMOTE_PAINT_TILED_CAPTURE='0';delete process.env.REMOTE_PAINT_DATA_PLANE;
let imageBytes=0;const side=2048,colors=Array.from({length:4},(_,n)=>[20+n*50,37,199,255]);
const fixture=createServer((request,response)=>{
 if(request.url.startsWith('/image')){
  const n=Number(new URL(request.url,'http://localhost').searchParams.get('n')),png=new PNG({width:side,height:side});let value=n+1;
  for(let i=0;i<png.data.length;i+=4){value^=value<<13;value^=value>>>17;value^=value<<5;png.data.set([value&255,(value>>>8)&255,(value>>>16)&255,255],i);}
  for(let y=0;y<4;y++)for(let x=0;x<4;x++)png.data.set(colors[n],(y*side+x)*4);
  const bytes=PNG.sync.write(png,{deflateLevel:1,filterType:0});imageBytes+=bytes.length;response.setHeader('Content-Type','image/png');response.end(bytes);return;
 }
 response.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:4096px;height:4096px;overflow:hidden;background:white}img{position:absolute;width:2048px;height:2048px;will-change:transform;transform:translateZ(0);contain:paint}</style>${colors.map((_,n)=>`<img src="/image?n=${n}" style="left:${(n%2)*side}px;top:${Math.floor(n/2)*side}px">`).join('')}`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let source,transport,socket,renderer,out,progress;const errors=[],nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0},nativeFrames=[];
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:4096,height:4096}});source.on('captureError',error=>errors.push(error.message));
 assert.equal(source.nativeAutopublish,true);const request=source.broker.request.bind(source.broker);source.broker.request=(op,args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,args);};const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,args);};source.on('frame',frame=>{nativeFrames.push({...frame});assert.ok(nativeFrames.length<64,'Verifier nativeevent retention cap');});
 const loading=source.acquirePageRun();try{await source.page.waitForFunction(()=>document.images.length===4&&[...document.images].every(i=>i.complete&&i.naturalWidth===2048),null,{timeout:120000});}finally{loading();}
 transport=await startLiveTransport(source,{port:0});const gate=new LiveFrameGate();let resolveFrame,rejectFrame;
 const frame=new Promise((resolve,reject)=>{resolveFrame=resolve;rejectFrame=reject;}),timer=setTimeout(()=>rejectFrame(new Error('Large native frame transport deadline')),120000);
 socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',rejectFrame);
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);gate.put(item.id,item.payload);return;}
  const message=JSON.parse(bytes);
  if(message.type==='CaptureError')throw new Error(message.message);
  if(message.type==='SceneUpdate')gate.stage(message.frame);
  if(message.type==='FrameCommit'){const committed=gate.commit(message.pageEpoch,message.frameId);assert.ok(committed);clearTimeout(timer);resolveFrame(committed);}
 }catch(error){clearTimeout(timer);rejectFrame(error);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer}));
 const received=await frame,rawBytes=received.requiredResources.reduce((n,id)=>n+gate.resources.get(id).length,0);assert.ok(rawBytes*3>128*1024*1024,'Genuine native working set did not exceed the old three-copy cache target');
 assert.equal(rawBytes,57802256);assert.equal(received.requiredResources.length,4);
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 const started=performance.now();out=renderer.render(received.scene,gate.resources,ck.WHITE);const pixels=[];
 for(let n=0;n<4;n++){const x=(n%2)*side+2,y=Math.floor(n/2)*side+2;const rgba=[...out.image.readPixels(x,y,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(rgba,colors[n]);pixels.push({x,y,rgba});}
 const replayMs=performance.now()-started;socket.send(JSON.stringify({type:'FrameAck',pageEpoch:received.pageEpoch,frameId:received.frameId,stage:'scene-submitted'}));
 const before=await source.broker.request('mapperStats'),captures=source.stats.captures;
 source.requestCapture();const end=Date.now()+15000;while(source.stats.captures<=captures){assert.ok(Date.now()<end,'Hash-only native follow-up deadline');await new Promise(resolve=>setTimeout(resolve,10));}
 const after=await source.broker.request('mapperStats');for(const value of [before,after]){assert.ok(value.cacheBytes<=value.cacheByteLimit);assert.ok(value.resources<=value.cacheEntryLimit);assert.ok(value.referenceIndexEntries<=value.referenceIndexLimit);assert.ok(value.chunkIndexEntries<=value.chunkIndexLimit);}
 const followUp=nativeFrames.find(f=>f.native.captureOrdinal>received.native.captureOrdinal&&f.rawResourceBytes===0);assert.ok(followUp,'Native follow-up did not reuse hash-only resource references');assert.equal(followUp.sceneResourceCount,4);assert.equal(Object.hasOwn(source.latest,'payloads'),false);assert.equal(Object.hasOwn(source.latest,'scene'),false);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});
 assert.ok(after.cacheEvictions>0);assert.equal(source.stats.resourceRecoveries,0);assert.deepEqual(errors,[]);
 progress={imageBytes,rawBytes,resources:received.requiredResources.length,pixels,replayMs,before,after,followUpCaptures:source.stats.captures-captures,resourceRecoveries:source.stats.resourceRecoveries,nodeCalls,nativeFrames,hashOnlyOrdinal:followUp.native.captureOrdinal,nativeAutopublish:true,tiled:false};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Chromium non-tiled native RPA capture of four2048² noisy PNG layers → Rust Gateway raw-resource path → validating FrameGate → CanvasKit CPU scene replay and four actual pixels. Genuine SKPs plus three-copy working set exceed128MiB; strong cache and weak indexes remain bounded, snapshots still deliver every resource and hash-only follow-up recovers without a false resource miss. This does not certify all snapshot/transport allocation reservations or process/RSS budgets.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),...progress,errors};
 await mkdir(output,{recursive:true});await writeFile(`${output}/replay.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,imageBytes,errors,nodeCalls,nativeFrames,sourceStats:source?.stats},null,2));throw error;}
finally{
 out?.image.delete();out?.surface?.dispose();renderer?.clear();socket?.terminate();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));
 if(originalTiled===undefined)delete process.env.REMOTE_PAINT_TILED_CAPTURE;else process.env.REMOTE_PAINT_TILED_CAPTURE=originalTiled;
 if(originalPlane===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=originalPlane;
}
