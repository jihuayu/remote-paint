import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,rename,mkdir,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createNativeProcessMemorySampler} from './process-native-memory.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {atomicJson} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'darwin','Run the Viewer controller on the Mac hardware GPU host');
const directory=resolve(process.env.REMOTE_PAINT_MEMORY_DIR??'artifacts/memory-soak'),seconds=Number(process.env.REMOTE_PAINT_MEMORY_SECONDS??120),burst=Number(process.env.REMOTE_PAINT_MEMORY_BURST??400),interval=Number(process.env.REMOTE_PAINT_MEMORY_INTERVAL??2000),navigationEvery=Number(process.env.REMOTE_PAINT_MEMORY_NAVIGATION_EVERY??40);
assert.ok(seconds>0&&seconds<=12*3600&&burst>=1&&interval>=0&&Number.isInteger(navigationEvery)&&navigationEvery>=2&&navigationEvery<=1000);await mkdir(directory,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ready;for(let attempt=0;attempt<300&&!ready;attempt++){try{ready=JSON.parse(await readFile(join(directory,'ready.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;await delay(100);}}assert.ok(ready,'Native memory source did not become ready');
async function rawCommand(op,fields={}){
 const id=randomUUID(),path=join(directory,'requests',`${id}.json`),reply=join(directory,'responses',`${id}.json`);await writeFile(`${path}.tmp`,JSON.stringify({runId:ready.runId,id,op,...fields}));await rename(`${path}.tmp`,path);
 const started=Date.now();while(Date.now()-started<30000){const response=await readFile(reply,'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(response?.id===id){await Promise.all([unlink(path),unlink(reply)]);if(response.error)throw new Error(response.error);if(response.state&&op!=='snapshot')assert.deepEqual(response.state.unexpectedErrors,[]);return response;}await delay(25);}throw new Error(`Source memory test operation timed out: ${op}`);
}
// Source state queries share its command order with mutation/navigation;
// slow Viewer/OS introspection must not suspend the mutation/pixel workload.
let sourceCommandQueue=Promise.resolve();
function command(op,fields={}){const request=sourceCommandQueue.then(()=>rawCommand(op,fields));sourceCommandQueue=request.catch(()=>{});return request;}
async function waitTrue(page,predicate,arg,options){const handle=await page.waitForFunction(predicate,arg,options);try{assert.equal(await handle.jsonValue(),true);}finally{await handle.dispose();}}
let samplingFailure,samplingPending,sampleOrdinal=0,lastSampleStarted=0;
const loopDelay=monitorEventLoopDelay({resolution:20});loopDelay.enable();
async function measuredPhase(label,work,timeout=5000){
 const id=++sampleOrdinal,start=performance.now();await appendFile(join(directory,'sampling-phases.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'started',id,label,cycle})+'\n');let timer;
 try{const value=await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Memory sample phase timed out: ${label} after${timeout}ms`)),timeout);})]);if(performance.now()-start>timeout)throw new Error(`Memory sample phase exceeded deadline: ${label} after${Math.round(performance.now()-start)}ms`);await appendFile(join(directory,'sampling-phases.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'completed',id,label,cycle,elapsedMs:performance.now()-start})+'\n');return value;}
 catch(error){await appendFile(join(directory,'sampling-phases.jsonl'),JSON.stringify({at:new Date().toISOString(),event:'failed',id,label,cycle,elapsedMs:performance.now()-start,error:error.message})+'\n');throw error;}
 finally{clearTimeout(timer);}
}
const pages=[],sessions=[],started=performance.now(),wallStarted=Date.now(),samples=[];let browser,root,nativeMemorySampler,nativeMemoryCleanup,cycle=0,navigations=0,resizes=0,inputs=0,nextInput=0,lastSample=0;
const targetPending=new Map();let nextCommand=1;
const workerMessage=event=>{const message=JSON.parse(event.message),key=`${event.sessionId}:${message.id}`,pending=targetPending.get(key);if(!pending)return;targetPending.delete(key);clearTimeout(pending.timer);message.error?pending.reject(new Error(message.error.message)):pending.resolve(message.result);};
async function workerHeap(targetId){
 const {sessionId}=await measuredPhase('worker-attach',()=>root.send('Target.attachToTarget',{targetId,flatten:false}));
 try{const id=nextCommand++,response=new Promise((resolve,reject)=>{const key=`${sessionId}:${id}`,timer=setTimeout(()=>{targetPending.delete(key);reject(new Error('Worker heap probe timed out'));},5000);targetPending.set(key,{resolve,reject,timer});});await root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method:'Runtime.getHeapUsage'})});return await response;}
 finally{await measuredPhase('worker-detach',()=>root.send('Target.detachFromTarget',{sessionId}));}
}
async function pixels(page,n){
 await waitTrue(page,n=>{const source=document.querySelector('#viewport');if(!window.remotePaintResult||source.width<600)return false;const canvas=document.createElement('canvas');canvas.width=2;canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(source,20,80,1,1,0,0,1,1);context.drawImage(source,400,30,1,1,1,0,1,1);const data=context.getImageData(0,0,2,1).data;return data[0]===(n&255)&&data[1]===((n>>8)&255)&&data[2]===199&&data[4]===(n&255)&&data[5]===((n>>8)&255)&&data[6]===199;},n,{timeout:15000});
}
async function sample(final=false){
 lastSampleStarted=performance.now();const sampleStarted=lastSampleStarted,sampleWallStarted=Date.now();
 const {state,metrics,health}=await measuredPhase('source-metrics',()=>command('metrics'),15000);assert.equal(state.pageStateError,undefined);assert.equal(health.pageCrashed,false);assert.equal(health.browserDisconnected,false);assert.equal(health.brokerExited,false);
 const results=await Promise.all(pages.map(page=>measuredPhase(page.label+'-ledger',()=>page.evaluate(()=>({result:window.remotePaintResult,memory:window.remotePaintMemory,error:document.querySelector('#error').hidden?null:document.querySelector('#error').textContent}))))),heaps=[];
 for(let n=0;n<pages.length;n++)heaps.push({label:pages[n].label,scope:'page',...await measuredPhase(pages[n].label+'-heap',()=>sessions[n].send('Runtime.getHeapUsage'))});
 const {targetInfos}=await measuredPhase('worker-target-inventory',()=>root.send('Target.getTargets'));for(const target of targetInfos.filter(t=>t.type==='worker'))heaps.push({scope:'worker',targetId:target.targetId,...await measuredPhase('worker-heap',()=>workerHeap(target.targetId),18000)});
 const {processInfo}=await measuredPhase('browser-process-inventory',()=>root.send('SystemInfo.getProcessInfo'));
 const sampled=await measuredPhase('viewer-process-native-memory',()=>nativeMemorySampler.sample(processInfo,{onAttempt:receipt=>appendFile(join(directory,'native-memory-attempts.jsonl'),JSON.stringify({at:new Date().toISOString(),cycle,...receipt})+'\n')})),processRss=sampled.processes,processRssSampling=sampled.sampling;
 for(const [n,value]of results.entries()){
  assert.equal(value.error,null);assert.ok(value.memory);assert.ok(value.memory.observed.wasmHeapBytes<=value.memory.limits.wasm);assert.ok(value.memory.residentEstimate<=value.memory.limits.total);
  assert.ok(value.memory.domains.js<=value.memory.limits.js);assert.ok(value.memory.renderBytes<=value.memory.limits.render);
  if(n===0){assert.equal(value.result.presentation.mode,'webgl2-bitmap');assert.equal(value.result.presentation.totalReadbackBytes,0);assert.ok(Number.isFinite(value.memory.observed.gpuCacheBytes));assert.ok(value.result.presentation.device?.renderer,'Actual GPU renderer identity is required');assert.doesNotMatch(value.result.presentation.device.renderer,/SwiftShader|llvmpipe|softpipe|software rasterizer/i,'Hardware GPU is required');}
 }
 const item={at:new Date().toISOString(),sampling:{startedAt:new Date(sampleWallStarted).toISOString(),elapsedMs:performance.now()-sampleStarted,eventLoopMaxMs:loopDelay.max/1e6,sourceCycleAtSnapshot:state.cycle??null,controllerCycleAtFinish:cycle},wallElapsedSeconds:(Date.now()-wallStarted)/1000,elapsedSeconds:(performance.now()-started)/1000,cycle,navigations,resizes,inputs,state,metrics,results,heaps,processRss,processRssSampling,processMemoryScope:sampled.scope};const previous=samples.at(-1);samples.push(item);loopDelay.reset();await appendFile(join(directory,'samples.jsonl'),JSON.stringify(item)+'\n');
 await atomicJson(directory,'status.json',{runId:ready.runId,status:final?'validating':'running',at:item.at,elapsedSeconds:item.elapsedSeconds,targetSeconds:seconds,cycle,navigations,resizes,inputs,memory:results.map(v=>v.memory),workerHeapTargets:heaps.filter(h=>h.scope==='worker').length});
 console.log(JSON.stringify({event:final?'validation':'sample',elapsedSeconds:item.elapsedSeconds,cycle,navigations,resizes,inputs,wasm:results.map(v=>v.memory.observed.wasmHeapBytes),gpu:results[0].memory.observed.gpuCacheBytes}));lastSample=performance.now();if(previous)assert.ok(item.wallElapsedSeconds-previous.wallElapsedSeconds<90,'Sleep/stall interrupted continuous memory coverage');return item;
}
let report,failure,sourceCleanup;const cleanupErrors=[];
try{
 nativeMemorySampler=await createNativeProcessMemorySampler();await atomicJson(directory,'native-memory-observer.json',{at:new Date().toISOString(),provider:'darwin-libproc-v1',helperPid:nativeMemorySampler.child.pid,provenance:nativeMemorySampler.provenance});
 browser=await launchCaptureBrowser();root=await browser.newBrowserCDPSession();root.on('Target.receivedMessageFromTarget',workerMessage);
 for(const [label,params]of [['gpu-worker','gpu&memory=compact'],['cpu-worker','cpu&memory=compact'],['cpu-main','cpu&mainThread&memory=compact']]){
  const page=await browser.newPage({viewport:{width:1100,height:900}});page.label=label;const url=new URL(ready.url);url.search=params;pages.push(page);sessions.push(await page.context().newCDPSession(page));await page.goto(url.href);await waitTrue(page,()=>window.remotePaintResult?.frameId>0,null,{timeout:60000});await pixels(page,0);
 }
 await sample();const exercisedStarted=performance.now();
 while((performance.now()-exercisedStarted)/1000<seconds||cycle<burst){
  if(samplingFailure)throw samplingFailure;cycle++;let state;
  if(cycle>burst&&cycle%navigationEvery===0){state=(await command('reload',{cycle})).state;navigations++;nextInput=0;}
  else state=(await command('update',{cycle})).state;
  await Promise.all(pages.map(page=>pixels(page,cycle)));
  if(cycle%11===0){const width=resizes%2?640:720,height=resizes%2?400:480;const {state}=await command('resize',{viewport:{width,height}});resizes++;await Promise.all(pages.map(page=>waitTrue(page,({width,version})=>document.querySelector('#viewport').width===width&&window.remotePaintResult?.viewportVersion===version,{width,version:state.viewportVersion})));await Promise.all(pages.map(page=>pixels(page,cycle)));}
  if(cycle%16===0){
   const page=pages[0];if(await page.locator('#controlState').textContent()!=='你正在操作'){await page.locator('#control').click();await waitTrue(page,()=>document.querySelector('#controlState').textContent==='你正在操作');}
   const box=await page.locator('#viewport').boundingBox(),width=await page.locator('#viewport').evaluate(c=>c.width);await page.mouse.click(box.x+100*box.width/width,box.y+38*box.width/width);
   await page.locator('#inputProxy').evaluate(e=>e.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true})));nextInput++;inputs++;
   await waitTrue(page,n=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('#viewport'),340,30,1,1,0,0,1,1);const data=ctx.getImageData(0,0,1,1).data;return data[0]*256+data[1]===n&&data[2]===42;},nextInput);
  }
  if(!samplingPending&&performance.now()-lastSampleStarted>60000){samplingPending=sample().catch(error=>{samplingFailure=error;}).finally(()=>{samplingPending=null;});}
  if(cycle>=burst)await delay(interval);
 }
 if(samplingPending)await samplingPending;if(samplingFailure)throw samplingFailure;const last=await sample(true);assert.ok(last.state.imageBytes>64*1024*1024,'Stress did not exceed the shared chunk cache working set');
 assert.ok(resizes>20);if(seconds>=8*3600){assert.ok(last.elapsedSeconds-samples[0].elapsedSeconds>=8*3600&&navigations>100);assert.ok(samples.length>=seconds/90);for(let n=1;n<samples.length;n++)assert.ok(samples[n].wallElapsedSeconds-samples[n-1].wallElapsedSeconds<90,'Sleep/stall interrupted continuous memory coverage');}
 report={at:new Date().toISOString(),runId:ready.runId,status:'passed',scope:'Actual Linux native Chromium/Rust source to three Mac/Chrome CanvasKit Viewers: hardware GPU Worker + CPU Worker + CPU main; continuous PNG/font updates, resize, navigation and real input pixels. JS VM heaps, Wasm arena and Skia GPU cache sampled separately. Persistent Darwin libproc process RSS,virtual address space and physical footprint have before/after PID-start/UID/parent identity checks;physical footprint is not Linux PSS and RSS sums include shared pages. Linux source per-process PSS and cgroup are independently sampled;this is not an atomic cohort or unique whole-session memory bound. Driver/process overhead is outside the logical ledger.',workload:{burst,intervalMs:interval,navigationEvery,samplingMode:'phase-deadline-background-native-libproc-v3',sampleIntervalMs:60000,maxAllowedSampleGapSeconds:90},nativeMemoryObserver:{provider:'darwin-libproc-v1',helperPid:nativeMemorySampler.child.pid,provenance:nativeMemorySampler.provenance},requestedSeconds:seconds,elapsedSeconds:last.elapsedSeconds,cycles:cycle,navigations,resizes,inputs,viewerBrowser:browser.version(),source:ready,first:samples[0],last,sampleCount:samples.length};
}catch(error){
 failure=error;
 const diagnostic={source:await command('snapshot').catch(e=>({error:e.stack})),viewers:await Promise.all(pages.map(async page=>({label:page.label,...await page.evaluate(()=>{const c=document.createElement('canvas');c.width=3;c.height=1;const ctx=c.getContext('2d'),source=document.querySelector('#viewport');for(const [n,[x,y]]of [[20,80],[400,30],[340,30]].entries())ctx.drawImage(source,x,y,1,1,n,0,1,1);return {result:window.remotePaintResult,memory:window.remotePaintMemory,error:document.querySelector('#error').textContent,pixels:[...ctx.getImageData(0,0,3,1).data],size:[source.width,source.height]};}).catch(e=>({error:e.stack}))})))};
 await writeFile(join(directory,'failure.json'),JSON.stringify({at:new Date().toISOString(),runId:ready.runId,cycle,error:error.stack,diagnostic},null,2));await atomicJson(directory,'status.json',{at:new Date().toISOString(),runId:ready.runId,status:'failed',cycle,error:error.message});
}
finally{
 loopDelay.disable();try{await browser?.close();}catch(error){cleanupErrors.push({step:'viewer',error:error.stack});}
 try{nativeMemoryCleanup=await nativeMemorySampler?.close();}catch(error){cleanupErrors.push({step:'native-memory-observer',error:error.stack});}
 try{
  await command('stop');const stopStarted=Date.now();
  while(Date.now()-stopStarted<15000){sourceCleanup=await readFile(join(directory,'source-stopped.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});if(sourceCleanup?.runId===ready.runId)break;await delay(25);}
  assert.equal(sourceCleanup?.runId,ready.runId,'Source cleanup receipt missing');assert.equal(sourceCleanup.status,'closed');assert.equal(sourceCleanup.fixtureListening,false);assert.equal(sourceCleanup.sourceClosed,true);assert.equal(sourceCleanup.brokerClosed,true);assert.ok(sourceCleanup.remainingProcesses.every(row=>row.kind==='node'),'Source descendant survived cleanup');
 }catch(error){cleanupErrors.push({step:'source',error:error.stack});}
 await atomicJson(directory,'cleanup.json',{at:new Date().toISOString(),runId:ready.runId,errors:cleanupErrors,nativeMemoryObserver:nativeMemoryCleanup,source:sourceCleanup});
}
if(failure||cleanupErrors.length){
 if(!failure){failure=new Error('Memory soak cleanup failed');await atomicJson(directory,'failure.json',{at:new Date().toISOString(),runId:ready.runId,cycle,error:failure.message,cleanupErrors});}
 await atomicJson(directory,'status.json',{at:new Date().toISOString(),runId:ready.runId,status:'failed',cycle,error:failure.message,cleanupErrors});throw failure;
}
report.sourceCleanup=sourceCleanup;report.nativeMemoryCleanup=nativeMemoryCleanup;await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));await atomicJson(directory,'status.json',{at:report.at,runId:ready.runId,status:'passed',elapsedSeconds:report.elapsedSeconds,targetSeconds:seconds,cycle,navigations,resizes,inputs});
