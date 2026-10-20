// Actual Chromium subscription → production Broker dispatcher/Gateway →
// CanvasKit pixels. Explicit test lifecycle controls; default Source is a
// separate integration checkpoint and is deliberately not patched here.
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
const output=process.env.REMOTE_PAINT_PUBLICATION_OUTPUT??'artifacts/native-publication';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-publication-'),endpoint=directory+'/viz.sock',token=randomBytes(32).toString('hex');
const fixture=createServer((req,res)=>res.end(`<!doctype html><style>html,body{margin:0;overflow:hidden;background:white}canvas,#match{position:absolute;top:0;width:32px;height:32px}#match{left:64px;will-change:background-color}p{position:absolute;top:40px;font:24px Arial;color:#123456}</style><canvas width=32 height=32></canvas><div id=match></div><p>Native subscription <span>0</span></p><script>window.ticks=0;const ctx=document.querySelector('canvas').getContext('2d');function draw(){ticks++;const c=['rgb(31,79,191)','rgb(43,161,89)','rgb(197,53,113)'][ticks%3];ctx.fillStyle=c;ctx.fillRect(0,0,32,32);document.querySelector('#match').style.backgroundColor=c;document.querySelector('span').textContent=ticks;requestAnimationFrame(draw);}draw();</script>`));
const broker=new NativeBroker(),events=[],errors=[],samples=[],checks=[],counts={evaluate:0,awaitPromise:0,map:0,publish:0},bindings=[],bindAttempts=[];
const original=broker.request.bind(broker);broker.request=(op,args)=>{if(op==='map'||op==='publish')counts[op]++;return original(op,args);};
broker.on('event',e=>{if(e.event==='NativeFrame'||e.event==='NativeFrameRejected'){events.push(e);assert.ok(events.length<256);}});broker.on('failure',e=>errors.push(e.message));
const clean=s=>String(s).replaceAll(token,'[redacted]');
let browser,page,driver,cdp,world,socket,renderer,ck,phase='startup',failure,current,collect=true;
const until=async(fn,label)=>{const end=Date.now()+12000;while(!await fn()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0,driver?.stats.lastError);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(10);}};
const palette=[[31,79,191,255],[43,161,89,255],[197,53,113,255]].map(JSON.stringify);
async function control(operation,id,...args){
 counts.evaluate++;const r=await cdp.send('Runtime.evaluate',{contextId:world,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[token,operation,id,...args].map(JSON.stringify).join(',')})`,returnByValue:true});
 if(r.exceptionDetails)throw new Error(clean(r.exceptionDetails.exception?.description??r.exceptionDetails.text));return r.result.value;
}
async function ensureWorld(){const {frameTree}=await cdp.send('Page.getFrameTree');world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-native-publication-test'})).executionContextId;}
async function bind(epoch,vp,input,width,height,base){
 const id=randomBytes(16).toString('hex');let c;
 await until(async()=>{
  c=await control('bind',id,epoch,vp,input,width,height,base);bindAttempts.push({phase,...c});
  if(c.ok)return true;
  // Missing host/root is an explicit readiness gate. A rejected actual bind
  // (Busy/invalid/ordinal) is a failure, not a reason to silently retry.
  assert.equal(c.bindStatus,undefined,JSON.stringify(c));await driver.requestNow();return false;
 },'native host/root after real BeginFrame ACK');
 assert.equal(c.enabled,false);bindings.push(c);current=c;
 await broker.request('registerNative',{config:c});assert.equal((await control('enable',id,true)).ok,true);return c;
}
async function cancel(){
 const c=current;await broker.request('cancelNative',{scopeId:c.id});await control('cancel',c.id);
 await until(async()=>{const s=await control('inspect',c.id);return !s.ok||!s.inflight;},'native cancellation drain with clock alive');current=null;return c.ordinalLimit+1;
}
try{
 ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 await broker.request('listenViz',{path:endpoint});const origin='http://127.0.0.1',key=randomBytes(16).toString('hex'),rendererInfo={};
 const {port}=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key,renderer:rendererInfo,producer:'native-publication-test',sessionId:'native-publication-test'}});
 const gate=new LiveFrameGate();socket=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${key}`,{origin});socket.on('error',e=>errors.push(clean(e.message)));
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);gate.put(item.id,item.payload);return;}
  const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);
  if(m.type==='FrameCommit'){
   const frame=gate.commit(m.pageEpoch,m.frameId);assert.ok(frame);
   if(collect){
    const out=renderer.render(frame.scene,gate.resources,ck.WHITE);
    try{const pixel=x=>[...out.image.readPixels(x,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];const canvas=pixel(8),dom=pixel(72);assert.deepEqual(canvas,dom,'Canvas and DOM must share the same captured frame');assert.ok(palette.includes(JSON.stringify(canvas)));samples.push({phase,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,inputSeq:frame.lastProcessedInputSeq,ordinal:frame.native.captureOrdinal,frameToken:frame.native.frameToken,sourceFrame:frame.native.sourceFrame,canvas,dom,resources:frame.requiredResources.length});assert.ok(samples.length<128);}finally{out.image.delete();out.surface?.dispose();}
   }
   socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));
  }
 }catch(e){errors.push(clean(e.stack));}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:rendererInfo}));
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});
 page=await browser.newPage({viewport:{width:320,height:180}});driver=await startBeginFrames(page);const url=`http://127.0.0.1:${fixture.address().port}`;await page.goto(url);await page.waitForFunction(()=>ticks>2);
 cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');await ensureWorld();
 phase='steady';let c=await bind(1,1,0,320,180,0);const initial=counts.evaluate;
 await until(()=>samples.filter(s=>s.phase==='steady').length>=12&&new Set(samples.filter(s=>s.phase==='steady').map(s=>JSON.stringify(s.canvas))).size===3,'12 real native frames/three actual paired pixel colors');assert.equal(counts.evaluate,initial);assert.equal(counts.awaitPromise,0);assert.equal(counts.map,0);assert.equal(counts.publish,0);
 checks.push('12 actualChromium nativeframes with matchingCanvas/DOM pixels andthreecolors;zeroadditionalcaptureCDP andzero map/publishRPC');
 phase='paused';await broker.request('nativePolicy',{scopeId:c.id,inputSeq:0,enabled:false});await control('enable',c.id,false);await until(async()=>!(await control('inspect',c.id)).inflight,'pause drain');const at=events.filter(e=>e.event==='NativeFrame').length,acked=driver.stats.acked;await delay(160);assert.equal(events.filter(e=>e.event==='NativeFrame').length,at);assert.ok(driver.stats.acked>acked);
 phase='input';await broker.request('nativePolicy',{scopeId:c.id,inputSeq:7,enabled:true});const updated=await control('update',c.id,7,true,true);assert.equal(updated.ok,true);await control('enable',c.id,true);
 await until(()=>samples.filter(s=>s.phase==='input'&&s.inputSeq===7&&s.sourceFrame>=updated.minimumSourceFrame).length>=3,'updated native watermark activation');checks.push('pause stops publication while BeginFrame clock progresses; resumed input7 crossesactualCCactivationfloor');
 phase='navigation';let base=await cancel();const eventFence=events.length;await page.goto(url+'/new');await ensureWorld();c=await bind(2,1,7,320,180,base);
 await until(()=>samples.filter(s=>s.phase==='navigation'&&s.pageEpoch===2).length>=3,'newdocument native pixels');assert.ok(events.slice(eventFence).filter(e=>e.event==='NativeFrame').every(e=>e.pageEpoch===2&&e.captureOrdinal>base));checks.push('explicit navigation cancellation/drain anddisjointordinalrange publishnewdocument pixels');
 phase='resize';base=await cancel();await driver.stop();try{await page.setViewportSize({width:360,height:220});}finally{driver.start();}await driver.requestNow();c=await bind(2,2,7,360,220,base);
 await until(()=>samples.filter(s=>s.phase==='resize'&&s.viewportVersion===2).length>=3,'serializedresize native pixels');checks.push('clock-drainedLocalSurfaceId resize followedbynewscope preservesactualCanvas/DOMpixels');
 collect=false;await cancel();assert.deepEqual(errors,[]);assert.equal(counts.map,0);assert.equal(counts.publish,0);assert.equal(driver.stats.errors,0);
}catch(e){failure=clean(e.stack);}
finally{collect=false;await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});socket?.terminate();renderer?.clear();await broker.close();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Real Linux Chromium native subscription/Unix authenticated intake/single-ownerMapper/autonomousGateway/CanvasKit actualCanvas+DOM same-framepixels. Explicit harness lifecycle controls; defaultSource,opaqueDocumentToken,damage/idle policy,fullSession/pressure/close andB1 completion remainunverified.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),phase,checks,counts,bindings,bindAttempts,samples,events,errors,clock:driver?.stats,cleanup:{exited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners},...(failure?{error:failure}:{})};
await writeFile(output+'/publication.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,samples:samples.length,counts,error:failure}));if(failure)throw new Error(failure);
