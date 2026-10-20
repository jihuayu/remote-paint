import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {SessionRegistry,SessionApiError} from '../service/session-registry.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {records} from './fixtures/session-store-records.mjs';
const enabled={skip:!sessionStoreSupported},flush=()=>new Promise(setImmediate),input={url:'https://example.test/'};
const code=value=>error=>error.code===value;
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function harness(t,{provider={},registryOptions={},storeOptions={}}={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-registry-durable-')),store=new SqliteSessionStore({path:join(directory,'state.sqlite'),...storeOptions});
 const h={directory,store,owner:undefined,current:null,creates:[],closes:[],resources:new Set(),hook:null};
 h.provider={create:async args=>{h.creates.push(args);h.resources.add(args.sessionId);return {version:'fixture-v1'};},close:async args=>{h.closes.push(args);h.resources.delete(args.sessionId);return {status:'closed'};},...provider};
 h.adapter={claimRegistry:owner=>{store.claimRegistry(owner);h.owner=owner;},releaseRegistry:owner=>{store.releaseRegistry(owner);h.owner=undefined;},load:options=>store.load(options),commit:(batch,options)=>h.hook?h.hook(batch,()=>store.commit(batch,options)):store.commit(batch,options)};
 h.open=(options={})=>{const registry=new SessionRegistry({providers:new Map([['test',h.provider]]),defaultRegion:'test',store:h.adapter,...registryOptions,...options});h.current=registry;return registry;};
 h.peek=()=>store.load({owner:h.owner});
 t.after(async()=>{try{await h.current?.shutdown();}finally{store.close();await rm(directory,{recursive:true,force:true});}});return h;
}
function seed(){const batch=records();batch.bindings[0].keyHash=createHash('sha256').update('key').digest('hex');batch.bindings[0].fingerprint=fingerprint({url:input.url,region:'test',ttlSeconds:900});return batch;}

test('accepted intent is committed before create and cleanup intent precedes provider close',enabled,async t=>{
 const h=await harness(t);let observedCreate=false,observedClose=false;
 h.provider.create=async args=>{h.creates.push(args);const data=h.peek();assert.equal(data.sessions[0].sessionId,args.sessionId);assert.equal(data.sessions[0].state,'creating');assert.equal(data.operations[0].operation.status,'pending');assert.equal(data.bindings.length,1);observedCreate=true;return {version:'v1'};};
 h.provider.close=async args=>{h.closes.push(args);const data=h.peek();assert.equal(data.sessions[0].state,'closing');assert.equal(data.sessions[0].closeAttempts,1);assert.equal(data.operations.find(x=>x.operation.kind==='release-session').operation.status,'pending');observedClose=true;return {status:'closed'};};
 const registry=h.open(),created=registry.create('a',input,{idempotencyKey:'key'});assert.equal(observedCreate,true);await flush();assert.equal(registry.requireReady('a',created.sessionId).state,'ready');assert.equal(h.peek().operations[0].operation.status,'succeeded');const released=registry.release('a',created.sessionId);await flush();assert.equal(observedClose,true);assert.equal(registry.getOperation('a',released.operationId).status,'succeeded');assert.equal(h.peek().sessions[0].state,'closed');
});

test('one ledger cannot be shared by two live Registries or closed behind its owner',enabled,async t=>{
 const h=await harness(t),registry=h.open();assert.throws(()=>h.open(),code('REGISTRY_STORAGE_UNAVAILABLE'));assert.throws(()=>h.store.close(),code('STATE_IN_USE'));const owner=h.owner;await registry.shutdown();assert.throws(()=>h.store.commit({}, {owner}),code('STATE_IN_USE'));assert.throws(()=>registry.getSession('a','missing'),code('REGISTRY_CLOSED'));assert.doesNotThrow(()=>h.open());
});

test('recovered creates are quarantined, keep the original key and never call create again',enabled,async t=>{
 const h=await harness(t);h.store.commit(seed());h.resources.add('ses_a');const registry=h.open();assert.equal(h.creates.length,0);assert.equal(registry.getSession('tenant-a','ses_a').state,'recovery-required');assert.throws(()=>registry.requireReady('tenant-a','ses_a'),code('SESSION_NOT_READY'));
 assert.equal(registry.create('tenant-a',input,{idempotencyKey:'key'}).operationId,'op_a');assert.equal(h.creates.length,0);assert.deepEqual(await registry.recover(),{status:'closed',remainingSessions:[]});assert.equal(h.creates.length,0);assert.equal(h.closes[0].sessionId,'ses_a');assert.equal(registry.getOperation('tenant-a','op_a').error.code,'SESSION_CREATION_UNCONFIRMED');assert.equal(registry.stats().reservedSessions,0);assert.equal(h.resources.size,0);
});

test('known retries retain their original region and TTL defaults after configuration changes',enabled,async t=>{
 const h=await harness(t);h.store.commit(seed());const registry=h.open({providers:new Map([['test',h.provider],['new',h.provider]]),defaultRegion:'new',defaultTtlSeconds:2,maxTtlSeconds:10});assert.equal(registry.create('tenant-a',input,{idempotencyKey:'key'}).operationId,'op_a');assert.equal(h.creates.length,0);
 assert.throws(()=>registry.create('tenant-a',{...input,ttlSeconds:3},{idempotencyKey:'key'}),code('IDEMPOTENCY_CONFLICT'));await registry.recover();
});

test('pre-commit and ambiguous admission failures never start provider allocation',enabled,async t=>{
 for(const afterCommit of [false,true]){
  const sub=await harness(t);let once=true;sub.hook=(batch,commit)=>{if(once&&batch.bindings.length){once=false;if(afterCommit)commit();throw new Error('injected commit acknowledgement failure');}return commit();};
  const registry=sub.open();assert.throws(()=>registry.create('a',input,{idempotencyKey:'key'}),code('REGISTRY_STORAGE_UNAVAILABLE'));assert.equal(sub.creates.length,0);assert.equal(registry.stats().reservedSessions,0);assert.equal(registry.stats().records,0);assert.throws(()=>registry.create('a',input,{idempotencyKey:'key'}),code('REGISTRY_STORAGE_UNAVAILABLE'));assert.equal((await registry.shutdown()).persistence,'unconfirmed');
  sub.hook=null;const next=sub.open();if(afterCommit){const prior=next.create('a',input,{idempotencyKey:'key'});assert.equal(prior.status,'pending');await next.recover();assert.equal(sub.creates.length,0);}else{next.create('a',input,{idempotencyKey:'key'});await flush();assert.equal(sub.creates.length,1);}
 }
});

test('uncertain ready commits block confirmed reads and close the allocated resource without replay',enabled,async t=>{
 for(const afterCommit of [false,true]){
  const h=await harness(t);let once=true,registry;h.hook=(batch,commit)=>{
   if(once&&batch.sessions.some(x=>x.state==='ready')){once=false;assert.throws(()=>registry.requireReady('a',batch.sessions[0].sessionId),code('REGISTRY_WRITE_IN_PROGRESS'));if(afterCommit)commit();throw new Error('ready commit uncertain');}return commit();
  };
  registry=h.open();const created=registry.create('a',input,{idempotencyKey:'key'});await flush();assert.equal(h.creates.length,1);assert.equal(h.resources.size,0);assert.equal(h.closes.length,1);assert.throws(()=>registry.getOperation('a',created.operationId),code('REGISTRY_STORAGE_UNAVAILABLE'));await registry.shutdown();
  h.hook=null;const next=h.open(),retry=next.create('a',input,{idempotencyKey:'key'});assert.equal(retry.operationId,created.operationId);assert.equal(h.creates.length,1);assert.throws(()=>next.requireReady('a',created.sessionId),code('SESSION_NOT_READY'));await next.recover();assert.equal(h.creates.length,1);
 }
});

test('a failed release-intent write still performs cleanup and never publishes an unconfirmed success',enabled,async t=>{
 const h=await harness(t),registry=h.open(),created=registry.create('a',input,{idempotencyKey:'key'});await flush();h.hook=(batch,commit)=>{if(batch.operations.some(x=>x.operation.kind==='release-session'))throw new Error('release storage failed');return commit();};assert.throws(()=>registry.release('a',created.sessionId),code('REGISTRY_STORAGE_UNAVAILABLE'));await flush();assert.equal(h.resources.size,0);assert.equal(h.closes.length,1);assert.throws(()=>registry.getSession('a',created.sessionId),code('REGISTRY_STORAGE_UNAVAILABLE'));await registry.shutdown();
 h.hook=null;const next=h.open();await next.recover();assert.equal(h.creates.length,1);assert.equal(next.getSession('a',created.sessionId).state,'closed');
});

test('an uncertain completion resumes the original pending release operation after restart',enabled,async t=>{
 const h=await harness(t),registry=h.open(),created=registry.create('a',input,{idempotencyKey:'key'});await flush();let once=true;h.hook=(batch,commit)=>{if(once&&batch.operations.some(x=>x.operation.kind==='release-session'&&x.operation.status==='succeeded')){once=false;throw new Error('close completion failed');}return commit();};const release=registry.release('a',created.sessionId);await flush();assert.equal(h.resources.size,0);await registry.shutdown();h.hook=null;
 const next=h.open();assert.equal(next.getOperation('a',release.operationId).status,'pending');await next.recover();assert.equal(next.getOperation('a',release.operationId).status,'succeeded');assert.equal(next.release('a',created.sessionId).operationId,release.operationId);assert.equal(h.creates.length,1);
});

test('unconfirmed recovered ownership occupies quota until a real closed attestation',enabled,async t=>{
 let closed=false;const h=await harness(t,{provider:{close:async()=>closed?{status:'closed'}:undefined},registryOptions:{tenantQuota:1,globalQuota:1}});h.store.commit(seed());const registry=h.open();assert.equal((await registry.recover()).status,'cleanup-incomplete');assert.equal(registry.stats().reservedSessions,1);assert.throws(()=>registry.create('tenant-a',input,{idempotencyKey:'new'}),code('SESSION_QUOTA'));closed=true;assert.equal((await registry.recover()).status,'closed');assert.equal(registry.stats().reservedSessions,0);assert.equal(h.creates.length,0);
});

async function realRestart(t,mode){
 const {fork}=await import('node:child_process'),{once}=await import('node:events'),{fileURLToPath}=await import('node:url'),{mkdir,readFile,unlink,writeFile,appendFile}=await import('node:fs/promises'),{withOwnedTestChild}=await import('./owned-test-child.mjs');
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-real-registry-restart-')),resources=join(directory,'resources'),path=join(directory,'state.sqlite');await mkdir(resources);let child,message,store,registry;
 t.after(async()=>{try{await registry?.shutdown();}finally{store?.close();await rm(directory,{recursive:true,force:true});}});
 await withOwnedTestChild(()=>{child=fork(fileURLToPath(new URL('./fixtures/session-registry-child.mjs',import.meta.url)),[path,resources,mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});return child;},async child=>{[message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,mode);});assert.equal(child.signalCode,'SIGKILL');assert.equal(child.connected,false);
 let newAllocations=0;const provider={create:async args=>{newAllocations++;await appendFile(join(resources,'allocations.log'),args.sessionId+'\n');await writeFile(join(resources,args.sessionId),'new resource');return {version:'fixture-v1'};},close:async args=>{try{await unlink(join(resources,args.sessionId));}catch(error){if(error.code!=='ENOENT')throw error;}return {status:'closed'};}};
 store=new SqliteSessionStore({path});registry=new SessionRegistry({providers:new Map([['test',provider]]),defaultRegion:'test',store});assert.equal(registry.getSession('tenant-a',message.sessionId).state,'recovery-required');assert.throws(()=>registry.requireReady('tenant-a',message.sessionId),code('SESSION_NOT_READY'));const retry=registry.create('tenant-a',input,{idempotencyKey:'key'});assert.equal(retry.sessionId,message.sessionId);assert.equal(newAllocations,0);
 await registry.recover();assert.equal(newAllocations,0);assert.equal((await readFile(join(resources,'allocations.log'),'utf8')).trim().split('\n').length,1);assert.equal(registry.stats().reservedSessions,0);assert.equal(registry.getSession('tenant-a',message.sessionId).state,'closed');
 if(mode==='closing'){assert.equal(registry.getOperation('tenant-a',message.operationId).status,'succeeded');assert.equal(registry.release('tenant-a',message.sessionId).operationId,message.operationId);}
 else if(mode==='creating')assert.equal(registry.getOperation('tenant-a',retry.operationId).error.code,'SESSION_CREATION_UNCONFIRMED');
 else assert.equal(registry.getOperation('tenant-a',retry.operationId).status,'succeeded');
}
test('actual restart after allocation but before ready preserves intent and never allocates twice',enabled,t=>realRestart(t,'creating'));
test('actual restart after ready quarantines the old resource without a fresh lifetime or allocation',enabled,t=>realRestart(t,'ready'));
test('actual restart during release resumes the original release operation and closes its old resource',enabled,t=>realRestart(t,'closing'));

test('expired durable tombstones do not regain a fresh monotonic lifetime after reopening',enabled,async t=>{
 let mono=0;const timers=new Map();let serial=0;const clock={now:()=>mono,wallNow:()=>1700000000000+mono,setTimer:(fn,ms)=>{timers.set(++serial,{fn,at:mono+ms});return serial;},clearTimer:id=>timers.delete(id)};
 const h=await harness(t,{registryOptions:{clock,defaultTtlSeconds:1}}),registry=h.open(),created=registry.create('a',input,{idempotencyKey:'key'});await flush();mono=1001;for(const [id,timer]of [...timers])if(timer.at<=mono){timers.delete(id);timer.fn();}await flush();assert.equal(registry.getSession('a',created.sessionId).state,'expired');await registry.shutdown();
 mono=0;const next=h.open();assert.equal(timers.size,0);assert.equal(next.getSession('a',created.sessionId).state,'expired');assert.throws(()=>next.requireReady('a',created.sessionId),code('SESSION_EXPIRED'));assert.equal(next.create('a',input,{idempotencyKey:'key'}).sessionId,created.sessionId);assert.equal(h.creates.length,1);
});

test('a storage fault during another admission fences an outstanding create and shutdown awaits its late resource',enabled,async t=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;}),h=await harness(t);h.provider.create=args=>{h.creates.push(args);h.resources.add(args.sessionId);return pending;};const registry=h.open();registry.create('a',input,{idempotencyKey:'first'});h.hook=(batch,commit)=>{if(batch.bindings.length)throw new Error('new admission failed');return commit();};assert.throws(()=>registry.create('b',input,{idempotencyKey:'second'}),code('REGISTRY_STORAGE_UNAVAILABLE'));await flush();assert.equal(h.creates.length,1);assert.equal(h.creates[0].signal.aborted,true);assert.equal(h.closes.length,0);
 const stopping=registry.shutdown();let stopped=false;stopping.then(()=>{stopped=true;});await flush();assert.equal(stopped,false);assert.throws(()=>h.store.claimRegistry(Symbol('premature handoff')),code('STATE_IN_USE'));finish({version:'late'});assert.equal((await stopping).status,'closed');assert.equal(h.resources.size,0);assert.equal(h.closes.length,1);
});

test('missing or incorrect commit acknowledgements never authorize allocation',enabled,async t=>{
 for(const afterCommit of [false,true])for(const acknowledgement of [undefined,{revision:999}]){
  const h=await harness(t);h.hook=(batch,commit)=>{if(afterCommit)commit();return acknowledgement;};const registry=h.open();assert.throws(()=>registry.create('a',input,{idempotencyKey:'key'}),code('REGISTRY_STORAGE_UNAVAILABLE'));assert.equal(h.creates.length,0);assert.equal(registry.stats().reservedSessions,0);await registry.shutdown();
 }
});
