// Real native scheduler/CC damage/credit/Gateway/pixels. This deliberately
// uses lifecycle controls; the default Source adapter is verified separately.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_CADENCE_OUTPUT??'artifacts/native-cadence';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-cadence-'),endpoint=directory+'/viz.sock',token=randomBytes(32).toString('hex');let id=randomBytes(16).toString('hex');
const palette=[[31,79,191,255],[43,161,89,255],[197,53,113,255]];
const fixture=createServer((req,res)=>res.end(`<!doctype html><style>html,body{margin:0;overflow:hidden;background:white}canvas,#match{position:absolute;top:0;width:32px;height:32px}#match{left:64px;will-change:background-color}p{position:absolute;top:40px;font:24px Arial;color:#123456}</style><canvas width=32 height=32></canvas><div id=match></div><p>Native cadence <span>0</span></p><script>window.animating=true;window.ticks=0;const ctx=document.querySelector('canvas').getContext('2d');window.paint=n=>{const rgb=[[31,79,191],[43,161,89],[197,53,113]][n],c='rgb('+rgb+')';ctx.fillStyle=c;ctx.fillRect(0,0,32,32);document.querySelector('#match').style.backgroundColor=c;document.querySelector('span').textContent=++ticks;};function draw(){if(!animating)return;paint(ticks%3);requestAnimationFrame(draw);}draw();window.stop=()=>{animating=false;paint(1);};</script>`));
const broker=new NativeBroker(),events=[],samples=[],errors=[],checks=[],diagnostics={},counts={evaluate:0,awaitPromise:0,map:0,publish:0};
const original=broker.request.bind(broker);broker.request=(op,args)=>{if(op==='map'||op==='publish')counts[op]++;return original(op,args);};
let browser,page,driver,cdp,world,socket,renderer,ck,phase='startup',failure,bound,closing=false;
const clean=s=>String(s).replaceAll(token,'[redacted]');
broker.on('event',e=>{if(e.event==='NativeFrame'||e.event==='NativeFrameRejected'){events.push({phase,at:performance.now(),...e});assert.ok(events.length<256);if(e.event==='NativeFrameRejected'&&e.code!=='VIZ_CAPTURE_SUPERSEDED')errors.push(e.reason);}});broker.on('failure',e=>errors.push(clean(e.message)));
const until=async(fn,label)=>{const end=Date.now()+12000;while(!await fn()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0,driver?.stats.lastError);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(5);}};
async function control(op,...args){counts.evaluate++;const r=await cdp.send('Runtime.evaluate',{contextId:world,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[token,op,id,...args].map(JSON.stringify).join(',')})`,returnByValue:true});if(r.exceptionDetails)throw new Error(clean(r.exceptionDetails.exception?.description??r.exceptionDetails.text));return r.result.value;}
const native=()=>events.filter(e=>e.event==='NativeFrame');
async function paused(){await broker.request('nativePolicy',{scopeId:id,inputSeq:0,enabled:false});await control('enable',false);await until(async()=>!(await control('inspect')).inflight,'native credit drain with clock alive');await until(async()=>{const s=await control('scheduler');return !s.armed&&!s.armPosted;},'one native timer stopped');}
try{
 ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 await broker.request('listenViz',{path:endpoint});const origin='http://127.0.0.1',access=randomBytes(16).toString('hex'),rendererInfo={};const{port}=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key:access,renderer:rendererInfo,producer:'native-cadence-test',sessionId:'native-cadence-test'}});
 const gate=new LiveFrameGate();socket=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${access}`,{origin});socket.on('error',e=>errors.push(clean(e.message)));socket.on('close',(code,reason)=>{if(!closing)errors.push(`Gateway closed: ${code} ${reason}`);});
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);gate.put(item.id,item.payload);return;}const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);
  if(m.type==='FrameCommit'){const f=gate.commit(m.pageEpoch,m.frameId);assert.ok(f);const out=renderer.render(f.scene,gate.resources,ck.WHITE);try{const pixel=x=>[...out.image.readPixels(x,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];const canvas=pixel(8),dom=pixel(72);assert.deepEqual(canvas,dom);assert.ok(palette.some(c=>JSON.stringify(c)===JSON.stringify(canvas)));samples.push({phase,at:performance.now(),ordinal:f.native.captureOrdinal,canvas,dom});assert.ok(samples.length<256);}finally{out.image.delete();out.surface?.dispose();}socket.send(JSON.stringify({type:'FrameAck',pageEpoch:f.pageEpoch,frameId:f.frameId,stage:'scene-submitted'}));}
 }catch(e){errors.push(clean(e.stack));}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:rendererInfo}));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});
 page=await browser.newPage({viewport:{width:320,height:180}});driver=await startBeginFrames(page);await page.goto(`http://127.0.0.1:${fixture.address().port}`);cdp=await page.context().newCDPSession(page);const{frameTree}=await cdp.send('Page.getFrameTree');world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-native-cadence-test'})).executionContextId;
 const d=await control('describe');assert.equal(d.cadenceVersion,1);
 await until(async()=>{bound=await control('bindDocument',d.documentToken,1,1,0,320,180,0);if(bound.ok)return true;assert.equal(bound.code,'NATIVE_NOT_READY');await driver.requestNow();return false;},'document/root binding');
 assert.equal(bound.intervalMicros,16667);assert.equal(bound.heartbeatMicros,1000000);assert.equal(bound.enabled,false);
 assert.equal((await control('cadence',100,1000)).ok,true);const repeated=await control('bindDocument',d.documentToken,1,1,0,320,180,0);assert.equal(repeated.intervalMicros,100000,'idempotent bind resetcustomcadence');
 await broker.request('registerNative',{config:bound});phase='animated';await control('enable',true);const started=performance.now(),evalBefore=counts.evaluate,acks=driver.stats.acked;
 await delay(1600);assert.deepEqual(errors,[]);const captured=native().filter(e=>e.at>=started).length,elapsed=performance.now()-started;
 assert.ok(captured>=8&&captured<=Math.ceil(elapsed/100)+2,`100ms cadence captured ${captured} over ${elapsed}ms`);assert.ok(driver.stats.acked-acks>captured*2);assert.equal(counts.evaluate,evalBefore);diagnostics.animated={captured,elapsedMs:elapsed,clockAcks:driver.stats.acked-acks};checks.push('100ms nativecadence capsanimatedcapture whileclockprogresses;zero perframeCDP/map/publish andactualCanvas/DOMpixels');
 phase='settle';await page.evaluate(()=>window.stop());await until(()=>samples.some(s=>s.phase==='settle'&&JSON.stringify(s.canvas)===JSON.stringify(palette[1])),'static green pixels');await delay(250);
 phase='heartbeat';const before=native().length,timerBefore=await control('scheduler'),hbEval=counts.evaluate;await delay(3200);assert.deepEqual(errors,[]);const heartbeat=native().length-before,timerAfter=await control('scheduler');
 assert.ok(heartbeat>=2&&heartbeat<=4,`Idle captured ${heartbeat}`);assert.ok(timerAfter.ticks-timerBefore.ticks<=5);assert.equal(counts.evaluate,hbEval+1);diagnostics.heartbeat={frames:heartbeat,before:timerBefore,after:timerAfter,clock:{...driver.stats}};checks.push('staticpage getsboundednative1s heartbeats withactualpixels andnocaptureCDP;no60Hz encoderloop');
 phase='single-change';await control('cadence',600,1000);const fence=(await control('inspect')).lastStarted;await control('update',0,false,true);await until(()=>native().some(e=>e.captureOrdinal>fence),'freshgreen baseline');await until(async()=>!(await control('inspect')).inflight,'baselinecredit');const baseline=await control('inspect');const wall=performance.now();await page.evaluate(()=>window.paint(0));
 await until(()=>samples.some(s=>s.phase==='single-change'&&s.ordinal>baseline.lastStarted&&JSON.stringify(s.canvas)===JSON.stringify(palette[0])),'lone throttledDOM change beforeheartbeat');const changed=await control('inspect'),wallMs=performance.now()-wall,nativeMicros=changed.lastStartedMicros-baseline.lastStartedMicros;
 assert.ok(nativeMicros>=600000&&nativeMicros<1000000,`Singlechange waited ${nativeMicros}us`);assert.ok(wallMs>=350&&wallMs<950,`Singlechange arrived ${wallMs}ms`);diagnostics.singleChange={nativeMicros,wallMs};checks.push('lone DOM/Canvas change insideinterval islatched anddisplayed at600ms before1s heartbeat');
 phase='fresh';await control('cadence',1000,1000);await until(()=>driver.stats.cadence==='idle','externalclock enteredidlecadence');const observe=await control('inspect'),freshStart=performance.now();await control('update',0,false,true);await until(()=>native().some(e=>e.captureOrdinal>observe.lastStarted),'urgentfresh nativeframe');const freshMs=performance.now()-freshStart;assert.ok(freshMs<650,`Urgent requestwaited ${freshMs}ms`);diagnostics.fresh={clockBefore:'idle',lastStartedFence:observe.lastStarted,elapsedMs:freshMs};checks.push('explicitfreshrequest fromidle bypassesordinary1s interval withordinalafter native lastStarted');
 phase='pause';await paused();await delay(50);const pausedCount=native().length,pausedTimer=await control('scheduler'),pausedAcks=driver.stats.acked;await delay(1250);assert.equal(native().length,pausedCount);const stopped=await control('scheduler');assert.equal(stopped.ticks,pausedTimer.ticks);assert.equal(stopped.wakes,pausedTimer.wakes);assert.ok(driver.stats.acked>pausedAcks);diagnostics.pause={before:pausedTimer,after:stopped,clockAcks:driver.stats.acked-pausedAcks};checks.push('pause drainscredit andstopsnative timer/encoding whileindependentclockcontinues');
 phase='resume';await broker.request('nativePolicy',{scopeId:id,inputSeq:0,enabled:true});const resumeFence=(await control('inspect')).lastStarted;await control('enable',true);await until(()=>native().some(e=>e.captureOrdinal>resumeFence&&e.resourcesComplete&&e.rawResourceBytes>0),'resumefullresources');await until(async()=>(await control('scheduler')).armed,'native timer resumed');
 await paused();await broker.request('cancelNative',{scopeId:id});await control('cancel');await until(async()=>{const s=await control('scheduler');return !s.armed&&!s.armPosted;},'cancel timer remainsstopped');checks.push('resume forcesfullresources andreactivatesboundedtimer;cancel stopsit');
 diagnostics.navigationHeartbeats=[];
 for(let n=0;n<3;n++){
  const base=bound.ordinalLimit+1;phase=`navigation-heartbeat-${n}`;
  await page.goto(`http://${n===2?'localhost':'127.0.0.1'}:${fixture.address().port}/next?n=${n}`,{waitUntil:'commit'});await page.waitForFunction(()=>typeof window.paint==='function');await page.evaluate(()=>window.stop());
  const{frameTree}=await cdp.send('Page.getFrameTree');world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-native-cadence-test'})).executionContextId;id=randomBytes(16).toString('hex');const doc=await control('describe');
  await until(async()=>{bound=await control('bindDocument',doc.documentToken,2+n,1,0,320,180,base);if(bound.ok)return true;assert.equal(bound.code,'NATIVE_NOT_READY');await driver.requestNow();return false;},'postnavigationbinding');await broker.request('registerNative',{config:bound});await control('enable',true);await until(()=>native().some(e=>e.scopeId===id),'postnavigationfirstframe');await delay(250);
  const beforeFrames=native().filter(e=>e.scopeId===id).length,beforeTimer=await control('scheduler'),evalFence=counts.evaluate;await delay(1250);const afterTimer=await control('scheduler'),extra=native().filter(e=>e.scopeId===id).length-beforeFrames;
  assert.ok(extra>=1&&extra<=2,`postnavigation heartbeat ${extra}`);assert.ok(afterTimer.ticks>beforeTimer.ticks);assert.equal(counts.evaluate,evalFence+1);diagnostics.navigationHeartbeats.push({scopeId:id,extra,before:beforeTimer,after:afterTimer});await paused();await broker.request('cancelNative',{scopeId:id});await control('cancel');
 }
 checks.push('same-renderer documentreplacement andcrosssite navigation retainworkingnativeheartbeat withoutperframeCDP');
 assert.equal(counts.awaitPromise,0);assert.equal(counts.map,0);assert.equal(counts.publish,0);assert.deepEqual(errors,[]);
}catch(e){failure=clean(e.stack);}
finally{closing=true;await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});socket?.terminate();renderer?.clear();await broker.close();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'ActualLinux nativecadence/mainOneShotTimer/CCrootdamage+monotonictime/productionBroker/Gateway/CanvasKit actualpixels. Lifecycle harness,notdefaultSource/fullSession/B4CPU orcompleteB1.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),phase,checks,counts,diagnostics,samples,events,errors,clock:driver?.stats,cleanup:{exited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners},...(failure?{error:failure}:{})};await writeFile(output+'/cadence.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,diagnostics,counts,error:failure}));if(failure)throw new Error(failure);
