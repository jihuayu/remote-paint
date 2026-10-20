// Optional long-run diagnostics. All three production Viewer VMs remain alive;
// only CPUWorker has synchronous exact-commit pixel instrumentation.
import assert from 'node:assert/strict';
import {appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {installFrameAgeObserver} from './frame-age-observer.mjs';
import {startFrameAgeStream} from './frame-age-stream.mjs';

export async function drainSessionMarkerWindow(stream,readCycle,number,{stop=false,onBoundary=async()=>{}}={}){
 assert.equal(typeof readCycle,'function');assert.ok(Number.isSafeInteger(number)&&number>0&&number<=65535);
 const read=()=>{const n=readCycle();assert.ok(Number.isSafeInteger(n)&&n>=0&&n<=65535,'Invalid actual primary update counter');return n;};
 const invocationCycle=read(),result=await stream.drain({stop}),throughCycle=read();
 assert.ok(throughCycle>=invocationCycle,'Primary update counter went backwards');
 assert.equal(typeof onBoundary,'function');await onBoundary({window:result.window,invocationCycle,throughCycle});
 // Updates may continue while the Worker handles rotate and while the closed
 // raw window is calibrated. Validate against the actual counter read after
 // that boundary, rather than the stale value at the drain invocation.
 for(const s of result.samples){assert.equal(s.pixels.length,4);for(const p of s.pixels){assert.ok(p.length===4&&p.every(v=>Number.isInteger(v)&&v>=0&&v<=255));}for(const p of s.pixels.slice(0,2)){const n=p[0]+256*p[1];assert.ok((p[2]===199&&p[3]===255&&n<=throughCycle)||p.every(v=>v===255),'Unknown actual image/DOM marker');}const p=s.pixels[2];assert.ok(JSON.stringify(p)===JSON.stringify([number&255,(number>>8)&255,211,255])||p.every(v=>v===255),'Unknown observed Session identity');}
 return {result,bounds:{invocationCycle,throughCycle}};
}

export function createSessionInputFrameProofs(persist){
 const pending=[];let queued=0,proved=0;
 return {get stats(){return {queued,proved,pending:pending.length,limit:128};},enqueue(textCount,ack){
  assert.ok(Number.isSafeInteger(textCount)&&textCount>0&&pending.length<128);
  assert.equal(ack.accepted,true);assert.equal(ack.stage,'input-injected');
  for(const key of ['seq','pageEpoch','viewportVersion'])assert.ok(Number.isSafeInteger(ack[key])&&ack[key]>0);
  assert.ok(!pending.some(p=>p.ack.seq===ack.seq&&p.ack.pageEpoch===ack.pageEpoch&&p.ack.viewportVersion===ack.viewportVersion));
  pending.push({ordinal:++queued,textCount,ack});
 },async consume(window){
  for(let i=0;i<pending.length;){const p=pending[i],s=window.samples.find(s=>{
   const pixel=s.pixels[3];return s.productionFramePaired===true&&s.pageEpoch===p.ack.pageEpoch&&s.viewportVersion===p.ack.viewportVersion&&Number.isSafeInteger(s.inputSeq)&&s.inputSeq>=p.ack.seq&&pixel?.length===4&&pixel[2]===42&&pixel[3]===255&&pixel[0]*256+pixel[1]>=p.textCount;
  });if(!s){i++;continue;}
  // The sender ACK and CPUWorker pixel share Session watermarks, not a clock.
  // Its exact frame sample was already persisted by startFrameAgeStream.
  await persist({ordinal:p.ordinal,textCount:p.textCount,ack:p.ack,window:window.window,commitOrdinal:s.commitOrdinal,connectionGeneration:s.connectionGeneration,pageEpoch:s.pageEpoch,viewportVersion:s.viewportVersion,frameId:s.frameId,inputSeq:s.inputSeq,pixel:s.pixels[3],age:s.age,clockScope:'No subtraction between sender page and CPUWorker performance origins.'});pending.splice(i,1);proved++;
  }
 },finish(){assert.equal(pending.length,0,'Primary input lacks a same-epoch/viewport/watermark/pixel CPUWorker commit');assert.equal(proved,queued);}};
}

export function validateSessionRttWelcome(message,renderer){
 assert.equal(message.type,'Welcome');assert.equal(message.protocol,4);assert.deepEqual(message.renderer,renderer);assert.equal(message.consumerKind,'recording');assert.equal(message.ackStage,'consumer-released');assert.equal(message.input,false);assert.equal(message.inputFeedback,false);assert.equal(message.control,null);
 return true;
}

export async function prepareSessionLongObservation(page,ready){
 const provenance=structuredClone(ready.observerProvenance);
 assert.equal(provenance?.streaming,true);assert.equal(provenance.diagnosticFaults,false);
 assert.deepEqual(provenance.points,[[20,80],[400,30],[450,30],[340,30]]);
 await installFrameAgeObserver(page,provenance);return provenance;
}

export async function startSessionLongObservation({page,ready,provenance,command,directory,readCycle,impaired=false}){
 assert.equal(typeof readCycle,'function');
 const save=(name,value)=>appendFile(join(directory,name),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
 const rttConsumer={kind:'recording',ackStage:'consumer-released',welcomeValidated:false,releaseMessagesQueued:0,receivedBinaryBytes:0,scope:'Read-onlyconsumerusingrecordinglifetime acrossscopechanges;bytesreleased,norender/recordingartifactclaim. Counterscoverwholeconnection,notexactCPUWorkerenabledwindow.'};
 const errors=[],rtt={count:0,minMs:null,maxMs:null};let echo,stream,networkActive=false,closed,lossOrdinal=0,lossWindow=0,windows=0;
 let sourceCloseLoss=null;
 const inputs=createSessionInputFrameProofs(value=>save('session-input-frame-proofs.jsonl',value));
 function fail(message){if(errors.length<32)errors.push(message.slice(0,1024));}
 const nativeProbe=async()=>(await command('clock-probe-shared')).nativeProbe;
 async function loss(phase){
  const result=(await command('loss-drain')).loss;await save('session-loss-windows.jsonl',{phase,loss:result});
  assert.equal(result.observerFailure,null);assert.equal(result.windowOrdinal,++lossWindow);assert.equal(result.afterObservationOrdinal,lossOrdinal);assert.equal(result.throughObservationOrdinal-result.afterObservationOrdinal,result.rejections.length);assert.equal(result.receivedRejectionEvents,result.rejectionCount);lossOrdinal=result.throughObservationOrdinal;
  result.rejections.forEach((r,i)=>assert.equal(r.observationOrdinal,result.afterObservationOrdinal+i+1));return result;
 }
 async function ping(){
  const value=await new Promise((resolve,reject)=>{const token=randomUUID(),start=performance.now(),timer=setTimeout(()=>{echo.off('pong',pong);reject(new Error('Actual Gateway ping exceeded3000ms'));},3000);const pong=data=>{if(data.toString()!==token)return;clearTimeout(timer);echo.off('pong',pong);resolve(performance.now()-start);};echo.on('pong',pong);echo.ping(token,error=>{if(error){clearTimeout(timer);echo.off('pong',pong);reject(error);}});});
  assert.ok(value>=0&&value<3000);rtt.count++;rtt.minMs=Math.min(rtt.minMs??Infinity,value);rtt.maxMs=Math.max(rtt.maxMs??0,value);return value;
 }
 async function openEcho(){
  const grant=(await command('rtt-consumer-ticket')).grant;assert.equal(grant.consumerKind,'recording');assert.equal(grant.ackStage,'consumer-released');assert.equal(grant.capability,'scene-consumer-v1');assert.equal(grant.origin,new URL(ready.primary.url).origin);assert.deepEqual(grant.renderer,ready.primary.renderer);
  const url=new URL(grant.url),streamOrigin=new URL(ready.primary.streamOrigin);assert.ok(url.protocol==='ws:'&&url.host===streamOrigin.host&&url.pathname==='/consume'&&!url.searchParams.has('key'),'Invalid read-only RTT endpoint');assert.ok(/^[a-f0-9]{64}$/.test(url.searchParams.get('ticket')??''),'Invalid bounded RTT consumer ticket');
  echo=new WebSocket(url.href,{origin:grant.origin,handshakeTimeout:3000});
  let accept,reject;const admitted=new Promise((resolve,no)=>{accept=resolve;reject=no;}),timer=setTimeout(()=>reject(new Error('RTT read-only consumer handshake exceeded3000ms')),3000);admitted.catch(()=>{});
  echo.on('error',()=>{fail('ACK-only read-only Gateway consumer socket error');reject(new Error('RTT read-only consumer socket error'));});
  echo.on('close',()=>{if(!rttConsumer.welcomeValidated)reject(new Error('RTT consumer closed before authorization'));else if(!closed)fail('RTT consumer closed unexpectedly');});
  echo.on('message',(bytes,binary)=>{if(binary){rttConsumer.receivedBinaryBytes+=bytes.byteLength;return;}try{const message=JSON.parse(bytes);if(message.type==='Welcome'){assert.equal(rttConsumer.welcomeValidated,false);validateSessionRttWelcome(message,grant.renderer);rttConsumer.welcomeValidated=true;accept();}else if(message.type==='FrameCommit'){assert.ok(rttConsumer.welcomeValidated);assert.ok(Number.isSafeInteger(message.frameId)&&message.frameId>0&&Number.isSafeInteger(message.pageEpoch)&&message.pageEpoch>0);echo.send(JSON.stringify({type:'FrameAck',pageEpoch:message.pageEpoch,frameId:message.frameId,stage:'consumer-released'}));rttConsumer.releaseMessagesQueued++;}}catch{fail('Read-only RTT consumer received invalid protocol metadata');reject(new Error('Invalid read-only RTT consumer authorization or metadata'));echo.terminate();}});
  echo.once('open',()=>{try{echo.send(JSON.stringify({type:'Hello',protocol:4,renderer:grant.renderer,consumerKind:'recording',capabilities:['scene-consumer-v1']}));}catch{fail('RTT consumer Hello could not be queued');reject(new Error('RTT consumer Hello failed'));}});
  try{await admitted;await save('session-rtt-consumer.jsonl',{phase:'authorized',...rttConsumer});}finally{clearTimeout(timer);}
 }

 async function close(){return closed??=(async()=>{
  const failures=[];
  try{if(stream?.active)await stream.drain({stop:true});}catch(error){failures.push({step:'frame-age-stop',error:error.message});}
  try{if(networkActive){const removed=(await command('network-stop')).network;await save('session-network-windows.jsonl',{phase:'removed',network:removed});assert.equal(removed.status,'removed');networkActive=false;}}catch(error){failures.push({step:'network-stop',error:error.message});}
  try{if(echo&&echo.readyState!==WebSocket.CLOSED)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{echo.terminate();reject(new Error('ACK-only Gateway peer close exceeded3000ms'));},3000);echo.once('close',()=>{clearTimeout(timer);resolve();});echo.close();});}catch(error){failures.push({step:'echo-close',error:error.message});}
  await save('session-observation-cleanup.jsonl',{failures,errors,activeStream:stream?.active??false,networkActive,echoState:echo?.readyState??null,rttConsumer});assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);return {status:'closed',failures,errors};
 })();}
 try{
  // Both variants include the same read-only recording-lifetime consumer.
  await openEcho();await loss('before-enabled-window');
  if(impaired){const network=(await command('network-start')).network;networkActive=true;await save('session-network-windows.jsonl',{phase:'started',network});}
  const measuredRttMs=[];for(let n=0;n<10;n++)measuredRttMs.push(await ping());await save('session-network-windows.jsonl',{phase:'initial-rtt',impaired,measuredRttMs});
  stream=await startFrameAgeStream(page,provenance,{nativeProbe,directory});
 }catch(error){try{await close();}catch(cleanup){error.cleanup=cleanup.message;}throw error;}
 return {async finishSource(value){await save('session-loss-windows.jsonl',{phase:'after-source-close',loss:value});assert.equal(value.observerFailure,null);assert.equal(value.windowOrdinal,lossWindow+1);assert.equal(value.afterObservationOrdinal,lossOrdinal);assert.equal(value.throughObservationOrdinal-value.afterObservationOrdinal,value.rejections.length);assert.equal(value.receivedRejectionEvents,value.rejectionCount);value.rejections.forEach((r,i)=>assert.equal(r.observationOrdinal,lossOrdinal+i+1));sourceCloseLoss={windowOrdinal:value.windowOrdinal,throughObservationOrdinal:value.throughObservationOrdinal};},enqueueInput:(n,ack)=>inputs.enqueue(n,ack),witness:()=>stream.witness(),close,get active(){return stream.active;},get summary(){return {impaired,windows,frameAge:stream.totals,lifetime:stream.lifetime,inputProofs:inputs.stats,rtt,receivedNativeRejections:lossOrdinal,lossWindows:lossWindow,sourceCloseLoss,rttConsumer,errors};},async drain({stop=false}={}){
  const {result,bounds}=await drainSessionMarkerWindow(stream,readCycle,ready.primary.number,{stop,onBoundary:b=>save('session-marker-boundaries.jsonl',b)});
  await inputs.consume(result);const sourceLoss=await loss(stop?'final-enabled-window':'enabled-window'),measuredRttMs=[];for(let n=0;n<3;n++)measuredRttMs.push(await ping());
  let network=null;if(impaired){network=(await command('network-snapshot')).network;await save('session-network-windows.jsonl',{phase:'window',window:result.window,network,measuredRttMs});}
  assert.deepEqual(errors,[]);windows++;await save('session-observation-windows.jsonl',{cycle:bounds.throughCycle,cycleBounds:bounds,stop,window:result.window,coverage:result.coverage,age:result.age,ageLower:result.ageLower,ageUpper:result.ageUpper,clockUncertainty:result.clockUncertainty,pixelObserverCost:result.pixelObserverCost,protocol:result.protocol.counts,sourceLossWindow:sourceLoss.windowOrdinal,measuredRttMs,inputProofs:inputs.stats});
  if(stop){inputs.finish();assert.ok(inputs.stats.proved>0);assert.ok(stream.totals.paired>=400);assert.equal(stream.totals.missing,0);if(impaired){assert.ok(network.counters.bytes>64*1024*1024&&network.counters.drops>0);}}
  return {window:result.window,paired:result.coverage.paired,inputProofs:inputs.stats};
 }};
}
