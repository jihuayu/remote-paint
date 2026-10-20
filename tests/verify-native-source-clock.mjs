// Native capture-start metadata provenance, not end-to-end frame-age proof.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createControl} from '../live/input.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

assert.equal(process.platform,'linux');assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
const output=process.env.REMOTE_PAINT_SOURCE_CLOCK_OUTPUT??'artifacts/native-source-clock';await mkdir(output,{recursive:true});
const clock='chromium-time-ticks-v1',colors=[[31,79,191,255],[43,161,89,255]],hash=b=>createHash('sha256').update(b).digest('hex');
const fixture=createServer((req,res)=>res.end('<!doctype html><style>body{margin:0;background:white}canvas,#match{position:absolute;top:0;width:32px;height:32px}#match{left:64px}</style><canvas width=32 height=32></canvas><div id=match></div><script>window.paint=n=>{const color=["rgb(31,79,191)","rgb(43,161,89)"][n],ctx=document.querySelector("canvas").getContext("2d");ctx.fillStyle=color;ctx.fillRect(0,0,32,32);document.querySelector("#match").style.backgroundColor=color;};paint(0);window.onkeydown=()=>paint(1);</script>'));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const frames=[],errors=[],checks=[],witnesses=[],calibrations=[],nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0},lastByProducer=new Map(),gate=new LiveFrameGate({requireResourceMemory:true});
let source,transport,socket,renderer,welcome,phase='startup',closing=false,failure,sourceStats;
async function until(fn,label){const end=performance.now()+12000;while(!await fn()){assert.deepEqual(errors,[]);assert.ok(performance.now()<end,label);await delay(3);}}
async function probe(label){
 const samples=[];
 for(let n=0;n<12;n++){
  const before=performance.now(),r=await source.capture.command('scheduler',source.capture.binding.config.id),after=performance.now();
  assert.equal(r.ok,true);assert.equal(r.clock,clock);assert.ok(Number.isSafeInteger(r.nowMicros)&&r.nowMicros>0);assert.ok(Number.isInteger(r.rendererProcessId)&&r.rendererProcessId>0);
  if(samples.length){assert.equal(r.rendererProcessId,samples[0].pid);assert.ok(r.nowMicros>=samples.at(-1).producerMicros);}
  samples.push({before,after,roundTripMs:after-before,pid:r.rendererProcessId,producerMicros:r.nowMicros,offsetLowerMs:before-r.nowMicros/1000,offsetUpperMs:after-r.nowMicros/1000});
 }
 const best=samples.reduce((a,b)=>a.roundTripMs<b.roundTripMs?a:b),c={label,clock,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,samples,best};calibrations.push(c);return c;
}
try{
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:320,height:180}});assert.equal(source.nativeAutopublish,true);source.on('captureError',e=>errors.push(e.message));
 const request=source.broker.request.bind(source.broker);source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
 source.control=await createControl(source);transport=await startLiveTransport(source,{port:0});
 socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',e=>errors.push(e.message));socket.on('close',(code,reason)=>{if(!closing)errors.push(`Unexpected Gateway close ${code}: ${reason}`);});
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const r=decodeResource(bytes);assert.equal(hash(r.payload),r.id);gate.put(r.id,r.payload);return;}
  const m=JSON.parse(bytes);if(m.type==='Welcome'){welcome=m;return;}if(m.type==='ResourceRelease'){for(const id of m.ids)gate.release(id);renderer.retain(new Set(gate.resources.keys()));return;}if(m.type==='SceneUpdate'){gate.stage(m.frame);return;}
  if(m.type==='FrameCommit'){
   const f=gate.commit(m.pageEpoch,m.frameId);assert.ok(f);const timing=f.native.timing;assert.equal(timing.captureClock,clock);assert.ok(Number.isSafeInteger(timing.captureStartedMicros)&&timing.captureStartedMicros>0);
   const previous=lastByProducer.get(f.native.producer);if(previous){assert.ok(f.native.captureOrdinal>previous.ordinal);assert.ok(timing.captureStartedMicros>previous.started);}
   lastByProducer.set(f.native.producer,{ordinal:f.native.captureOrdinal,started:timing.captureStartedMicros});
   const out=renderer.render(f.scene,gate.resources,ck.WHITE,f.resourceMemory?.resources);let canvas,dom;
   try{const pixel=x=>[...out.image.readPixels(x,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];canvas=pixel(8);dom=pixel(72);}finally{out.image.delete();out.surface?.dispose();}
   assert.deepEqual(canvas,dom);const color=colors.findIndex(c=>JSON.stringify(c)===JSON.stringify(canvas));assert.ok(color>=0);
   frames.push({phase,observedNodeMs:performance.now(),producer:f.native.producer,pageEpoch:f.pageEpoch,viewportVersion:f.viewportVersion,width:f.viewport.cssWidth,ordinal:f.native.captureOrdinal,sourceFrame:f.native.sourceFrame,inputSeq:f.lastProcessedInputSeq,startedMicros:timing.captureStartedMicros,color,canvas,dom});assert.ok(frames.length<128);
   socket.send(JSON.stringify({type:'FrameAck',pageEpoch:f.pageEpoch,frameId:f.frameId,stage:'scene-submitted'}));
  }
 }catch(e){errors.push(e.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['frame-window-v1','resource-memory-v1'],frameWindow:6}));await until(()=>welcome&&frames.length&&!source.transitioning,'first real native clock/pixels');
 const before=await probe('initial');assert.equal(frames.at(-1).producer.split(':')[0],String(before.best.pid));assert.ok(frames[0].startedMicros<=before.samples[0].producerMicros);checks.push('actual native Take timestamp survives RPA/Broker/Gateway/FrameGate and CanvasKit pixels;private currentclock reportsmatching renderer identity');
 phase='exact-witness';
 for(let n=0;n<8&&witnesses.length<3;n++){
  const ordinal=frames.at(-1).ordinal;source.requestFreshFrame();await until(()=>frames.at(-1).ordinal>ordinal,'new actual capture');
  const state=await source.capture.command('inspect',source.capture.binding.config.id),f=frames.find(f=>f.ordinal===state.lastStarted);
  if(f){assert.equal(f.startedMicros,state.lastStartedMicros);witnesses.push({ordinal:f.ordinal,producer:f.producer,publicMicros:f.startedMicros,privateTakeMicros:state.lastStartedMicros});}
 }
 assert.equal(witnesses.length,3);checks.push('three exact ordinal matches prove public captureStartedMicros equals private native lastStartedMicros,without reconstructing start from encode durations');
 phase='input';const grant=await source.control.acquire(welcome.peerId,{sessionId:source.control.sessionId,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});
 for(const type of ['keyDown','keyUp']){const seq=source.control.nextSeq;assert.equal((await source.control.input(welcome.peerId,{...grant,seq,event:{kind:'key',type,key:'1',code:'Digit1',windowsVirtualKeyCode:49}})).accepted,true);}
 await until(()=>frames.some(f=>f.phase==='input'&&f.color===1&&f.inputSeq===2),'input2 actual timestamped green pixels');checks.push('real CDP input watermark and changed Canvas/DOM pixels retain per-job timestamp');
 phase='paused';await source.capture.suspend();const pausedCount=frames.length;await delay(50);const stableCount=frames.length;for(let n=0;n<8;n++)source.requestFreshFrame();await delay(120);assert.equal(frames.length,stableCount);const pausedProbe=await probe('paused');
 phase='resumed';const resumeFloor=pausedProbe.samples.at(-1).producerMicros;source.capture.resume();await until(()=>frames.some(f=>f.phase==='resumed'&&f.color===1&&f.startedMicros>=resumeFloor),'resume uses newly admitted capture start');checks.push('pause drains encoding;fresh requests while paused do not create frames,resume never reuses an earlier capture timestamp');
 phase='resized';await source.resize({width:384,height:200});await until(()=>frames.some(f=>f.phase==='resized'&&f.width===384&&f.viewportVersion===2&&f.color===1&&f.inputSeq===2),'resized timestamp/pixels');await probe('resized');checks.push('actual resize viewport2/input2 and pixel identity keep native clock provenance');
 phase='navigated';const oldEpoch=source.pageEpoch,oldOrdinal=frames.at(-1).ordinal;await source.page.goto(`http://localhost:${fixture.address().port}/next`,{waitUntil:'commit'});
 await until(()=>frames.some(f=>f.phase==='navigated'&&f.pageEpoch===oldEpoch+1&&f.ordinal>oldOrdinal&&f.color===0),'new document epoch/timestamp/blue pixels');const navigated=await probe('new-document');assert.equal(frames.at(-1).producer.split(':')[0],String(navigated.best.pid));checks.push('crosssite document replacement renews target epoch and validates clock calibration against the new actual rendererPID');
 phase='reset';const epoch=source.pageEpoch,resetOrdinal=frames.at(-1).ordinal;await source.broker.reset();await until(()=>frames.some(f=>f.phase==='reset'&&f.pageEpoch===epoch&&f.ordinal>resetOrdinal&&f.color===0),'reset rebind keeps epoch/clock/pixels');await probe('after-reset');checks.push('real Broker reset/rebind keeps document epoch and fresh ordinal/timestamped pixels;no synthetic reset-as-cache-miss claim');
 assert.equal(source.stats.errors,0);assert.deepEqual(errors,[]);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});sourceStats=structuredClone(source.stats);
}catch(e){failure=e.stack;}
finally{
 closing=true;socket?.terminate();renderer?.clear();gate.clear();const cleanupErrors=[];for(const close of [()=>transport?.close(),()=>source?.control?.close(),()=>source?.close()])try{await close();}catch(e){cleanupErrors.push(e.message);}if(cleanupErrors.length)failure??=cleanupErrors.join('; ');await new Promise(resolve=>fixture.close(resolve));
}
const cleanup={brokerExited:source?.broker.exited,pending:source?.broker.pending.size,requestOwners:source?.broker.requestMemory.stats().owners,responseOwners:source?.broker.responses.stats().owners,browserConnected:source?.browser.isConnected()};
try{assert.deepEqual(cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0,browserConnected:false});}catch(e){failure??=e.stack;}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual default autonomous NativeSource/fixed native Take timestamp/private currentTimeTicks probe/real Gateway+FrameGate+CanvasKit pixels/input/pause/resume/resize/crosssite navigation/reset and cleanup. Calibration probe bounds are raw provenance,not completed frame-age measurements;no claim for Viewer Worker/physical scanout/fullN1/8h.',versions:{browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))},phase,checks,witnesses,calibrations,nodeCalls,frames,errors,sourceStats,cleanup,...(failure?{error:failure}:{})};
await writeFile(output+'/clock.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,witnesses:witnesses.length,frames:frames.length,nodeCalls,error:failure}));if(failure)throw new Error(failure);
