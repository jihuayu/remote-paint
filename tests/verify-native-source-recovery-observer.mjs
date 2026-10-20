// Explicit diagnostic faults exercise real production FrameGate recovery in an
// instrumented Worker. Passive network verifiers never enable these faults.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {startFrameAgeLive,installFrameAgeObserver,beginFrameAge,finishFrameAge,armFrameAgeFault,observeFrameLoss} from './frame-age-observer.mjs';
assert.equal(process.platform,'linux');assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
const output=process.env.REMOTE_PAINT_SOURCE_RECOVERY_OBSERVER_OUTPUT??'artifacts/native-source-recovery-observer';await mkdir(output,{recursive:true});
const html=`<!doctype html><style>body{margin:0;background:white}input{position:absolute;left:20px;top:20px;width:280px;height:40px}#counter{position:absolute;left:400px;top:60px;width:24px;height:24px;background:rgb(0,0,42)}#color{position:absolute;left:40px;top:120px;width:24px;height:24px;background:rgb(31,79,191)}</style><input id=name><div id=counter></div><div id=color></div><script>document.querySelector('input').oninput=e=>{const n=e.target.value.length;document.querySelector('#counter').style.background='rgb('+(n>>>8)+','+(n&255)+',42)';document.querySelector('#color').style.background='rgb(43,161,89)';};</script>`;
const fixture=createServer((req,res)=>res.end(html));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const hash=b=>createHash('sha256').update(b).digest('hex');const versions={browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))};
const browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,args:['--no-sandbox']});
const results=[];let live,context,lossObservation,sourceErrors,pageErrors,phase,trial;
async function cleanup(){
 lossObservation?.close();lossObservation=null;const errors=[];
 for(const close of [()=>context?.close(),()=>live?.close()])try{await close();}catch(e){errors.push(e.message);}
 const cleanup=live?{brokerExited:live.source.broker.exited,pending:live.source.broker.pending.size,requestOwners:live.source.broker.requestMemory.stats().owners,responseOwners:live.source.broker.responses.stats().owners,browserConnected:live.source.browser.isConnected(),errors}:null;
 context=null;live=null;return cleanup;
}
try{
 for(trial=1;trial<=2;trial++){
  phase='startup';sourceErrors=[];pageErrors=[];
  live=await startFrameAgeLive({url:`http://127.0.0.1:${fixture.address().port}`,points:[[412,72],[48,128]],diagnosticFaults:true});assert.equal(live.source.nativeAutopublish,true);
  live.source.on('captureError',e=>sourceErrors.push({message:e.message,code:e.code}));lossObservation=observeFrameLoss(live.source,live.peers);
  const nodeCalls={map:0,publish:0,awaitPromise:0};const request=live.source.broker.request.bind(live.source.broker);live.source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};const send=live.source.capture.cdp.send.bind(live.source.capture.cdp);live.source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
  context=await browser.newContext({viewport:{width:1100,height:900}});const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
  const provenance=await installFrameAgeObserver(page,live.observerProvenance);assert.equal(provenance.diagnosticFaults,true);
  await page.addInitScript(()=>{window.recoveryAcks=new Map();const Socket=WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(typeof data!=='string')return;const m=JSON.parse(data);if(m.type==='InputAck'){if(window.recoveryAcks.size>=64)throw new Error('Recovery verifier ACK bound');window.recoveryAcks.set(m.seq,{accepted:m.accepted,stage:m.stage,at:performance.now()});}});}};});
  const url=new URL(live.url);url.searchParams.set('cpu','1');await page.goto(url.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0&&window.remotePaintResult.worker&&window.remotePaintResult.presentation.mode==='cpu-2d');
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');const bounds=await page.locator('#viewport').boundingBox();await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);await live.source.page.waitForFunction(()=>document.activeElement.id==='name');
  const base=live.source.inputSeq;await page.waitForFunction(seq=>window.remotePaintResult.lastProcessedInputSeq>=seq,base);const initialGeneration=await page.evaluate(()=>window.remotePaintResult.connectionGeneration),windows=[];
  for(const [index,kind,cause]of [[1,'delta-base','missingDeltaBase'],[2,'missing-resource','commitResourcesUnavailable']]){
   phase=kind;const ageWindow=await beginFrameAge(live.source,page),before=lossObservation.snapshot(),fullBefore=await page.evaluate(()=>window.remotePaintResult.fullFrames);
   await armFrameAgeFault(page,kind);const seq=base+index;
   const ack=await page.evaluate(async seq=>{const start=performance.now();document.querySelector('#inputProxy').dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));while(!window.recoveryAcks.has(seq)){if(performance.now()-start>=3000)throw new Error('Recovery actual input ACK deadline');await new Promise(resolve=>setTimeout(resolve,5));}const ack=window.recoveryAcks.get(seq);return {...ack,ms:ack.at-start};},seq);
   assert.ok(ack.accepted&&ack.stage==='input-injected'&&ack.ms>=0&&ack.ms<3000);assert.equal(await live.source.page.locator('input').inputValue(),'x'.repeat(index));
   await page.waitForFunction(({seq,index,generation,fullBefore})=>window.remotePaintResult.connectionGeneration===generation&&window.remotePaintResult.fullFrames>fullBefore&&window.__rpAge.samples.some(s=>s.inputSeq>=seq&&s.pixels[0][0]===0&&s.pixels[0][1]===index&&s.pixels[0][2]===42&&s.pixels[0][3]===255&&JSON.stringify(s.pixels[1])==='[43,161,89,255]'),{seq,index,generation:initialGeneration,fullBefore},{timeout:12000});
   const frameAge=await finishFrameAge(live.source,page,ageWindow,provenance),after=lossObservation.snapshot(),counts=frameAge.protocol.counts;
   assert.equal(counts.diagnosticFaults,1);assert.ok(counts[cause]>0&&counts.recoverAttempts>0&&counts.keyframeRequests>0);assert.equal(counts.keyframeRequests,counts.keyframeRequestDecisions);assert.ok(frameAge.samples.every(s=>s.connectionGeneration===initialGeneration));
   if(kind==='delta-base')assert.ok(counts.commitsSkippedDuringRecovery>0,'Real commit skipped while awaiting missing-base recovery');
   const fault=frameAge.protocol.events.find(e=>e.kind==='fault');assert.equal(fault.cause,kind==='delta-base'?'diagnostic-delta-base':'diagnostic-missing-resource-manifest');
   if(kind==='delta-base'){assert.ok(fault.captureOrdinal>0&&fault.originalBaseFrameId>0);assert.equal(fault.injectedBaseFrameId,fault.frameId+1);}else assert.match(fault.resourceId,/^[a-f0-9]{64}$/);
   windows.push({kind,seq,ack,fullFramesBefore:fullBefore,fullFramesAfter:await page.evaluate(()=>window.remotePaintResult.fullFrames),before,after,frameAge});
  }
  phase='reconnect';const ageWindow=await beginFrameAge(live.source,page),before=lossObservation.snapshot();live.source.requestFreshFrame();await page.waitForFunction(()=>window.__rpAge.samples.length>0);
  const peer=[...live.peers].find(p=>p.id===live.source.control.holder);assert.ok(peer);peer.close(1012,'Recovery observer explicit reconnect');
  await page.waitForFunction(g=>window.remotePaintResult.connectionGeneration>g&&window.remotePaintResult.fullFrames===1,initialGeneration);assert.equal(live.source.control.mode,'agent');
  const frameAge=await finishFrameAge(live.source,page,ageWindow,provenance),after=lossObservation.snapshot();assert.equal(frameAge.protocol.counts.diagnosticFaults,0);assert.equal(frameAge.protocol.counts.recoverAttempts,0);assert.ok(new Set(frameAge.samples.map(s=>s.connectionGeneration)).size>=2);assert.ok(frameAge.protocol.socketCloses.some(e=>e.enabled&&e.window===ageWindow.enabled.window&&e.code===1012));assert.ok(frameAge.protocol.socketStarts.some(e=>e.enabled&&e.window===ageWindow.enabled.window&&e.connectionGeneration>initialGeneration));
  windows.push({kind:'explicit-server-reconnect',leaseRevoked:true,before,after,frameAge});assert.deepEqual(sourceErrors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(nodeCalls,{map:0,publish:0,awaitPromise:0});assert.equal(live.source.stats.errors,0);assert.deepEqual(lossObservation.rejections,[]);
  const result={trial,windows,versions,nodeCalls,sourceErrors:[...sourceErrors],pageErrors:[...pageErrors],sourceStats:structuredClone(live.source.stats),nativeRejections:structuredClone(lossObservation.rejections)};result.cleanup=await cleanup();assert.deepEqual(result.cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0,browserConnected:false,errors:[]});results.push(result);
  await writeFile(output+`/trial-${trial}.json`,JSON.stringify({at:new Date().toISOString(),status:'passed',result},null,2));console.log(JSON.stringify({trial,status:'passed',windows:windows.map(w=>({kind:w.kind,counts:w.frameAge.protocol.counts,paired:w.frameAge.coverage.paired})),cleanup:result.cleanup}));
 }
 await writeFile(output+'/recovery.json',JSON.stringify({at:new Date().toISOString(),status:'passed',scope:'Two independent actual native Sources/normal versioned static builder/real CPU Worker FrameGate. Explicitdiagnosticmodule modifiesone real incomingdelta base and separately omitsone actualnew ResourceManifest,thenreal production recover/RequestKeyframe/Gatewayfullbaseline/pixels/inputACK/nohiddenreconnect. Actualserver1012 closes/reconnects andrevokeslease. Passiveobservers have nofaultarmsormutations. This provesdiagnosticbranchmetrics,notorganicworkloadloss/fullN1/fullB1.',versions,results},null,2));
}catch(error){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',phase,trial,error:error.stack,sourceErrors,pageErrors,results},null,2));throw error;}
finally{await cleanup();await browser.close();await new Promise(resolve=>fixture.close(resolve));}
