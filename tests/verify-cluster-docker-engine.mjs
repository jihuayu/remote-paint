// Opt-in host adapter for the original Engine provider and cluster Worker.
// Uses the operator's existing Unix socket; no host listener or socket mount.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,open,readFile,writeFile,copyFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../service/docker-attach-client.mjs';
import {DockerSessionProvider} from '../service/docker-session-provider.mjs';
import {RuntimeDeploymentBindingStore} from '../service/runtime-deployment-binding.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../service/runtime-retirement-store.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {planDockerRuntime,verifyDockerRuntime} from '../service/docker-runtime-spec.mjs';
import {createDockerClusterWorker} from '../service/cluster-docker-worker.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {removeOwnedFixture} from './fixtures/docker-external-removal.mjs';

assert.ok(process.env.REMOTE_PAINT_CLUSTER_ENGINE_MANIFEST,'Explicit operator manifest required');
const manifest=JSON.parse(await readFile(resolve(process.env.REMOTE_PAINT_CLUSTER_ENGINE_MANIFEST),'utf8'));
const output=manifest.results;await mkdir(output,{mode:0o700});
const startedAt=new Date().toISOString(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function save(name,value){const file=await open(join(output,name),'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}}
const events=[],containers=new Set(),metadata=new DockerMetadataClient({socketPath:manifest.socketPath,daemonId:manifest.daemonId});
const effects=new DockerEffectClient({socketPath:manifest.socketPath,daemonId:manifest.daemonId});
const attach=new DockerAttachClient({socketPath:manifest.socketPath,daemonId:manifest.daemonId,maxConcurrent:2});
const journal=join(output,'journal.sqlite'),store=new SqliteSessionStore({path:journal});
const namespaceDirectory=join(output,'namespace'),witnessStore=new RuntimeWitnessStore({directory:namespaceDirectory});
const retirementDirectory=join(output,'retirement'),retirementStore=new RuntimeRetirementStore({directory:retirementDirectory,witnessStore});
const region='engine-local',nodeId='engine-node',incarnation='boot-'+randomUUID(),tenantId='engine-test';
let configuration,provider,worker,heartbeat,heartbeatError,heldWitness,result,error,stage='preflight',shutdown;
const step=value=>{stage=value;console.log(JSON.stringify({at:new Date().toISOString(),stage}));};
async function until(check,timeoutMs=20000){const end=performance.now()+timeoutMs;for(;;){const value=await check();if(value)return value;assert.ok(performance.now()<end,'Engine observation deadline: '+stage);await delay(20);}}
// Test observer copies a settled task-owned journal. It does not take the live
// Registry owner, alter a journal or add an application bypass around ownership.
async function sessionSnapshot(name){await copyFile(journal,join(output,name+'.sqlite'));const db=new DatabaseSync(join(output,name+'.sqlite'),{readOnly:true});try{return db.prepare('SELECT body FROM sessions ORDER BY session_id').all().map(row=>JSON.parse(row.body));}finally{db.close();}}
const identity=sessionId=>({tenantId,sessionId,region,version:result.version});
const placement=sessionId=>({tenantId,sessionId,nodeId,generation:1,epoch:1});
const call=(method,sessionId,extra={})=>worker.handle(method,{placement:placement(sessionId),request:identity(sessionId),...extra});
const agent=(sessionId,command)=>call('agent',sessionId,{command,timeoutMs:10000});
async function screenshot(sessionId,name){
 const run=await agent(sessionId,{op:'begin'}),runId=run.binding.runId;
 try{
  const context=await agent(sessionId,{op:'observation-context',runId});
  const shot=await agent(sessionId,{op:'observe-screenshot',runId,context,limits:{maxBytes:1048576}}),chunks=[];
  for(let offset=0;offset<shot.byteLength;){const part=await agent(sessionId,{op:'read-screenshot',runId,context,screenshotId:shot.screenshotId,offset,maxBytes:3072});assert.equal(part.offset,offset);assert.equal(part.sha256,shot.sha256);const bytes=Buffer.from(part.data,'base64');assert.equal(bytes.length,part.byteLength);assert.ok(bytes.length>0);chunks.push(bytes);offset+=bytes.length;assert.equal(part.complete,offset===shot.byteLength);}
  const png=Buffer.concat(chunks);assert.equal(png.length,shot.byteLength);assert.equal(sha(png),shot.sha256);assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  await writeFile(join(output,name+'.png'),png,{flag:'wx',mode:0o600});assert.equal((await agent(sessionId,{op:'release-screenshot',runId,context,screenshotId:shot.screenshotId})).stage,'screenshot-released');
  return {bytes:png.length,sha256:shot.sha256,chunks:chunks.length,checksumVerified:true,released:true};
 }finally{assert.equal((await agent(sessionId,{op:'end',runId})).stage,'run-closed');}
}
try{
 const image=await metadata.inspectImage(manifest.imageId);assert.equal(image.document.Architecture,'arm64');
 const assets=await prepareViewerAssets();result={startedAt,version:'chromium:'+manifest.browserVersion+';wasm:'+assets.wasmSha256};
 configuration={region,deploymentId:'engine-test-'+randomUUID(),daemonId:manifest.daemonId,imageId:manifest.imageId,projectPath:manifest.projectPath,browserPath:manifest.browserPath,projectManifestSha256:manifest.projectManifestSha256,browserManifestSha256:manifest.browserManifestSha256,imageEnvironment:image.document.Config.Env??[]};
 await save('configuration.json',configuration);
 await RuntimeDeploymentBindingStore.bootstrap({directory:join(output,'binding'),store,metadata,configuration});
 provider=new DockerSessionProvider({store,deploymentBinding:new RuntimeDeploymentBindingStore({directory:join(output,'binding')}),configuration,metadata,effects,attach,witnessStore,retirementStore,projectManifest:manifest.projectManifest,browserManifest:manifest.browserManifest,maxSessions:2,onEvent:event=>{
  const row={...event,at:new Date().toISOString()};events.push(row);if(event.containerId)containers.add(event.containerId);
  if(['created','engine-started','witness-persisted','ready','unavailable','cleanup-unconfirmed','retired'].includes(event.type))console.log(JSON.stringify({at:row.at,event:event.type,sessionId:event.sessionId,containerId:event.containerId,failure:event.failure}));
 }});
 assert.equal((await provider.initialize()).available,true);
 worker=createDockerClusterWorker({provider,store,nodeId,incarnation,region,version:result.version,leaseMs:60000,maxSessions:2});await worker.initialize();
 const renew=async()=>{const {challenge}=await worker.handle('lease-begin',{});await worker.handle('lease-accept',{challenge,lease:{nodeId,incarnation,generation:1},leaseMs:60000});};
 await renew();heartbeat=setInterval(()=>{void renew().catch(e=>{heartbeatError=e;});},5000);
 const a='ses_'+randomUUID(),b='ses_'+randomUUID();result.sessions=[a,b];
 for(const sessionId of [a,b]){
  step('create-'+(sessionId===a?'a':'b'));
  const ready=await worker.handle('create',{placement:placement(sessionId),request:{...identity(sessionId),url:'about:blank',ttlSeconds:180}});assert.equal(ready.version,result.version);
  const created=events.find(e=>e.type==='created'&&e.sessionId===sessionId),inspection=await metadata.inspectContainer(created.containerId);
  const plan=planDockerRuntime({sessionId,tenantId,region,ownerKeyHash:inspection.document.Config.Labels['org.remote-paint.runtime.owner-hash']},configuration);
  verifyDockerRuntime(plan,inspection,{containerId:created.containerId});assert.equal(inspection.document.HostConfig.ReadonlyRootfs,true);assert.equal(inspection.document.HostConfig.Privileged,false);assert.deepEqual(inspection.document.HostConfig.PortBindings,{});assert.equal(inspection.document.Mounts.length,2);assert.ok(inspection.document.Mounts.every(m=>m.RW===false&&['/project','/browser'].includes(m.Destination)));
  const witness=witnessStore.read({plan,inspection});await save('runtime-'+(sessionId===a?'a':'b')+'.json',{containerId:created.containerId,profile:verifyDockerRuntime(plan,inspection,{containerId:created.containerId}),witness});
  const source=await call('resolve',sessionId);assert.equal(source.sessionId,sessionId);assert.equal(source.version,result.version);assert.match(source.key,/^[a-f0-9]{64}$/);
  // Keep the source capability private. Only sanitized presence is recorded.
 }
 step('agent-through-original-attach');result.beforeFaultScreenshot=await screenshot(a,'before-fault');
 await assert.rejects(call('resolve',a,{request:{...identity(a),tenantId:'other-test-tenant'}}));
 const bEvent=events.find(e=>e.type==='created'&&e.sessionId===b),bCid=bEvent.containerId;
 const inspection=await metadata.inspectContainer(bCid),plan=planDockerRuntime({sessionId:b,tenantId,region,ownerKeyHash:inspection.document.Config.Labels['org.remote-paint.runtime.owner-hash']},configuration);
 const witnessPath=join(namespaceDirectory,b+'-'+bCid+'.namespace.json');heldWitness={original:witnessPath,held:witnessPath+'.held'};
 await rename(heldWitness.original,heldWitness.held);
 step('remove-exact-owned-runtime-b-with-evidence-temporarily-held');
 result.fault=await removeOwnedFixture({plan,inspection,containerId:bCid,socketPath:manifest.socketPath});
 await until(()=>events.some(e=>e.type==='cleanup-unconfirmed'&&e.sessionId===b));
 assert.equal((await metadata.inspectContainer(bCid)).found,false);
 const unconfirmed=await worker.handle('close',{placement:placement(b),reason:'worker-unavailable',retry:false});assert.equal(unconfirmed.status,'unconfirmed');
 const during=await sessionSnapshot('during-unconfirmed');assert.equal(during.find(r=>r.sessionId===b).state,'cleanup-failed');assert.equal(during.find(r=>r.sessionId===b).reserved,true);assert.equal(during.filter(r=>r.reserved).length,2);await save('quota-held.json',during);
 await assert.rejects(call('resolve',b));await assert.rejects(agent(b,{op:'begin'}));
 step('surviving-runtime-a-still-operates');result.afterFaultScreenshot=await screenshot(a,'after-fault');
 await rename(heldWitness.held,heldWitness.original);heldWitness=null;
 step('explicit-retirement-retry-b');const retiredB=await worker.handle('close',{placement:placement(b),reason:'worker-unavailable',retry:true});assert.equal(retiredB.status,'closed');assert.match(retiredB.evidence.sha256,/^[a-f0-9]{64}$/);
 step('normal-close-a');const retiredA=await worker.handle('close',{placement:placement(a),reason:'released',retry:false});assert.equal(retiredA.status,'closed');
 assert.equal(events.filter(e=>e.type==='intent').length,2);assert.equal(events.filter(e=>e.type==='ready').length,2);assert.ok(!heartbeatError);
 clearInterval(heartbeat);heartbeat=null;shutdown=await worker.close();assert.equal(shutdown.status,'closed');
 const sessions=store.load();assert.equal(sessions.sessions.length,2);assert.ok(sessions.sessions.every(r=>r.state==='closed'&&!r.reserved));await save('session-ledger.json',sessions);
 const runtimeOwner=Symbol('independent-retirement-reader');store.claimRuntimeProvider(runtimeOwner,{region,deploymentId:configuration.deploymentId,daemonId:manifest.daemonId,createdAt:new Date().toISOString()});const runtime=store.loadRuntime({owner:runtimeOwner});store.releaseRuntimeProvider(runtimeOwner);assert.equal(runtime.allocations.length,2);
 const retirementProofs=[];for(const row of runtime.allocations){assert.equal(row.state,'retired');assert.equal((await metadata.inspectContainer(row.containerId)).found,false);const ownPlan=planDockerRuntime({sessionId:row.sessionId,tenantId:row.tenant,region,ownerKeyHash:row.ownerKeyHash},configuration);const reopened=new RuntimeRetirementStore({directory:retirementDirectory}).read({plan:ownPlan,containerId:row.containerId,expectedSha256:row.retirement.evidenceSha256});assert.equal(reopened.receipt.kind,row.sessionId===b?'container-absent':'container-removed');if(row.sessionId===b){assert.equal(reopened.record.proof.absenceProbe.httpStatus,404);assert.equal(reopened.record.proof.absenceProbe.effectAttempted,false);}retirementProofs.push(reopened);}
 const namespaces=retirementProofs.map(proof=>proof.record.proof.namespace.record.witness.self.pidNamespace);
 assert.ok(namespaces.every(value=>/^pid:\[[0-9]+\]$/.test(value)));assert.notEqual(namespaces[0],namespaces[1]);
 await save('retirement-reopened.json',{runtime,retirementProofs});store.close();
 const reopenedStore=new SqliteSessionStore({path:journal});try{assert.equal(reopenedStore.load().sessions.filter(r=>r.reserved).length,0);}finally{reopenedStore.close();}
 Object.assign(result,{status:'passed',realDockerEngine:true,originalDockerSessionProvider:true,originalSessionRegistryAndSqlite:true,clusterWorkerFactory:true,actualChromiumAndBroker:true,actualNativeAgentScreenshots:true,privateSourceResolved:true,crossTenantDenied:true,distinctRuntimeNamespaces:true,unconfirmedRetirementHeldQuota:true,survivingSessionOperatesDuringFault:true,explicitRetryReopenedImmutableEvidence:true,normalAndHistoricalAbsenceRetirement:true,oldSessionNotReplayed:true,quotaHeldFinal:0,hostListeners:0,dockerSocketMounted:false,dockerBuilds:0,chromiumCompiles:0,crossMachineQualified:false,productionHaQualified:false,mtlsTransportRepeated:false});
}catch(e){error={name:e.name,code:e.code??null,message:e.message,stack:e.stack};console.log(JSON.stringify({at:new Date().toISOString(),stage,status:'failed',error}));}
finally{
 clearInterval(heartbeat);if(heldWitness){try{await rename(heldWitness.held,heldWitness.original);}catch{}}
 if(!shutdown)shutdown=await worker?.close();if(!worker)await provider?.shutdown();
 const cleanup=[];for(const containerId of containers){try{cleanup.push({containerId,absent:!(await metadata.inspectContainer(containerId)).found});}catch(e){cleanup.push({containerId,error:e.code??e.message});}}
 await save('events.json',events);await save('cleanup.json',{at:new Date().toISOString(),shutdown,containers:cleanup,attach:attach.status(),effects:effects.status()});
 await attach.close();await effects.close();await metadata.close();try{store.close();}catch{}
 if(cleanup.some(r=>r.absent!==true)||worker&&shutdown?.status!=='closed')error??={code:'TASK_CLEANUP_UNCONFIRMED'};
}
await save('result.json',{...result,status:error?'failed':'passed',completedAt:new Date().toISOString(),stage,imageId:manifest.imageId,deliveryImageId:manifest.deliveryImageId,hostNode:process.version,error,containerIds:[...containers]});
console.log(JSON.stringify({status:error?'failed':'passed',stage,containerIds:[...containers],error}));if(error)process.exitCode=1;
