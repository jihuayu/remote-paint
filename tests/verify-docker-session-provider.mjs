import {rename,copyFile} from 'node:fs/promises';
import {removeOwnedFixture} from './fixtures/docker-external-removal.mjs';
// Opt-in real Engine fixture for the actual provider and durable Registry.
// Node main/leaf processes only; this does not qualify Native or Viewer roles.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../service/docker-attach-client.mjs';
import {DockerSessionProvider} from '../service/docker-session-provider.mjs';
import {RuntimeDeploymentBindingStore} from '../service/runtime-deployment-binding.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../service/runtime-retirement-store.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {planDockerRuntime} from '../service/docker-runtime-spec.mjs';
const socketPath=process.env.REMOTE_PAINT_DOCKER_SOCKET,daemonId=process.env.REMOTE_PAINT_DOCKER_DAEMON,imageId=process.env.REMOTE_PAINT_DOCKER_IMAGE;
assert.ok(socketPath&&daemonId&&imageId&&process.env.REMOTE_PAINT_DOCKER_EFFECT_OUTPUT);
const mode=process.env.REMOTE_PAINT_DOCKER_PROVIDER_MODE??'normal';assert.ok(['normal','cancel-intent','cancel-created','cancel-witness','proxy-lost','ttl','source-changed','closing-capacity','runtime-removed','cancel-engine-started','cancel-file-published','retry-proof','retry-limit'].includes(mode));
const output=resolve(process.env.REMOTE_PAINT_DOCKER_EFFECT_OUTPUT);await mkdir(output,{mode:0o700});
const sha=v=>createHash('sha256').update(v).digest('hex'),region='provider-fixture',deploymentId='provider-'+randomUUID(),tenantId='provider-fixture',nonce=randomBytes(32).toString('hex');
async function save(name,value){const f=await open(join(output,name),'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}const dir=await open(output,'r');try{await dir.sync();}finally{await dir.close();}return sha(await readFile(join(output,name)));}
async function waitFor(check,ms=15000){const end=performance.now()+ms;while(!check()){assert.ok(performance.now()<end,'Actual provider observation deadline exceeded');await new Promise(r=>setTimeout(r,20));}}
const events=[],witnesses=new Map(),sockets=new Set(),observerErrors=[],eventErrors=[];let registry,provider,operation,configuration,containerId=null,witnessConfirmed=false,ready=null,immediateLossFence=null,secondOperation=null,externalRemoval=null,retryEvidence=null,terminal=null,retirement=null,error=null,shutdown=null,providerShutdown=null;
const server=createServer((req,res)=>{
 if(req.method!=='POST'||req.url!=='/witness'||req.headers.authorization!=='Bearer '+nonce||sockets.size>2){res.writeHead(403);res.end();return;}
 let pending='',role=null,count=0;req.setEncoding('utf8');res.writeHead(200,{'content-type':'text/plain'});res.flushHeaders();
 req.on('data',chunk=>{pending+=chunk;if(Buffer.byteLength(pending)>16384){observerErrors.push('line-limit');req.destroy();return;}let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const data=JSON.parse(line);if(data.event==='witness'){assert.ok(['main','leaf'].includes(data.role)&&!witnesses.has(data.role));role=data.role;if(role==='leaf')assert.equal(witnessConfirmed,true,'Persisted witness must precede private resource allocation');witnesses.set(role,{identity:data,heartbeats:0,closed:false});}else{assert.ok(role&&data.event==='heartbeat'&&data.pid===witnesses.get(role).identity.self.pid);witnesses.get(role).heartbeats++;}assert.ok(++count<=1000);}catch{observerErrors.push('invalid-witness');req.destroy();}}});
 req.on('error',()=>{});req.socket.once('close',()=>{if(role)witnesses.get(role).closed=true;});
});
server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const metadata=new DockerMetadataClient({socketPath,daemonId}),effects=new DockerEffectClient({socketPath,daemonId}),attach=new DockerAttachClient({socketPath,daemonId,maxConcurrent:2}),witnessStore=new RuntimeWitnessStore({directory:join(output,'namespace-evidence')}),retirementStore=new RuntimeRetirementStore({directory:join(output,'retirement-evidence'),witnessStore}),store=new SqliteSessionStore({path:join(output,'journal.sqlite')});
try{
 const image=await metadata.inspectImage(imageId);await mkdir(join(output,'project'),{mode:0o700});await mkdir(join(output,'browser'),{mode:0o700});
 const files={};for(const [name,url]of [['worker.mjs',new URL('./fixtures/docker-attach-worker.mjs',import.meta.url)],['session-worker.mjs',new URL('../service/session-worker.mjs',import.meta.url)],['linux-runtime-witness.mjs',new URL('../service/linux-runtime-witness.mjs',import.meta.url)]]){const bytes=await readFile(url);await writeFile(join(output,'project',name),bytes,{mode:0o600,flag:'wx'});files[name]=sha(bytes);}
 const config=JSON.stringify({port:server.address().port,nonce});await writeFile(join(output,'project/config.json'),config,{mode:0o600,flag:'wx'});files['config.json']=sha(config);
 const projectManifestSha256=await save('project-manifest.json',{schema:'runtime-source-files-v1',files}),browserManifestSha256=await save('browser-manifest.json',{schema:'runtime-source-files-v1',files:{}});
 configuration={region,deploymentId,daemonId,imageId,projectPath:join(output,'project'),browserPath:join(output,'browser'),projectManifestSha256,browserManifestSha256,workerEntry:'worker.mjs',imageEnvironment:image.document.Config.Env??[]};
 const directory=join(output,'deployment-binding');await RuntimeDeploymentBindingStore.bootstrap({directory,store,metadata,configuration});
 provider=new DockerSessionProvider({store,deploymentBinding:new RuntimeDeploymentBindingStore({directory}),configuration,metadata,effects,attach,witnessStore,retirementStore,projectManifest:join(output,'project-manifest.json'),browserManifest:join(output,'browser-manifest.json'),maxSessions:mode==='closing-capacity'?1:2,maxCloseAttempts:mode==='retry-limit'?2:4,onEvent:event=>{
  events.push({...event,at:new Date().toISOString()});if(event.containerId)containerId=event.containerId;if(event.type==='witness-persisted')witnessConfirmed=true;
  if(mode==='closing-capacity'&&event.type==='closing'&&event.sessionId===operation?.sessionId&&!secondOperation){try{secondOperation=registry.create(tenantId,{},{idempotencyKey:'capacity-while-closing'});}catch(e){eventErrors.push({code:e.code??null,message:e.message});}}
  const cancel={ 'cancel-intent':'intent','cancel-created':'created','cancel-witness':'witness-persisted','cancel-engine-started':'engine-started','cancel-file-published':'witness-file-published'}[mode];
  if(event.type===cancel){try{registry.release(tenantId,event.sessionId);assert.notEqual(registry.getSession(tenantId,event.sessionId).state,'ready');}catch(e){eventErrors.push({name:e.name,code:e.code??null,message:e.message});}}
 }});
 assert.equal((await provider.initialize()).available,true);registry=new SessionRegistry({providers:new Map([[region,provider]]),defaultRegion:region,store,globalQuota:2,tenantQuota:2,maxCloseAttempts:mode==='retry-limit'?2:4});
 provider.subscribeUnavailable(event=>{if(['proxy-lost','runtime-removed'].includes(mode)){try{immediateLossFence=registry.getSession(tenantId,event.sessionId);assert.equal(immediateLossFence.state,'closing');assert.throws(()=>registry.requireReady(tenantId,event.sessionId),{code:'SESSION_NOT_READY'});}catch(e){eventErrors.push({name:e.name,code:e.code??null,message:e.message});}}});
 if(mode==='source-changed')await writeFile(join(output,'project/worker.mjs'),'throw new Error("fixture-source-changed");');
 operation=registry.create(tenantId,{url:'https://fixture.invalid/#private-provider-start',ttlSeconds:mode==='ttl'?2:60},{idempotencyKey:'provider-lifecycle-1'});
 if(!mode.startsWith('cancel-')&&mode!=='source-changed'){
  await waitFor(()=>registry.getOperation(tenantId,operation.operationId).status!=='pending');ready=registry.requireReady(tenantId,operation.sessionId);assert.equal(ready.version,'node-private-attach-fixture-v1');assert.equal(provider.sessionStatus({sessionId:operation.sessionId,tenantId}).available,true);assert.equal((await provider.initialize()).activeRuntimes,1);
  await waitFor(()=>witnesses.size===2&&[...witnesses.values()].every(x=>x.heartbeats>=3));
  const main=witnesses.get('main').identity,leaf=witnesses.get('leaf').identity;
  for(const x of [main,leaf]){assert.ok(x.self.pid>1);assert.equal(x.init.pid,1);assert.equal(x.init.ppid,0);assert.equal(x.namespace,x.initNamespace);assert.match(x.namespace,/^pid:\[[0-9]+\]$/);assert.equal(x.capEff,'0000000000000000');assert.equal(x.capBnd,'0000000000000000');assert.equal(x.noNewPrivs,'1');assert.equal(x.seccomp,'2');}
  assert.equal(main.self.ppid,1);assert.equal(leaf.self.ppid,main.self.pid);assert.equal(leaf.self.pgrp,leaf.self.pid);assert.notEqual(main.self.pgrp,leaf.self.pgrp);assert.equal(main.namespace,leaf.namespace);assert.equal(effects.status().activeSessions,0);assert.equal(attach.status().activeProxies,1);
  await save('ready.json',{ready,provider:provider.sessionStatus({sessionId:operation.sessionId,tenantId}),witnesses:Object.fromEntries(witnesses)});
  if(mode==='proxy-lost'){
   const proxyPid=events.find(x=>x.type==='attached').proxyPid;assert.ok(Number.isSafeInteger(proxyPid)&&proxyPid>1);process.kill(proxyPid,'SIGKILL');
   // Listener registration precedes this fixture listener, so this snapshot is
   // taken in the same event dispatch, before the async cleanup can complete.
   // The observer was installed before Registry creation was requested.
  }else if(mode==='runtime-removed'){const inspection=await metadata.inspectContainer(containerId),plan=planDockerRuntime({sessionId:operation.sessionId,tenantId,region,ownerKeyHash:inspection.document.Config.Labels['org.remote-paint.runtime.owner-hash']},configuration);externalRemoval=await removeOwnedFixture({plan,inspection,containerId,socketPath});}else if(['retry-proof','retry-limit'].includes(mode)){
   const file=join(output,'namespace-evidence',operation.sessionId+'-'+containerId+'.namespace.json'),held=file+'.held',originalHash=sha(await readFile(file)),context={sessionId:operation.sessionId,tenantId,region,reason:'released'};await rename(file,held);
   const first=registry.release(tenantId,operation.sessionId);await waitFor(()=>registry.getOperation(tenantId,first.operationId).status!=='pending');const firstState=registry.getSession(tenantId,operation.sessionId);assert.equal(firstState.state,'cleanup-failed');assert.equal(firstState.holdsQuota,true);assert.equal((await metadata.inspectContainer(containerId)).found,false);await copyFile(join(output,'journal.sqlite'),join(output,'first-failed-attempt.sqlite'));
   const memo=provider.close(context),closingEvents=events.filter(x=>x.type==='closing').length;assert.equal((await memo).status,'unconfirmed');assert.equal(provider.close(context),memo);assert.equal(events.filter(x=>x.type==='closing').length,closingEvents);
   let second,shared=false,limit=null;
   if(mode==='retry-proof'){
    await rename(held,file);assert.equal(sha(await readFile(file)),originalHash);const retry=provider.retryClose(context);assert.equal(provider.retryClose(context),retry);shared=true;second=registry.release(tenantId,operation.sessionId);assert.equal((await retry).status,'closed');await waitFor(()=>registry.getOperation(tenantId,second.operationId).status!=='pending');assert.equal(registry.getOperation(tenantId,second.operationId).status,'succeeded');assert.equal(provider.close(context),retry);assert.equal(provider.retryClose(context),retry);
   }else{
    second=registry.release(tenantId,operation.sessionId);await waitFor(()=>registry.getOperation(tenantId,second.operationId).status!=='pending');assert.equal(registry.getOperation(tenantId,second.operationId).status,'failed');await copyFile(join(output,'journal.sqlite'),join(output,'second-failed-attempt.sqlite'));await rename(held,file);assert.equal(sha(await readFile(file)),originalHash);limit=await provider.retryClose(context);assert.equal(limit.code,'PROVIDER_CLEANUP_LIMIT');assert.throws(()=>registry.release(tenantId,operation.sessionId),{code:'SESSION_CLEANUP_LIMIT'});
   }
   assert.notEqual(first.operationId,second.operationId);assert.equal(registry.getOperation(tenantId,first.operationId).status,'failed');const status=provider.sessionStatus({sessionId:operation.sessionId,tenantId});assert.equal(status.cleanupAttempts,2);assert.equal(events.filter(x=>x.type==='closing').length,2);assert.equal(events.filter(x=>x.type==='intent').length,1);assert.equal(events.filter(x=>x.type==='engine-started').length,1);assert.equal(events.filter(x=>x.type==='ready').length,1);retryEvidence={first,second,firstState,originalHash,sharedInflightRetry:shared,limit,status,oldFailure:registry.getOperation(tenantId,first.operationId),newOutcome:registry.getOperation(tenantId,second.operationId)};await save('retry-evidence.json',retryEvidence);
  }else if(['normal','closing-capacity'].includes(mode))registry.release(tenantId,operation.sessionId);
 }
 // No polling is used to trigger TTL or transport-loss cleanup. Polling only
 // observes persisted state after provider events/the real Registry timer act.
 if(mode!=='retry-limit')await waitFor(()=>registry.stats().reservedSessions===0);
 terminal=registry.getSession(tenantId,operation.sessionId);assert.ok((mode==='retry-limit'?['cleanup-failed']:mode==='source-changed'?['failed']:['closed','expired']).includes(terminal.state),JSON.stringify({terminal,events,eventErrors}));assert.equal(terminal.holdsQuota,mode==='retry-limit');assert.equal(registry.stats().reservedSessions,mode==='retry-limit'?1:0);assert.equal(provider.sessionStatus({sessionId:operation.sessionId,tenantId}).retirementConfirmed,mode!=='retry-limit');
 if(mode==='ttl')assert.equal(terminal.closeReason,'ttl-expired');if(['proxy-lost','runtime-removed'].includes(mode)){assert.equal(terminal.closeReason,'worker-unavailable');assert.equal(immediateLossFence?.state,'closing');}
 if(mode.startsWith('cancel-')){assert.equal(registry.getOperation(tenantId,operation.operationId).error.code,'SESSION_CREATE_CANCELLED');assert.equal(witnesses.has('leaf'),false);assert.equal(events.some(x=>x.type==='ready'),false);}
 if(mode==='source-changed'){assert.equal(containerId,null);assert.equal(events.some(x=>x.type==='created'),false);assert.equal(registry.getOperation(tenantId,operation.operationId).error.code,'SESSION_START_FAILED');}
 if(mode==='closing-capacity'){assert.ok(secondOperation);assert.equal(registry.getOperation(tenantId,secondOperation.operationId).status,'failed');assert.equal(events.filter(x=>x.type==='intent').length,1);assert.equal(registry.getSession(tenantId,secondOperation.sessionId).holdsQuota,false);}
 if(mode==='cancel-intent'){assert.equal(containerId,null);assert.equal(events.some(x=>x.type==='created'),false);}
 if(mode==='cancel-created')assert.equal(events.some(x=>x.type==='engine-started'),false);
 if(mode==='cancel-engine-started'){assert.ok(events.some(x=>x.type==='closing-witness-collected'));const channel=provider.sessionStatus({sessionId:operation.sessionId,tenantId}).channel;assert.equal(channel.closeOnly,true);assert.equal(channel.startSent,false);}
 if(mode==='cancel-file-published')assert.ok(events.some(x=>x.type==='closing-witness-adopted'));
 if(containerId){assert.equal((await metadata.inspectContainer(containerId)).found,false);await waitFor(()=>[...witnesses.values()].every(x=>x.closed));}
 assert.deepEqual(eventErrors,[]);assert.deepEqual(observerErrors,[]);
 await save('terminal.json',{terminal,events,witnesses:Object.fromEntries(witnesses),provider:provider.sessionStatus({sessionId:operation.sessionId,tenantId})});
 shutdown=await registry.shutdown();assert.equal(shutdown.status,mode==='retry-limit'?'cleanup-incomplete':'closed');const snapshot=store.load(),row=snapshot.sessions.find(x=>x.sessionId===operation.sessionId);assert.equal(row.reserved,mode==='retry-limit');assert.equal(row.state,mode==='retry-limit'?'cleanup-failed':mode==='ttl'?'expired':mode==='source-changed'?'failed':'closed');await save('session-ledger.json',snapshot);providerShutdown=await provider.shutdown();assert.equal(providerShutdown.status,mode==='retry-limit'?'unconfirmed':'closed');const attemptsBefore=provider.sessionStatus({sessionId:operation.sessionId,tenantId}).cleanupAttempts;await provider.retryClose({sessionId:operation.sessionId,tenantId,region,reason:'released'});assert.equal(provider.sessionStatus({sessionId:operation.sessionId,tenantId}).cleanupAttempts,attemptsBefore);await assert.rejects(provider.initialize(),{code:'PROVIDER_CLOSED'});assert.equal(provider.status().available,false);
 const owner=Symbol('independent-runtime-inspector');store.claimRuntimeProvider(owner,{region,deploymentId,daemonId,createdAt:new Date().toISOString()});const runtime=store.loadRuntime({owner});store.releaseRuntimeProvider(owner);assert.equal(runtime.allocations.length,1);const allocation=runtime.allocations[0];assert.equal(allocation.state,mode==='retry-limit'?'closing':'retired');
 if(mode==='retry-limit'){assert.equal(allocation.retirement,null);const plan=planDockerRuntime({sessionId:operation.sessionId,tenantId,region,ownerKeyHash:allocation.ownerKeyHash},configuration);assert.throws(()=>retirementStore.read({plan,containerId}),{code:'RETIREMENT_MISSING'});await save('retirement-reopened.json',{runtime,retirement:null});}else{
 const plan=planDockerRuntime({sessionId:operation.sessionId,tenantId,region,ownerKeyHash:allocation.ownerKeyHash},configuration);retirement=new RuntimeRetirementStore({directory:join(output,'retirement-evidence')}).read({plan,containerId,expectedSha256:allocation.retirement.evidenceSha256});assert.equal(retirement.receipt.evidenceSha256,sha(await readFile(join(output,'retirement-evidence',operation.sessionId+'-'+(containerId??'not-dispatched')+'.retirement.json'))));if(mode==='runtime-removed'){assert.equal(retirement.receipt.kind,'container-absent');assert.equal(retirement.record.proof.absenceProbe.httpStatus,404);assert.equal(retirement.record.proof.absenceProbe.effectAttempted,false);}await save('retirement-reopened.json',{runtime,retirement});
 }
}catch(e){error={name:e.name,code:e.code??null,message:e.message};}
finally{
 try{shutdown??=await registry?.shutdown();}catch(e){error??={code:e.code??null,message:e.message};}try{providerShutdown??=await provider?.shutdown();}catch(e){error??={code:e.code??null,message:e.message};}
 await attach.close();await effects.close();await metadata.close();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));try{store.close();}catch(e){error??={code:e.code??null,message:e.message};}
}
const report={at:new Date().toISOString(),status:error?'failed':'passed',scope:'Actual DockerSessionProvider plus actual durable SessionRegistry;real Node Worker/private channel/namespace evidence and immutable retirement. Includes historical known-CID absence when runtime-removed is selected;does not qualify Native,Viewer roles,HTTP/SDK,the full recovery fault matrix or all41/8h.',mode,daemonId,imageId,containerId,operation,secondOperation,externalRemoval,retryEvidence,ready,terminal,immediateLossFence,retirement,events,witnesses:Object.fromEntries(witnesses),observerErrors,eventErrors,shutdown,providerShutdown,error};await save('report.json',report);console.log(JSON.stringify({status:report.status,mode,containerId,error,shutdown,providerShutdown}));assert.equal(report.status,'passed');
