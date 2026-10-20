// Private file-channel driver for long-lived primary Viewers plus secondary
// Session churn. Only the normal Viewer HTTP/WS ports need publication.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startSessionMemoryFixture} from './session-memory-fixture.mjs';
import {createSessionMemoryOwner} from './session-memory-owner.mjs';
import {atomicJson,deadline} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'linux');assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
const directory=resolve(process.env.REMOTE_PAINT_SESSION_LONG_DIR??'artifacts/session-longload'),port=Number(process.env.REMOTE_PAINT_SESSION_LONG_PORT??39546),runId=randomUUID();assert.ok(Number.isInteger(port)&&port>=1024&&port<65532);await mkdir(directory,{recursive:true,mode:0o700});for(const name of ['requests','responses'])await mkdir(join(directory,name),{recursive:true});
const frameAge=process.env.REMOTE_PAINT_SESSION_LONG_FRAME_AGE==='1';
const fixture=await startSessionMemoryFixture(),handled=new Set(),stats={created:0,closed:0,crosssite:0,leaseExpired:0};let primary,secondary=null,timer,closing=false,stopPromise,primaryHost='127.0.0.1',lastClosed=null,leaseProbe=null;
const atomic=(name,value)=>atomicJson(directory,name,value),event=value=>appendFile(join(directory,'source-events.jsonl'),JSON.stringify({at:new Date().toISOString(),runId,...value})+'\n');
function monitor(owner){
 const source=owner.source,health={pageCrashed:false,browserDisconnected:false,brokerExited:false,closing:false},revokes={},records=[];let renews=0;
 source.page.on('crash',()=>{health.pageCrashed=true;void event({kind:'page-crash',session:owner.id,closing:health.closing});});source.browser.on('disconnected',()=>{health.browserDisconnected=true;void event({kind:'browser-disconnected',session:owner.id,closing:health.closing});});source.broker.child.on('exit',(code,signal)=>{health.brokerExited=true;void event({kind:'broker-exit',session:owner.id,closing:health.closing,code,signal});});
 const revoke=source.control.revoke.bind(source.control),renew=source.control.renew.bind(source.control);source.control.revoke=async(reason,...args)=>{const value=await revoke(reason,...args),key=reason??'released';revokes[key]=(revokes[key]??0)+1;records.push({at:Date.now(),reason:key,mode:source.control.mode,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});if(records.length>32)records.shift();return value;};source.control.renew=(...args)=>{const value=renew(...args);renews++;return value;};
 return {health,revokes,records,get renews(){return renews;},closing(){health.closing=true;}};
}
let primaryMonitor,secondaryMonitor;
async function state(owner,monitor){if(!owner)return null;const source=owner.source;return {id:owner.id,number:owner.number,workload:owner.stats(),pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:source.viewport,producer:source.producer,nativeDocumentToken:source.nativeDocumentToken,inputSeq:source.inputSeq,stats:source.stats,control:source.control.state(),health:{...monitor.health},...await deadline(source.page.evaluate(()=>({cycle:window.cycle,inputLength:document.querySelector('input').value.length,sessionNumber:window.sessionNumber})),2000,'Session state').catch(error=>({pageStateError:error.message}))};}
async function leaseState(){
 if(!leaseProbe)return null;const source=primary.source,records=primaryMonitor.records.filter(r=>r.at>=leaseProbe.startedAt&&r.reason==='expired');
 if(records.length&&!leaseProbe.completed){const record=records.at(-1);assert.equal(source.control.mode,'agent');assert.equal(source.pageEpoch,leaseProbe.pageEpoch);assert.equal(source.viewportVersion,leaseProbe.viewportVersion);assert.equal(primaryMonitor.renews,leaseProbe.renewsAtStart);assert.ok(record.at>=leaseProbe.expiresAt);leaseProbe.completed=true;leaseProbe.completedAt=record.at;stats.leaseExpired++;await event({kind:'actual-default-lease-expired',session:primary.id,probe:{...leaseProbe}});}
 return {...leaseProbe};
}
async function closeSecondary(){
 assert.ok(secondary,'No secondary Session');secondaryMonitor.closing();const receipt=await secondary.close();assert.equal(receipt.status,'closed');assert.deepEqual(receipt.errors,[]);assert.equal(receipt.after.sourceProcesses.length,0);await appendFile(join(directory,'closed-sessions.jsonl'),JSON.stringify(receipt)+'\n');stats.closed++;lastClosed={id:receipt.id,number:receipt.number,retiredProcesses:receipt.retired.length,imageBytes:receipt.workload.imageBytes,status:receipt.status,nodeCalls:receipt.nodeCalls,afterPss:receipt.after.metrics.pss,cgroup:receipt.after.metrics.cgroup,controllerVm:receipt.after.controllerVm};secondary=null;secondaryMonitor=null;return lastClosed;
}
const stop=()=>stopPromise??=(async()=>{
 closing=true;clearTimeout(timer);const errors=[];let primaryReceipt;
 try{if(secondary)await closeSecondary();}catch(error){errors.push({step:'secondary',error:error.stack});}
 try{primaryMonitor?.closing();primaryReceipt=await primary?.close();assert.equal(primaryReceipt?.status,'closed');stats.closed++;}catch(error){errors.push({step:'primary',error:error.stack});}
 try{await fixture.close();}catch(error){errors.push({step:'fixture',error:error.stack});}
 const remaining=primaryReceipt?.after?.metrics,receipt={at:new Date().toISOString(),runId,status:errors.length?'failed':'closed',errors,stats,primary:primaryReceipt,fixtureListening:fixture.listening,activeSessions:fixture.activeSessions,remainingProcesses:remaining?.processes,processSampling:remaining?.processSampling,pss:remaining?.pss,cgroupProvenance:remaining?.cgroup.provenance};await atomic('source-stopped.json',receipt);if(errors.length)process.exitCode=1;return receipt;
})();
try{
 primary=await createSessionMemoryOwner(fixture,{port,host:'0.0.0.0',frameAgePoints:frameAge?[[20,80],[400,30],[450,30]]:null});primaryMonitor=monitor(primary);stats.created++;await primary.pin();await atomic('ready.json',{at:new Date().toISOString(),runId,primary:{id:primary.id,number:primary.number,url:primary.url},observerProvenance:primary.observerProvenance,platform:process.platform,architecture:process.arch,browser:primary.source.browser.version(),scope:'One long-lived primary Source with crosssite/real30sleaseexpiry;secondary Sessioncreation/working-setpressure/destruction in same controller. Private file commands,normal production FrameGate/Viewer.'});console.log(JSON.stringify({event:'ready',runId,port}));
}catch(error){await stop();throw error;}
async function operation(command){
 if(command.op==='clock-probe'){
  assert.equal(frameAge,true);const source=primary.source,binding=source.capture.binding?.config.id,epoch=source.pageEpoch,version=source.viewportVersion,document=source.nativeDocumentToken;assert.ok(binding);
  const reply=await source.capture.command('scheduler',binding);assert.equal(source.capture.binding?.config.id,binding);assert.equal(source.pageEpoch,epoch);assert.equal(source.viewportVersion,version);assert.equal(source.nativeDocumentToken,document);assert.equal(reply.ok,true);
  return {nativeProbe:{reply,pageEpoch:epoch,viewportVersion:version,provenance:{kind:'actual-current-Source-private-scheduler',sourceId:primary.id,bindingId:binding,documentToken:document,producer:source.producer}}};
 }
 if(command.op==='create-secondary'){assert.equal(secondary,null);secondary=await createSessionMemoryOwner(fixture,{port:port+2,host:'0.0.0.0'});secondaryMonitor=monitor(secondary);stats.created++;await secondary.pin();return {secondary:{id:secondary.id,number:secondary.number,url:secondary.url}};}
 if(command.op==='close-secondary'){assert.equal(command.sessionId,secondary?.id,'Stale secondary Session');return {closed:await closeSecondary()};}
 if(command.op==='lease-probe'){
  assert.ok(!leaseProbe||leaseProbe.completed);const source=primary.source;assert.equal(source.control.ttl,30000);if(source.control.mode!=='agent')await source.control.revoke('lease-probe-setup');const peers=[...source.control.peers.values()].filter(peer=>peer.ready&&!peer.closed);assert.ok(peers.length>=3);const grant=await source.control.acquire(peers[0].id,{sessionId:source.control.sessionId,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});
  // Explicit abandoned grant: valid existing Viewer peer;the caller does not
  // publish ControlGranted,so that client cannot renew a token it never got.
  // The production timer/cleanup runs unchanged at its default30s.
  leaseProbe={startedAt:Date.now(),expiresAt:grant.expiresAt,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,renewsAtStart:primaryMonitor.renews,completed:false,scope:'Explicit abandoned server API grant to an actually attached ready Viewer;no ControlGranted token delivery,not organic packet loss or physical input.'};await event({kind:'lease-probe-started',session:primary.id,probe:leaseProbe});return {leaseProbe};
 }
 if(command.op==='metrics'||command.op==='snapshot'){
  const primaryState=await state(primary,primaryMonitor),secondaryState=await state(secondary,secondaryMonitor),measured=await primary.measure();assert.deepEqual(measured.errors,[]);assert.equal(measured.metrics.pss.completeObservedCohort,true);const value={at:new Date().toISOString(),runId,stats:{...stats},primary:primaryState,secondary:secondaryState,leaseProbe:await leaseState(),metrics:measured.metrics,lastClosed};await appendFile(join(directory,'source-runtime.jsonl'),JSON.stringify(value)+'\n');return value;
 }
 if(command.op==='stop')return {stopped:true};
 const owner=command.target==='primary'?primary:command.target==='secondary'?secondary:null;assert.ok(owner,'Unknown Session target');assert.equal(command.sessionId,owner.id,'Stale Session command');
 if(command.op==='update'){assert.ok(Number.isInteger(command.cycle)&&command.cycle>0&&command.cycle<=65535);await owner.update(command.cycle);}
 else if(command.op==='resize'){if(owner===primary)assert.ok(!leaseProbe||leaseProbe.completed,'Cannot invalidate an active expiry probe');await owner.resize(command.viewport);}
 else if(command.op==='navigate'){assert.equal(owner,primary);assert.ok(!leaseProbe||leaseProbe.completed,'Cannot invalidate an active expiry probe');primaryHost=primaryHost==='127.0.0.1'?'localhost':'127.0.0.1';const before=await primary.navigate(command.cycle,primaryHost);stats.crosssite++;return {before,primary:await state(primary,primaryMonitor)};}
 else throw new Error('Unknown Session longload operation');
 return {state:await state(owner,owner===primary?primaryMonitor:secondaryMonitor),leaseProbe:await leaseState()};
}
async function poll(){if(closing)return;try{
 const files=await readdir(join(directory,'requests')),file=files.find(name=>/^[a-f0-9-]{36}\.json$/.test(name)&&!handled.has(name.slice(0,-5)));if(!file)return;const command=JSON.parse(await readFile(join(directory,'requests',file),'utf8'));if(command.runId!==runId)return;handled.add(command.id);if(handled.size>1024)handled.delete(handled.values().next().value);
 try{const value=await operation(command);await atomic(`responses/${command.id}.json`,{id:command.id,...value});if(command.op==='stop')await stop();}catch(error){await atomic(`responses/${command.id}.json`,{id:command.id,error:error.stack});}
 }catch(error){if(error.code!=='ENOENT')console.error(error.stack);}finally{if(!closing)timer=setTimeout(()=>void poll(),25);}}
void poll();process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
