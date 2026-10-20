import assert from 'node:assert/strict';
import {appendFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {calibrateFrameAge,calibratedLinuxSharedFrameAge,frameAgeDistribution} from './frame-age-observer.mjs';

export function streamingCoverage(raw,previous){
 assert.deepEqual(raw.errors,[]);assert.equal(raw.workerCount,1);assert.equal(raw.pending,0);
 assert.equal(raw.start.window,previous.window);assert.equal(raw.start.all,previous.all);assert.equal(raw.start.protocolOrdinal,previous.protocolOrdinal);
 const expected=raw.end.all-raw.start.all;assert.ok(Number.isSafeInteger(expected)&&expected>=0&&expected<=4096);
 assert.equal(raw.end.window,raw.start.window);assert.equal(raw.samples.length,expected);assert.equal(raw.paired,expected);assert.equal(raw.end.observed,expected);assert.equal(raw.end.productionFrames-raw.start.productionFrames,expected);
 const events=raw.protocolEvents.filter(e=>e.enabled&&e.window===raw.start.window);assert.equal(events.length,raw.end.protocolOrdinal-raw.start.protocolOrdinal);
 events.forEach((event,i)=>{assert.equal(event.ordinal,raw.start.protocolOrdinal+i+1);assert.ok(Number.isSafeInteger(event.connectionGeneration)&&event.connectionGeneration>0);assert.ok(Number.isFinite(event.workerMs));assert.ok(['recover','keyframe-requested','commit-skipped'].includes(event.kind),'Passive streaming observer must not inject faults');});
 const keys=new Set();raw.samples.forEach((sample,i)=>{
  assert.equal(sample.window,raw.start.window);assert.equal(sample.windowOrdinal,i+1);assert.equal(sample.commitOrdinal,raw.start.all+i+1);assert.equal(sample.productionFramePaired,true);
  const key=[sample.connectionGeneration,sample.pageEpoch,sample.viewportVersion,sample.frameId].join(':');assert.equal(keys.has(key),false);keys.add(key);
  assert.ok(sample.pixels.length>0&&sample.pixels.every(p=>p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)));
  assert.ok(Number.isFinite(sample.pixelReadMs)&&sample.pixelReadMs>=0);assert.ok([sample.requiredResourceCount,sample.requiredResourceBytes,sample.largestRequiredResourceBytes].every(n=>Number.isSafeInteger(n)&&n>=0));assert.ok(sample.requiredResourceCount<=256&&sample.requiredResourceBytes>=sample.largestRequiredResourceBytes);assert.equal(sample.requiredResourceCount===0,sample.requiredResourceBytes===0);assert.equal(sample.requiredResourceBytes===0,sample.largestRequiredResourceBytes===0);
 });
 return {successfulCommits:expected,pixelSamples:expected,normalFrameEvents:expected,paired:expected,missing:0,fraction:1};
}

export async function startFrameAgeStream(page,provenance,{nativeProbe,directory}){
 assert.equal(provenance.streaming,true);assert.equal(provenance.diagnosticFaults,false);assert.equal(typeof nativeProbe,'function');
 const proofs=new Map(),history=[];let active=true,busy=false,failed=false,ordinal=0;
 const totals={windows:0,successfulCommits:0,pixelSamples:0,normalFrameEvents:0,paired:0,missing:0,protocolEvents:0,socketStarts:0,socketCloses:0,minAgeMs:null,maxAgeMs:null,maxUncertaintyMs:null,maxPixelReadMs:null};
 function register(witness){
  const proof=witness.provenance?.linuxMonotonic;assert.equal(proof?.schema,'linux-native-monotonic-probe-v1');const producer=witness.provenance.producer;assert.equal(producer.split(':')[0],String(proof.rendererIdentity.pid));const key=witness.pageEpoch+':'+producer;
  if(proofs.has(key)){assert.deepEqual(proofs.get(key).rendererIdentity,proof.rendererIdentity);assert.equal(proofs.get(key).domainId,proof.domainId);}else{assert.ok(proofs.size<1024);if(proofs.size)assert.equal(proof.domainId,proofs.values().next().value.domainId);proofs.set(key,proof);}
 }
 async function calibrate(){const value=await calibrateFrameAge(null,page,{nativeProbe,sharedLinuxClock:true});for(const sample of value.native.samples)register(sample);history.push(value);if(history.length>6)history.shift();return value;}
 await calibrate();await page.waitForTimeout(100);const enabled=await page.evaluate(()=>window.__rpAge.request('enable'));let previous=enabled;
 const lifetime={initialAll:enabled.all,initialWindow:enabled.window,initialWorkerMs:enabled.now};
 return {totals,lifetime,get active(){return active;},async witness(){const value=await nativeProbe();register(value);return value;},async drain({stop=false}={}){
  assert.ok(active&&!busy&&(!failed||stop),'No overlapping stream drains, continued failed stream or drain after stop');busy=true;
  try{
   const reply=await page.evaluate(operation=>window.__rpAge.request(operation),stop?'disable':'rotate');
   // Once disable replied, cleanup must not send it again if persistence or
   // post-window calibration fails. Retain the failure as an incomplete window.
   if(stop){assert.equal(reply.operation,'disable');active=false;}
   const raw=reply.completed;assert.ok(raw);const id=++ordinal;
   // Persist the exact completed raw window before calibrating or validating.
   await appendFile(join(directory,'stream-raw-windows.jsonl'),JSON.stringify({id,at:new Date().toISOString(),raw})+'\n');
   const after=await calibrate(),coverage=streamingCoverage(raw,previous);if(!stop){assert.equal(reply.nextWindow,previous.window+1);previous={...reply,window:reply.nextWindow,observed:0};}
   assert.equal(provenance.actualServed.length,1);assert.equal(provenance.actualServed[0].status,200);assert.equal(provenance.actualServed[0].sha256,provenance.served[0].instrumentedServedSha256);if(id===1)await writeFile(join(directory,'stream-observer-provenance.json'),JSON.stringify(provenance)+'\n',{flag:'wx'});
   let before=null,samples=[];
   if(raw.samples.length){
    const minNative=Math.min(...raw.samples.map(s=>s.captureStartedMicros/1000)),minWorker=Math.min(...raw.samples.map(s=>s.observedMs));
    const select=(kind,min)=>{const rows=history.filter(c=>c[kind].best.domainMs<=min);assert.ok(rows.length,'No retained actual calibration brackets the earliest '+kind+' stamp');return rows.reduce((a,b)=>a[kind].best.domainMs>=b[kind].best.domainMs?a:b)[kind];};
    before={native:select('native',minNative),worker:select('worker',minWorker)};
    samples=raw.samples.map(sample=>{const proof=proofs.get(sample.pageEpoch+':'+sample.producer);assert.ok(proof,'Frame has no actually probed Source renderer identity');return {...sample,age:calibratedLinuxSharedFrameAge(sample,before,after,proof)};});
   }
   const events=raw.protocolEvents.filter(e=>e.enabled&&e.window===raw.start.window),counts={recoverAttempts:0,keyframeRequests:0,commitsSkipped:0};for(const event of events){if(event.kind==='recover'){assert.equal(typeof event.willRequestKeyframe,'boolean');assert.ok(['missing-delta-base','commit-resources-unavailable'].includes(event.cause));counts.recoverAttempts++;}else if(event.kind==='keyframe-requested')counts.keyframeRequests++;else{assert.equal(event.cause,'awaiting-recovery-scene');counts.commitsSkipped++;}}
   const result={id,operation:reply.operation,coverage,window:raw.start.window,start:raw.start,end:raw.end,age:samples.length?frameAgeDistribution(samples.map(s=>s.age.estimateMs)):null,ageLower:samples.length?frameAgeDistribution(samples.map(s=>s.age.lowerMs)):null,ageUpper:samples.length?frameAgeDistribution(samples.map(s=>s.age.upperMs)):null,clockUncertainty:samples.length?frameAgeDistribution(samples.map(s=>s.age.uncertaintyMs)):null,pixelObserverCost:samples.length?frameAgeDistribution(samples.map(s=>s.pixelReadMs)):null,protocol:{counts,events,socketStarts:raw.socketStarts,socketCloses:raw.socketCloses},calibration:{before,after},samples};
   for(const key of ['successfulCommits','pixelSamples','normalFrameEvents','paired','missing'])totals[key]+=coverage[key];totals.windows++;totals.protocolEvents+=events.length;totals.socketStarts+=raw.socketStarts.length;totals.socketCloses+=raw.socketCloses.length;
   if(result.age){totals.minAgeMs=totals.minAgeMs===null?result.age.minMs:Math.min(totals.minAgeMs,result.age.minMs);totals.maxAgeMs=Math.max(totals.maxAgeMs??-Infinity,result.age.maxMs);totals.maxUncertaintyMs=Math.max(totals.maxUncertaintyMs??0,result.clockUncertainty.maxMs);totals.maxPixelReadMs=Math.max(totals.maxPixelReadMs??0,result.pixelObserverCost.maxMs);}
   assert.equal(totals.successfulCommits,reply.all-lifetime.initialAll);assert.equal(totals.paired,totals.successfulCommits);if(stop){lifetime.finalAll=reply.all;lifetime.finalWorkerMs=reply.now;lifetime.finalWindow=reply.window;lifetime.producerProofs=proofs.size;}
   await appendFile(join(directory,'stream-windows.jsonl'),JSON.stringify({at:new Date().toISOString(),...result})+'\n');
   return result;
  }catch(error){failed=true;throw error;}finally{busy=false;}
 }};
}
