// Five explicit empty diagnostic maps displace history without revoking the
// actual native subscription. No Gateway/peer pins exist during this fault.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createControl} from '../live/input.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
import {observeFrameLoss} from './frame-age-observer.mjs';

assert.equal(process.platform,'linux');
const drainableLoss=process.env.REMOTE_PAINT_SOURCE_LOSS_DRAIN==='1',lossDrains=[];
const output=process.env.REMOTE_PAINT_SOURCE_HASH_RETRY_OUTPUT??'artifacts/native-source-hash-retry';
await mkdir(output,{recursive:true});
const blue=[31,79,191,255],green=[43,161,89,255],png=new PNG({width:32,height:32});
for(let i=0;i<png.data.length;i+=4)png.data.set(blue,i);
const image=PNG.sync.write(png);
const fixture=createServer((req,res)=>{
 if(req.url==='/image'){res.setHeader('Content-Type','image/png');res.end(image);return;}
 res.end('<!doctype html><style>html,body{margin:0;overflow:hidden;background:white}img,#match{position:absolute;top:0;width:32px;height:32px}#match{left:64px;background:rgb(31,79,191);will-change:background-color}</style><img src=/image><div id=match></div><script>window.addEventListener("keydown",()=>document.querySelector("#match").style.backgroundColor="rgb(43,161,89)");</script>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const events=[],frames=[],errors=[],checks=[],diagnostics={},nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};
const gate=new LiveFrameGate({requireResourceMemory:true}),hash=b=>createHash('sha256').update(b).digest('hex');
let source,transport,socket,renderer,phase='startup',failure,closing=false,lossObservation,lossBefore,lossAfter;
async function until(fn,label){
 const deadline=Date.now()+12000;
 while(!await fn()){assert.deepEqual(errors,[]);assert.ok(Date.now()<deadline,`Native hash retry deadline: ${label}`);await delay(5);}
}
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:320,height:180}});
 assert.equal(source.nativeAutopublish,true);source.on('captureError',e=>errors.push(e.message));lossObservation=observeFrameLoss(source,undefined,{drainable:drainableLoss});
 source.broker.on('event',e=>{
  if(['NativeFrame','NativeFrameRejected'].includes(e.event)){events.push({phase,at:performance.now(),...e});assert.ok(events.length<64);}
 });
 const request=source.broker.request.bind(source.broker);source.broker.request=(op,args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,args);};
 const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,args);};
 const loading=source.acquirePageRun();try{await source.page.waitForFunction(()=>document.images[0].complete&&document.images[0].naturalWidth===32);}finally{loading();}
 source.setDemand(1);await until(()=>events.some(e=>e.event==='NativeFrame'&&e.resourcesComplete&&e.rawResourceBytes>0)&&!source.transitioning,'initial full native image');
 source.control=await createControl(source);
 const grant=await source.control.acquire('hash-retry-human',{sessionId:source.control.sessionId,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});
 for(const type of ['keyDown','keyUp']){
  const seq=source.control.nextSeq;assert.equal((await source.control.input('hash-retry-human',{...grant,seq,event:{kind:'key',type,key:'1',code:'Digit1',windowsVirtualKeyCode:49}})).accepted,true);
 }
 await until(()=>events.some(e=>e.event==='NativeFrame'&&e.inputSeq===2&&!e.resourcesComplete&&e.rawResourceBytes===0&&e.sceneResources>0),'input2 genuine hash-only frame');
 await source.capture.work;
 let native;await until(async()=>{native=await source.capture.command('inspect',source.capture.binding.config.id);return !native.inflight;},'actual Chromium credit drain');
 await source.frameDriver.stop();
 const binding={...source.capture.binding.config},documentToken=source.nativeDocumentToken,latest=source.latest,eventCount=events.length;
 assert.equal(source.capture.forceResources,false);assert.equal(source.capture.enabled,true);assert.equal(source.capture.suspensions,0);
 diagnostics.before={native,binding,latest,mapper:await source.broker.request('mapperStats')};assert.ok(diagnostics.before.mapper.resources>0);
 checks.push('actual PNG produces full bytes then hash-only native frames with real key input watermark2; Chromium credit drains before the diagnostic clock pause');

 phase='diagnostic-eviction';
 for(let n=0;n<5;n++){
  const captureId='hash-retry-diagnostic-'+n;
  await source.broker.request('map',{capture:{captureId,producer:'hash-retry-diagnostic',resources:[],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:[0,0,320,180],quads:[]}]}},metadataOnly:true,epoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,viewport:{...source.viewport}});
 }
 diagnostics.evicted={budget:await source.broker.request('resourceBudget'),mapper:await source.broker.request('mapperStats')};
 assert.equal(events.length,eventCount,'A native frame raced the diagnostic eviction');
 assert.equal(diagnostics.evicted.mapper.resources,0);assert.equal(diagnostics.evicted.mapper.referenceIndexEntries,0);assert.equal(diagnostics.evicted.budget.bytes,0);
 assert.equal(source.latest,latest);assert.equal(source.capture.binding.config.id,binding.id);assert.equal(source.capture.forceResources,false);assert.equal(source.capture.enabled,true);assert.equal(source.capture.binding.registered,true);assert.equal(source.capture.suspensions,0);assert.equal(source.stats.resourceRecoveries,0);
 checks.push('five explicit metadata-only empty diagnostic maps replace history; normal resourceBudget reclamation releases all old Broker resource owners while the same native subscription remains enabled and no full-resource control is sent');

 phase='autonomous-retry';lossBefore=lossObservation.snapshot();const retryStart=performance.now(),evaluations=nodeCalls.evaluate;
 source.frameDriver.start();
 await until(()=>events.some(e=>e.phase===phase&&e.event==='NativeFrameRejected'&&e.reason==='Incremental native resource cache miss'&&e.outcome==='retry'),'actual native Mapper cache miss');
 const rejected=events.find(e=>e.phase===phase&&e.event==='NativeFrameRejected');
 assert.ok(rejected.captureId.startsWith(binding.id+':'));
 const rejectedOrdinal=Number(rejected.captureId.slice(binding.id.length+1));assert.ok(Number.isSafeInteger(rejectedOrdinal));
 await until(()=>events.some(e=>e.phase===phase&&e.event==='NativeFrame'&&e.captureOrdinal>rejectedOrdinal&&e.resourcesComplete&&e.rawResourceBytes>0&&e.inputSeq===2),'real Retry credit forces full resource resend');
 const recovered=events.find(e=>e.phase===phase&&e.event==='NativeFrame'&&e.captureOrdinal>rejectedOrdinal&&e.resourcesComplete&&e.rawResourceBytes>0);
 assert.equal(recovered.scopeId,binding.id);assert.equal(recovered.generation,binding.generation);assert.equal(recovered.pageEpoch,1);assert.equal(recovered.viewportVersion,1);assert.equal(recovered.inputSeq,2);assert.equal(source.nativeDocumentToken,documentToken);assert.equal(source.capture.binding.config.id,binding.id);assert.equal(source.stats.resetRequests,0);assert.equal(source.stats.resourceRecoveries,1);assert.equal(source.stats.errors,0);
 await until(()=>events.some(e=>e.phase===phase&&e.event==='NativeFrame'&&e.captureOrdinal>recovered.captureOrdinal&&!e.resourcesComplete&&e.rawResourceBytes===0&&e.sceneResources>0),'post-retry hash-only reuse');
 assert.equal(nodeCalls.evaluate,evaluations,'Autonomous retry issued a Node native control evaluation');
 diagnostics.retry={rejected,recovered,ms:recovered.at-retryStart,controlEvaluations:nodeCalls.evaluate-evaluations,stats:{...source.stats}};
 checks.push('same-scope real native hash miss receives Retry; Chromium autonomously resends full resources and returns to hash-only reuse without Node Runtime.evaluate, reset, rebind or explicit fresh/full request; epoch1/viewport1/input2 persist');

 phase='pixels';
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 transport=await startLiveTransport(source,{port:0});
 socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});
 socket.on('error',e=>errors.push(e.message));socket.on('close',(code,reason)=>{if(!closing)errors.push(`Unexpected peer close ${code} ${reason}`);});
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const resource=decodeResource(bytes);assert.equal(hash(resource.payload),resource.id);gate.put(resource.id,resource.payload);return;}
  const message=JSON.parse(bytes);
  if(message.type==='ResourceRelease'){for(const id of message.ids)gate.release(id);renderer.retain(new Set(gate.resources.keys()));return;}
  if(message.type==='SceneUpdate'){gate.stage(message.frame);return;}
  if(message.type==='FrameCommit'){
   const frame=gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);const out=renderer.render(frame.scene,gate.resources,ck.WHITE,frame.resourceMemory?.resources);
   let imagePixel,domPixel;try{const pixel=x=>[...out.image.readPixels(x,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];imagePixel=pixel(8);domPixel=pixel(72);}finally{out.image.delete();out.surface?.dispose();}
   assert.deepEqual(imagePixel,blue);assert.deepEqual(domPixel,green);assert.equal(frame.lastProcessedInputSeq,2);assert.equal(frame.pageEpoch,1);assert.equal(frame.viewportVersion,1);assert.ok(frame.native.captureId.startsWith(binding.id+':'));assert.ok(frame.native.captureOrdinal>=recovered.captureOrdinal);
   frames.push({native:frame.native,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,inputSeq:frame.lastProcessedInputSeq,imagePixel,domPixel,resources:frame.requiredResources.length});assert.ok(frames.length<32);
   socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));
  }
 }catch(e){errors.push(e.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['frame-window-v1','resource-memory-v1'],frameWindow:1}));await until(()=>frames.length>0,'Gateway real CanvasKit image/DOM pixels');
 assert.equal(Object.hasOwn(source.latest,'scene'),false);assert.equal(Object.hasOwn(source.latest,'payloads'),false);assert.equal(source.stats.resourceRecoveries,1);assert.equal(source.stats.resetRequests,0);assert.equal(source.stats.errors,0);assert.deepEqual(errors,[]);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:5,publish:0,awaitPromise:0});
 lossAfter=lossObservation.snapshot();assert.equal(lossObservation.rejections.length,1);const observed=lossObservation.rejections[0];assert.equal(observed.captureId,rejected.captureId);assert.equal(observed.code,rejected.code);assert.equal(observed.reason,rejected.reason);assert.equal(observed.outcome,'retry');assert.equal(observed.captureOrdinal,rejectedOrdinal);assert.equal(observed.matchedActiveScope,true);assert.equal(lossBefore.rejectionCount,0);assert.equal(lossAfter.rejectionCount,1);assert.equal(lossAfter.source.resourceRecoveries,1);
 if(drainableLoss){const first=lossObservation.drain();assert.equal(first.windowOrdinal,1);assert.equal(first.rejections.length,1);assert.equal(first.rejections[0].captureId,rejected.captureId);assert.equal(first.rejections[0].observationOrdinal,1);assert.equal(first.rejectionCount,1);assert.equal(lossObservation.rejections.length,0);const empty=lossObservation.drain();assert.equal(empty.windowOrdinal,2);assert.equal(empty.rejections.length,0);assert.equal(empty.rejectionCount,1);assert.equal(empty.afterObservationOrdinal,1);assert.equal(empty.throughObservationOrdinal,1);assert.equal(lossObservation.snapshot().rejectionCount,1);lossDrains.push(first,empty);}
 diagnostics.finalStats={...source.stats};checks.push('recovered resources reach the real Gateway, FrameGate and CanvasKit: blue PNG and key-updated green DOM pixels match with input2; Source keeps only scalar native metadata');
}catch(e){failure=e.stack;}
finally{
 lossObservation?.close();closing=true;socket?.terminate();renderer?.clear();gate.clear();await transport?.close().catch(()=>{});await source?.control?.close().catch(()=>{});await source?.close().catch(()=>{});await new Promise(resolve=>fixture.close(resolve));
}
const cleanup={brokerExited:source?.broker.exited,pending:source?.broker.pending.size,requestOwners:source?.broker.requestMemory.stats().owners,responseOwners:source?.broker.responses.stats().owners};
if(!failure)try{assert.deepEqual(cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0});}catch(e){failure=e.stack;}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual default NativeSource/real PNG/native hash-only cache miss/real Retry credit/full resend/Gateway/CanvasKit image and DOM pixels. Five explicit empty diagnostic maps and normal resourceBudget reclamation induce the fault before Gateway/peer pins exist; this is not organic workload eviction or a reset. All production limits and binaries unchanged; no full B1/process-memory claim.',browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),phase,checks,nodeCalls,events,frames,diagnostics,errors,cleanup,lossMetrics:{drainable:drainableLoss,drains:lossDrains,before:lossBefore,after:lossAfter,nativeRejections:lossObservation?.rejections,scope:'ActualNativeFrameRejectedidentity/code/outcome/parsedcaptureOrdinal/currentbindingmatchplusNodeSourcewitness;explicitdiagnosticeviction,notorganicnetworkloss.'},...(failure?{error:failure}:{})};
await writeFile(output+'/retry.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,nodeCalls,retry:diagnostics.retry,cleanup,error:failure}));if(failure)throw new Error(failure);
