// Native subscription transport/lifecycle harness. The private receiver below
// deliberately supplies synthetic credit; this does not verify production
// Broker authorization, Mapper publication, Source integration or B1 pixels.
import assert from 'node:assert/strict';
import net from 'node:net';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import {decodeVizScene} from '../capture/viz-wire.mjs';

const directory=await mkdtemp('/tmp/remote-paint-subscription-'),endpoint=directory+'/viz.sock';
const output=process.env.REMOTE_PAINT_SUBSCRIPTION_OUTPUT??'artifacts/native-subscription';
await mkdir(output,{recursive:true});
const token=randomBytes(32).toString('hex'),scope=()=>randomBytes(16).toString('hex');
const jobs=new Map(),rows=[],sockets=new Set(),errors=[],checks=[],held=[],diagnostics={};
let browser,driver,cdp,world,phase='startup',mode='auto',page;
const counts={evaluate:0,awaitPromise:0,packets:0,resources:0,scenes:0,credits:0,superseded:0};
const clean=s=>String(s).replaceAll(token,'[redacted]');
const until=async(check,label,timeout=10000)=>{const end=Date.now()+timeout;while(!await check()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0,driver?.stats.lastError??'Native clock failed');assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(10);}};
const credit=(job,outcome=1,corrupt=false)=>{
 const s=job.metadata.subscription,b=Buffer.alloc(56);b.write('RPC3');b[4]=1;b[5]=outcome;Buffer.from(s.id).copy(b,8);
 b.writeBigUInt64BE(BigInt(s.captureOrdinal),40);b.writeBigUInt64BE(BigInt(s.generation)+(corrupt?1n:0n),48);
 job.socket.write(b);job.credited=true;counts.credits++;jobs.delete(job.id);
};
const complete=job=>{
 if(!job.metadata||!job.scene||job.processed)return;job.processed=true;
 const s=job.metadata.subscription;
 assert.equal(job.metadata.captureId,`${s.id}:${s.captureOrdinal}`);assert.equal(s.version,1);
 if(job.scene.error){assert.match(job.scene.error,/superseded before aggregation/);counts.superseded++;credit(job,2);return;}
 rows.push({phase,id:job.id,...s,resourcesComplete:job.metadata.resourcesComplete,resourceCount:job.resourceCount,resourceBytes:job.resourceBytes,sourceFrame:job.metadata.sourceFrame,frameToken:job.metadata.frameToken,producer:job.metadata.producer,vizRoot:job.scene.passes.at(-1)?.output,errorCode:job.metadata.code??null,error:job.metadata.error??null});assert.ok(rows.length<256,'Harness must stay bounded');
 if(mode==='hold'||mode==='noack')held.push(job);
 else if(mode==='pause'||(mode==='viewport'&&job.metadata.code==='NATIVE_SUBSCRIPTION_TARGET_CHANGED'))credit(job,3);
 else if(mode==='viewport'&&(job.scene.passes.at(-1)?.output[2]!==s.cssWidth||job.scene.passes.at(-1)?.output[3]!==s.cssHeight))credit(job,2);
 else if(mode==='invalid')credit(job,1,true);
 else credit(job);
};
const packet=(bytes,socket)=>{
 counts.packets++;
 const kind=bytes.toString('ascii',0,4);assert.ok(['RPA2','RVB2'].includes(kind),`Unexpected packet: ${kind}`);
 let offset=6;const string=()=>{assert.ok(offset+4<=bytes.length);const n=bytes.readUInt32BE(offset);offset+=4;assert.ok(n<=256*1024&&offset+n<=bytes.length);const s=bytes.toString('utf8',offset,offset+n);offset+=n;return s;};
 const id=string();let job=jobs.get(id);if(!job){assert.ok(jobs.size<4,'Native job limit exceeded');job={id};jobs.set(id,job);}
 if(kind==='RPA2'){
  assert.equal(job.metadata,undefined,'Duplicate resource job');job.metadata=JSON.parse(string());job.socket=socket;
  const n=bytes.readUInt32BE(offset);offset+=4;assert.ok(n<=256);let total=0;
  for(let i=0;i<n;i++){assert.match(string(),/^[0-9a-f]{64}$/);const size=bytes.readUInt32BE(offset);offset+=4;assert.ok(offset+size<=bytes.length);total+=size;offset+=size;}
  assert.equal(offset,bytes.length);job.resourceCount=n;job.resourceBytes=total;counts.resources++;
 }else{job.scene=decodeVizScene(bytes);counts.scenes++;}
 complete(job);
};
const server=net.createServer(socket=>{
 sockets.add(socket);assert.ok(sockets.size<=4);let bytes=Buffer.alloc(0);
 socket.on('error',e=>{if(e.code!=='ECONNRESET')errors.push(clean(e.message));});socket.on('close',()=>sockets.delete(socket));
 socket.on('data',chunk=>{try{bytes=Buffer.concat([bytes,chunk]);assert.ok(bytes.length<=72*1024*1024+4);while(bytes.length>=4){const n=bytes.readUInt32BE();assert.ok(n>0&&n<=72*1024*1024);if(bytes.length<n+4)break;packet(bytes.subarray(4,n+4),socket);bytes=bytes.subarray(n+4);}}catch(e){errors.push(clean(e.stack));socket.destroy();}});
});
const fixture=createServer((req,res)=>res.end(`<!doctype html><style>html,body{margin:0;overflow:hidden;background:white}div{font:24px Arial;color:#123456}canvas{width:32px;height:32px}</style><div>Native subscription <span>0</span></div><canvas width=32 height=32></canvas><script>window.ticks=0;const ctx=document.querySelector('canvas').getContext('2d');function draw(){ticks++;document.querySelector('span').textContent=ticks;ctx.fillStyle=ticks%2?'rgb(31,79,191)':'rgb(43,161,89)';ctx.fillRect(0,0,32,32);requestAnimationFrame(draw);}draw();</script>`));
let failure;
try{
 await new Promise(r=>server.listen(endpoint,r));await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});
 page=await browser.newPage({viewport:{width:320,height:180}});driver=await startBeginFrames(page);
 const url=`http://127.0.0.1:${fixture.address().port}`;await page.goto(url);await page.waitForFunction(()=>ticks>2);
 cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');
 const ensureWorld=async()=>{const {frameTree}=await cdp.send('Page.getFrameTree');world=(await cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-subscription-test'})).executionContextId;};
 await ensureWorld();
 const control=async(operation,key,...args)=>{
  counts.evaluate++;const result=await cdp.send('Runtime.evaluate',{contextId:world,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[token,operation,key,...args].map(JSON.stringify).join(',')})`,returnByValue:true});
  if(result.exceptionDetails)throw new Error(clean(result.exceptionDetails.exception?.description??result.exceptionDetails.text));return result.result.value;
 };
 const bind=async(key,epoch=1,viewport=1,minimum=0)=>control('bind',key,epoch,viewport,0,320,180,minimum);
 const resize=async size=>{
  // The real Source.resize drains capture and stops this same external clock.
  // Changing LocalSurfaceId under an outstanding BeginFrame can discard ACK.
  await driver.stop();try{await page.setViewportSize(size);}finally{driver.start();}
 };
 phase='disabled';let key=scope(),bound=await bind(key);assert.equal(bound.ok,true);assert.equal(bound.enabled,false);assert.equal(bound.lastStarted,bound.ordinalBase);await delay(80);assert.equal(rows.length,0);
 checks.push({name:'two-phase-disabled-bind',passed:true});
 phase='steady';assert.equal((await control('enable',key,true)).ok,true);const evalBefore=counts.evaluate;
 await until(()=>rows.filter(r=>r.phase==='steady').length>=8,'autonomous native frames');assert.equal(counts.evaluate,evalBefore);assert.equal(counts.awaitPromise,0);
 assert.ok(rows.some(r=>r.resourceCount>0&&r.resourceBytes>0));
 checks.push({name:'eight-natural-native-frames-without-per-frame-CDP',passed:true});
 phase='held';mode='hold';await until(()=>held.length>0,'held exact pair');let job=held.shift();
 const fence=await control('inspect',key);assert.equal(fence.lastStarted,job.metadata.subscription.captureOrdinal);assert.equal(fence.awaitingCredit,true);assert.ok(job.metadata.sourceFrame>=bound.minimumSourceFrame);
 const before=rows.length,clock=driver.stats.acked;await delay(160);assert.equal(rows.length,before);assert.ok(driver.stats.acked>clock);
 const updated=await control('update',key,7,true,true);assert.equal(updated.ok,true);assert.equal(job.metadata.subscription.inputSeq,0);diagnostics.inputCommitFence=updated.minimumSourceFrame;
 mode='auto';credit(job);await until(()=>rows.some(r=>r.phase==='held'&&r.captureOrdinal>fence.lastStarted&&r.inputSeq===7&&r.sourceFrame>=updated.minimumSourceFrame&&r.resourcesComplete&&r.resourceCount>0),'atomic updated watermark and sticky resources');
 checks.push({name:'in-flight-fence-single-credit-page-clock-input-and-resource-revision',passed:true});
 phase='pause';mode='pause';await until(async()=>!(await control('inspect',key)).enabled,'pause receipt');const paused=rows.length;await delay(100);assert.equal(rows.length,paused);
 phase='resume';mode='hold';await control('enable',key,true);await until(()=>held.length>0,'resume full frame');job=held.shift();assert.equal(job.metadata.resourcesComplete,true);assert.ok(job.resourceCount>0);
 mode='auto';credit(job,2);await until(()=>rows.some(r=>r.phase==='resume'&&r.captureOrdinal>job.metadata.subscription.captureOrdinal&&r.resourcesComplete&&r.resourceCount>0),'retry forces full frame');
 checks.push({name:'pause-resume-and-retry-full-resource-credit',passed:true});
 phase='invalid-credit';mode='invalid';await until(async()=>!(await control('inspect',key)).enabled,'wrong generation receipt fails closed');
 checks.push({name:'wrong-generation-credit-pauses-native-loop',passed:true});
 phase='timeout';mode='noack';await control('enable',key,true);await until(()=>held.length>0,'timeout frame');job=held.shift();const waiting=performance.now();
 const progress=await control('update',key,8,false,false);assert.equal(progress.ok,true);assert.ok(performance.now()-waiting<3000,'Main-thread control stalled on native credit');
 await until(async()=>!(await control('inspect',key)).enabled,'bounded missing-credit pause',7000);assert.ok(performance.now()-waiting<6500);jobs.delete(job.id);
 checks.push({name:'missing-credit-bounded-with-control-progress',passed:true});
 phase='cancel';mode='hold';await control('enable',key,true);await until(()=>held.length>0,'cancel in-flight frame');job=held.shift();const limit=bound.ordinalLimit;
 const canceled=await control('cancel',key);assert.equal(canceled.ok,true);assert.equal(canceled.retiring,true);
 const next=scope();assert.equal((await bind(next,1,1,limit+1)).ok,false,'An old job still owns its slot');
 credit(job);await until(async()=>!(await control('inspect',key)).ok,'late exact credit retires canceled native job');
 key=next;bound=await bind(key,1,1,limit+1);assert.equal(bound.ok,true);assert.ok(bound.ordinalBase>limit);
 checks.push({name:'cancel-retains-job-until-late-credit-and-range-rebind',passed:true});
 phase='navigation';mode='hold';await control('enable',key,true);await until(()=>held.length>0,'navigation in-flight frame');job=held.shift();const previousKey=key,previousLimit=bound.ordinalLimit;
 await page.goto(url+'/new');await ensureWorld();const navigated=await control('inspect',previousKey);assert.ok(!navigated.ok||navigated.retiring,'Navigation did not revoke native scope');
 const nativeBefore=rows.length;credit(job);await delay(100);assert.equal(rows.length,nativeBefore,'Old native scope captured a new document');
 key=scope();bound=await bind(key,2,1,previousLimit+1);assert.equal(bound.ok,true);assert.ok(bound.ordinalBase>previousLimit);
 checks.push({name:'synchronous-document-invalidation-and-new-renderer-range',passed:true});
 phase='viewport';mode='viewport';await resize({width:340,height:190});diagnostics.viewportBefore=await control('inspect',key);diagnostics.viewportEnable=await control('enable',key,true);assert.equal(diagnostics.viewportEnable.ok,true);
 await until(async()=>!(await control('inspect',key)).enabled,'native viewport mismatch pause');
 // Invalid geometry is a typed metadata failure and may have no Viz resource pair.
 assert.ok([...jobs.values()].some(j=>j.metadata?.code==='NATIVE_SUBSCRIPTION_TARGET_CHANGED')||rows.some(r=>r.phase==='viewport'&&r.errorCode==='NATIVE_SUBSCRIPTION_TARGET_CHANGED'&&r.resourceCount===0));
 checks.push({name:'viewport-change-cannot-be-stamped-as-old-target',passed:true});
 const repeat=Number(process.env.REMOTE_PAINT_SUBSCRIPTION_REPEAT_VIEWPORT??0);assert.ok(Number.isInteger(repeat)&&repeat>=0&&repeat<=12);
 diagnostics.viewportRepeats=[];
 for(let n=0;n<repeat;n++) {
  phase=`viewport-repeat-${n+1}`;assert.equal((await control('cancel',key)).ok,true);
  mode='viewport';await resize({width:320,height:180});key=scope();bound=await bind(key,2,n+2,bound.ordinalLimit+1);assert.equal(bound.ok,true);
  await resize({width:340,height:190});const enabled=await control('enable',key,true);assert.equal(enabled.ok,true);
  await until(async()=>!(await control('inspect',key)).enabled,`repeated viewport mismatch ${n+1}`);
  assert.ok([...jobs.values()].some(j=>j.metadata?.subscription.id===key&&j.metadata.code==='NATIVE_SUBSCRIPTION_TARGET_CHANGED')||rows.some(r=>r.id===key&&r.errorCode==='NATIVE_SUBSCRIPTION_TARGET_CHANGED'&&r.resourceCount===0));
  diagnostics.viewportRepeats.push({n:n+1,passed:true,enabled,clock:{...driver.stats}});
 }
 assert.deepEqual(errors,[]);
}catch(e){failure=clean(e.stack);diagnostics.driver={...driver?.stats};diagnostics.pending=[...jobs.values()].map(j=>({id:j.id,metadata:j.metadata??null,sceneError:j.scene?.error??null}));}
finally{
 await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});
 for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await new Promise(r=>fixture.close(r));await rm(directory,{recursive:true,force:true});
}
diagnostics.resizeOrdering='Browser resize ACK can precede renderer/CC activation. The receiver rejects a mismatching aggregated Viz root with Retry, consumes only a matching preceding old-tree frame and pauses on the typed native new-geometry rejection; no timing delay or successful-new-geometry frame is substituted for this rejection.';
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Linux Chromium native subscription, exact-frame Viz/resource transport and lifecycle, with test-only synthetic credit receiver. Production Broker autonomous authentication/Mapper credit, Source routing and pixel acceptance remain unverified.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),phase,checks,counts,rows,errors,diagnostics:{...diagnostics,driver:driver?.stats},...(failure?{error:failure}:{})};
await writeFile(output+(failure?'/failed.json':'/contract.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,counts,error:failure}));if(failure)process.exitCode=1;
