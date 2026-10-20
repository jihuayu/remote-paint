// Real test Session owner; production startLive,not a mock data plane.
import assert from 'node:assert/strict';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {startLive} from '../live.mjs';
import {startFrameAgeLive} from './frame-age-observer.mjs';
import {runtimeMetrics} from '../native/runtime-metrics.mjs';
import {LinuxProcessProbe} from '../native/process-memory-linux.mjs';
import {deadline} from './memory-soak-diagnostics.mjs';
async function endpointClosed(origin){const url=new URL(origin);await new Promise((resolve,reject)=>{const socket=net.createConnection({host:url.hostname,port:Number(url.port)});const finish=error=>{socket.destroy();error?reject(error):resolve();};socket.once('connect',()=>finish(new Error('Closed Session endpoint still accepts TCP')));socket.once('error',error=>finish(error.code==='ECONNREFUSED'?null:error));socket.setTimeout(2000,()=>finish(new Error('Closed Session TCP probe timed out')));});}
function closedSource(source){
 assert.equal(source.closed,true);assert.equal(source.latest,null);assert.equal(source.producer,null);assert.equal(source.demand,0);assert.equal(source.encodeDemand,0);assert.equal(source.activityDemand,0);assert.equal(source.browser.isConnected(),false);assert.equal(source.broker.exited,true);assert.equal(source.broker.pending.size,0);assert.equal(source.broker.outputBuffer.buffer.byteLength,0);assert.equal(source.broker.requestMemory.stats().owners,0);assert.equal(source.broker.responses.stats().owners,0);assert.equal(source.capture.binding,null);
}
function sourceRows(metrics,rootPid,brokerPid){
 const rows=new Map(metrics.processes.map(row=>[row.pid,row]));return metrics.processes.filter(row=>{if(row.pid===brokerPid)return true;const seen=new Set();while(row){if(row.pid===rootPid)return true;if(seen.has(row.pid))throw new Error('Observed process ancestry cycle');seen.add(row.pid);row=rows.get(row.ppid);}return false;});
}
export async function createSessionMemoryOwner(fixture,{port=0,host='127.0.0.1',frameAgePoints=null,frameAgeStreaming=false}={}){
 const workload=fixture.create();let live,source,phase='startup',closed=false,closePromise,rootPid,navigationPins=0;const errors=[],transitions=[],probes=new Map(),nodeCalls={map:0,publish:0,awaitPromise:0};
 try{live=await (frameAgePoints?startFrameAgeLive({url:workload.url(),port,host,points:frameAgePoints,streaming:frameAgeStreaming}):startLive({url:workload.url(),port,host}));assert.equal(live.source.nativeAutopublish,true);source=live.source;
  source.on('captureError',error=>{const value={phase,message:error.message,code:error.code};if(['navigation','resize'].includes(phase)&&/Navigation invalidated|Execution context was destroyed|Cannot find context|Inspected target navigated or closed/.test(error.message)){if(transitions.length<32)transitions.push(value);}else if(errors.length<32)errors.push(value);});
  const request=source.broker.request.bind(source.broker);source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
  const lease=source.acquirePageRun();try{await deadline(source.page.evaluate(()=>window.loaded),15000,'initial Session page image');}finally{lease();}
  const cdp=await source.browser.newBrowserCDPSession();try{const{processInfo}=await cdp.send('SystemInfo.getProcessInfo'),browsers=processInfo.filter(row=>row.type==='browser');assert.equal(browsers.length,1);rootPid=Number(browsers[0].id);}finally{await cdp.detach();}
 }catch(error){await live?.close().catch(()=>{});workload.release();throw error;}
 const measure=async()=>{const metrics=await runtimeMetrics(source,{details:true});assert.equal(metrics.processSampling.status,'observed-stable');assert.equal(metrics.pss.completeObservedCohort,true);assert.equal(metrics.cgroup.provenance.processMembershipConfirmed,true);const owned=sourceRows(metrics,rootPid,source.broker.child.pid);return {at:new Date().toISOString(),controllerVm:process.memoryUsage(),metrics,sourceProcesses:owned,sourcePssBytes:owned.reduce((sum,row)=>sum+row.pssBytes,0),workload:workload.stats(),sourceState:{pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,nativeDocumentToken:source.nativeDocumentToken,producer:source.producer,stats:structuredClone(source.stats)},nodeCalls:{...nodeCalls},ownership:{pinnedProcessIdentities:probes.size,navigationPins},errors:[...errors],transitions:[...transitions]};};
 const pin=async()=>{const sample=await measure();assert.ok(sample.sourceProcesses.some(row=>row.pid===rootPid));assert.ok(sample.sourceProcesses.some(row=>row.pid===source.broker.child.pid));for(const row of sample.sourceProcesses){const key=`${row.pid}:${row.startTicks}`;if(probes.has(key))continue;if(probes.size>=1024)throw new Error('Session ownership probe cap');const probe=await LinuxProcessProbe.open(row.pid);try{await probe.sample({details:false,children:false,expectedIdentity:row.identity});}catch(error){await probe.close();throw error;}probes.set(key,{probe,identity:row.identity,kind:row.kind});}return sample;};
 const owner={id:workload.id,number:workload.number,url:live.url,origin:live.origin,streamOrigin:live.streamOrigin,renderer:live.renderer,get source(){return closed?null:source;},get observerProvenance(){return live?.observerProvenance??null;},get peers(){return closed?null:live?.peers??null;},get closed(){return closed;},stats:workload.stats,measure,pin,
  async createConsumerTicket(kind){assert.ok(!closed);return live.createConsumerTicket(kind);},
  async update(n){assert.ok(!closed);phase='update';await deadline(source.page.evaluate(n=>window.update(n),n),15000,'Session image update');source.requestCapture();},
  async resize(viewport){assert.ok(!closed);phase='resize';await deadline(source.resize(viewport),15000,'Session resize');},
  async navigate(n,host='localhost'){assert.ok(!closed);assert.ok(navigationPins<1024,'Navigation ownership fence bound');phase='navigation';const pinned=await pin(),producerIdentity=pinned.sourceProcesses.find(row=>String(row.pid)===source.producer?.split(':')[0])?.identity;assert.ok(producerIdentity,'Current producer is not in the actual pinned Source cohort');navigationPins++;const before={epoch:source.pageEpoch,documentToken:source.nativeDocumentToken,producer:source.producer,ownershipFence:{ordinal:navigationPins,pinnedProcessIdentities:probes.size,producerIdentity}};await source.page.goto(workload.url(host,n),{waitUntil:'domcontentloaded',timeout:15000});await deadline(source.page.evaluate(()=>window.loaded),15000,'crosssite Session image');source.requestCapture();return before;},
  close(){if(closePromise)return closePromise;closed=true;phase='closing';return closePromise=(async()=>{
   const cleanupErrors=[],retired=[];let before,after;try{before=await pin();}catch(error){cleanupErrors.push({step:'pin',error:error.stack});}
   try{await deadline(live.close(),15000,'Session Live close');}catch(error){cleanupErrors.push({step:'live',error:error.stack});}
   workload.release();
   try{const started=performance.now(),remaining=new Map(probes);while(remaining.size){for(const[key,item]of remaining){try{const row=(await item.probe.sample({details:false,children:false})).row;assert.equal(row.startTicks,item.identity.startTicks,'Pinned proc FD must not resolve a new process');}
     catch(error){if(['ENOENT','ESRCH'].includes(error.code)){retired.push({...item.identity,kind:item.kind,retirement:error.code});remaining.delete(key);}else throw error;}}if(remaining.size){assert.ok(performance.now()-started<5000,'Owned Session process still alive,including reparented/zombie identities');await delay(10);}}closedSource(source);assert.equal(live.peers.size,0);await endpointClosed(live.origin);await endpointClosed(live.streamOrigin);after=await measure();}
   catch(error){cleanupErrors.push({step:'retirement-state-metrics',error:error.stack});}
   finally{for(const item of probes.values())try{await item.probe.close();}catch(error){cleanupErrors.push({step:'probe-close',error:error.stack});}probes.clear();}
   const receipt={at:new Date().toISOString(),id:workload.id,number:workload.number,status:cleanupErrors.length?'failed':'closed',workload:workload.stats(),before,after,retired,navigationPins,sourceClosed:source.closed,brokerExited:source.broker.exited,browserConnected:source.browser.isConnected(),nodeCalls:{...nodeCalls},errors:[...errors],transitions:[...transitions],cleanupErrors};live=null;source=null;return receipt;
  })();}
 };
 return owner;
}
