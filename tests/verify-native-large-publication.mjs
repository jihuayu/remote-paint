// Real native subscription large-resource publication; no Source map/publish path.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import CanvasKitInit from 'canvaskit-wasm/full';
import {PNG} from 'pngjs';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_NATIVE_LARGE_OUTPUT??'artifacts/native-large-publication';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-native-large-'),endpoint=directory+'/viz.sock',token=randomBytes(32).toString('hex'),id=randomBytes(16).toString('hex');
const oldTiled=process.env.REMOTE_PAINT_TILED_CAPTURE;process.env.REMOTE_PAINT_TILED_CAPTURE='0';
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

const broker=new NativeBroker(),events=[],peerEvents=[],errors=[],counts={evaluate:0,awaitPromise:0,map:0,publish:0};let eventCount=0,firstFull,hashOnly,resourceRecoveries=0,socketClosed,closing=false,brokerStderr;
const original=broker.request.bind(broker);broker.request=(op,args)=>{if(op==='map'||op==='publish')counts[op]++;return original(op,args);};
broker.on('event',e=>{if(['PeerReady','PeerClosed','PeerStats'].includes(e.event)){peerEvents.push(e);if(peerEvents.length>8)peerEvents.shift();}if(e.event==='NativeFrame'||e.event==='NativeFrameRejected'){
 eventCount++;events.push(e);if(events.length>32)events.shift();
 if(e.event==='NativeFrame'){if(e.rawResourceBytes>0&&e.resourcesComplete)firstFull??=e;if(e.captureOrdinal>1&&e.rawResourceBytes===0)hashOnly??=e;}
 else{if(/cache miss/.test(e.reason))resourceRecoveries++;if(e.code!=='VIZ_CAPTURE_SUPERSEDED'&&errors.length<4)errors.push(e.reason);}
}});broker.on('failure',e=>errors.push(e.message));
let browser,page,driver,cdp,world,socket,renderer,out,first,bound,progress,failure;
const clean=s=>String(s).replaceAll(token,'[redacted]');
const until=async(fn,label)=>{const end=Date.now()+120000;while(!await fn()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(10);}};
async function control(op,...args){counts.evaluate++;const r=await cdp.send('Runtime.evaluate',{contextId:world,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[token,op,id,...args].map(JSON.stringify).join(',')})`,returnByValue:true});if(r.exceptionDetails)throw new Error(clean(r.exceptionDetails.exception?.description??r.exceptionDetails.text));return r.result.value;}
try{
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 await broker.request('listenViz',{path:endpoint});const origin='http://127.0.0.1',key=randomBytes(16).toString('hex'),rendererInfo={};
 const {port}=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key,renderer:rendererInfo,producer:'native-large-publication-test',sessionId:'native-large-publication-test'}});
 const gate=new LiveFrameGate();socket=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${key}`,{origin});socket.on('error',e=>errors.push(clean(e.message)));socket.on('close',(code,reason)=>{socketClosed={code,reason:reason.toString()};if(!closing)errors.push(`Gateway closed: ${code} ${reason}`);});
 socket.on('message',(bytes,binary)=>{try{if(binary){const item=decodeResource(bytes);gate.put(item.id,item.payload);return;}const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);if(m.type==='FrameCommit'){const frame=gate.commit(m.pageEpoch,m.frameId);assert.ok(frame);if(!first)first=frame;socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));}}catch(e){errors.push(clean(e.stack));}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:rendererInfo}));
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});
 page=await browser.newPage({viewport:{width:4096,height:4096}});driver=await startBeginFrames(page);await page.goto(`http://127.0.0.1:${fixture.address().port}`);await page.waitForFunction(()=>document.images.length===4&&[...document.images].every(i=>i.complete&&i.naturalWidth===2048),null,{timeout:120000});
 // A compositor animation produces later frames without changing recordings
 // or issuing per-frame capture requests. Samples remain inside solid patches.
 await page.addStyleTag({content:'img:first-of-type{animation:native-large .2s infinite alternate linear}@keyframes native-large{from{transform:translateX(0)}to{transform:translateX(.125px)}}'});await driver.requestNow();
 cdp=await page.context().newCDPSession(page);const {frameTree}=await cdp.send('Page.getFrameTree');world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-native-large-test'})).executionContextId;
 if(process.env.REMOTE_PAINT_LARGE_DOCUMENT_BIND==='1'){
  const document=await control('describe');assert.equal(document.cadenceVersion,1);
  bound=await control('bindDocument',document.documentToken,1,1,0,4096,4096,0);
  assert.equal(bound.intervalMicros,16667);assert.equal(bound.heartbeatMicros,1000000);
 }else bound=await control('bind',1,1,0,4096,4096,0);
 assert.equal(bound.ok,true,JSON.stringify(bound));await broker.request('registerNative',{config:bound});assert.equal((await control('enable',true)).ok,true);const initial=counts.evaluate;
 await until(()=>first,'large autonomous Gateway scene');const rawBytes=first.requiredResources.reduce((n,id)=>n+gate.resources.get(id).length,0);assert.equal(rawBytes,57802256);assert.equal(first.requiredResources.length,4);
 out=renderer.render(first.scene,gate.resources,ck.WHITE);const pixels=[];
 for(let n=0;n<4;n++){const x=(n%2)*side+2,y=Math.floor(n/2)*side+2;const rgba=[...out.image.readPixels(x,y,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(rgba,colors[n]);pixels.push({x,y,rgba});}
 await until(()=>firstFull&&hashOnly,'initialfullresource andhash-only autonomous follow-up');
 // The native plane can include unreferenced recording blocks. The actual
 // delivered scene above must still contain exactly four SKPs/57,802,256B.
 assert.ok(firstFull.rawResourceBytes>=rawBytes);assert.ok(firstFull.rawResourceCount>=4);assert.equal(firstFull.sceneResources,4);
 assert.equal(counts.evaluate,initial);assert.equal(counts.map,0);assert.equal(counts.publish,0);assert.equal(counts.awaitPromise,0);
 assert.equal(resourceRecoveries,0);
 await broker.request('nativePolicy',{scopeId:id,inputSeq:0,enabled:false});await control('enable',false);await until(async()=>!(await control('inspect')).inflight,'native pause drains');
 progress={imageBytes,rawBytes,pixels,resources:first.requiredResources.length,resourceRecoveries,counts,mapper:await broker.request('mapperStats')};assert.deepEqual(errors,[]);
}catch(e){failure=clean(e.stack);}
finally{closing=true;brokerStderr=clean(broker.stderr);out?.image.delete();out?.surface?.dispose();renderer?.clear();await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});socket?.terminate();await broker.close();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});if(oldTiled===undefined)delete process.env.REMOTE_PAINT_TILED_CAPTURE;else process.env.REMOTE_PAINT_TILED_CAPTURE=oldTiled;}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Linux Chromium non-tiled native subscription → privateUnix → autonomousBrokerMapper/Gateway → CanvasKit fouractualpixels;57,802,256bytes/fourSKPs/hash-onlyfollow-up/zeroRecovery/zero per-framecaptureCDP ormap/publishRPC. Explicit test lifecycle;notdefaultSource,fullSessionRSS orallB1acceptance.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),documentCadenceBinding:process.env.REMOTE_PAINT_LARGE_DOCUMENT_BIND==='1',...progress,peerEvents,socketClosed,brokerStderr,eventCount,events,firstFull,hashOnly,clock:driver?.stats,errors,cleanup:{exited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners},...(failure?{error:failure}:{})};await writeFile(output+'/large.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,rawBytes:progress?.rawBytes,pixels:progress?.pixels,counts,error:failure}));if(failure)throw new Error(failure);
