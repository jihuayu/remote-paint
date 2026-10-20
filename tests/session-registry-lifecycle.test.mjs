import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionRegistry,SessionApiError} from '../service/session-registry.mjs';
const flush=()=>new Promise(setImmediate),request={url:'https://example.test/'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function clock(){
 let mono=0,wall=1700000000000,serial=0;const timers=new Map();
 return {now:()=>mono,wallNow:()=>wall,setTimer:(run,ms)=>{const id=++serial;timers.set(id,{run,at:mono+ms});return id;},clearTimer:id=>timers.delete(id),
  advance(ms,wallDelta=ms){mono+=ms;wall+=wallDelta;},fire(){for(const [id,timer]of [...timers])if(timer.at<=mono){timers.delete(id);timer.run();}},get timers(){return timers.size;}};
}
function setup(override={},options={}){
 const calls={create:[],close:[]},provider={create:async args=>{calls.create.push(args);return {version:'fixture-v1'};},close:async args=>{calls.close.push(args);return {status:'closed'};},...override};
 const registry=new SessionRegistry({providers:new Map([['test',provider]]),defaultRegion:'test',...options});return {registry,provider,calls};
}
const code=value=>error=>error instanceof SessionApiError&&error.code===value;

test('release is idempotent while pending and after confirmation; capacity returns only after close',async()=>{
 const closing=deferred(),{registry,calls}=setup({close:args=>{calls.close.push(args);return closing.promise;}},{tenantQuota:1,globalQuota:1});
 const created=registry.create('a',request,{idempotencyKey:'one'});await flush();const released=registry.release('a',created.sessionId);
 assert.deepEqual(registry.release('a',created.sessionId),released);assert.throws(()=>registry.requireReady('a',created.sessionId),code('SESSION_NOT_READY'));await flush();
 assert.equal(calls.close.length,1);assert.equal(registry.stats().reservedSessions,1);assert.throws(()=>registry.create('a',request,{idempotencyKey:'two'}),code('SESSION_QUOTA'));
 closing.resolve({status:'closed'});await flush();assert.equal(registry.getOperation('a',released.operationId).status,'succeeded');assert.equal(registry.stats().reservedSessions,0);
 assert.equal(registry.release('a',created.sessionId).operationId,released.operationId);const next=registry.create('a',request,{idempotencyKey:'two'});assert.notEqual(next.sessionId,created.sessionId);await flush();assert.equal((await registry.shutdown()).status,'closed');
});

test('release fences a pending create and closes its late resource before reporting success',async()=>{
 const started=deferred(),{registry,calls}=setup({create:args=>{calls.create.push(args);return started.promise;}});const created=registry.create('a',request,{idempotencyKey:'one'}),release=registry.release('a',created.sessionId);await flush();
 assert.equal(calls.create[0].signal.aborted,true);assert.equal(calls.close.length,0);assert.equal(registry.getOperation('a',release.operationId).status,'pending');
 started.resolve({version:'late-ready'});await flush();assert.equal(calls.close.length,1);assert.equal(registry.getSession('a',created.sessionId).state,'closed');assert.equal(registry.getOperation('a',created.operationId).error.code,'SESSION_CREATE_CANCELLED');assert.equal(registry.getOperation('a',release.operationId).status,'succeeded');
 assert.equal(registry.create('a',request,{idempotencyKey:'one'}).operationId,created.operationId);assert.equal(calls.create.length,1);
});

test('TTL uses monotonic time and expired IDs remain tombstones instead of becoming a new page',async()=>{
 const time=clock(),{registry,calls}=setup({}, {clock:time,defaultTtlSeconds:2,maxTtlSeconds:10});const created=registry.create('a',request,{idempotencyKey:'one'});await flush();
 const initial=registry.requireReady('a',created.sessionId);assert.equal(time.timers,1);time.advance(1999,-3600000);time.fire();await flush();assert.equal(registry.requireReady('a',created.sessionId).state,'ready');
 time.advance(1,0);time.fire();assert.throws(()=>registry.requireReady('a',created.sessionId),code('SESSION_EXPIRED'));await flush();const expired=registry.getSession('a',created.sessionId);assert.equal(expired.state,'expired');assert.equal(expired.expiresAt,initial.expiresAt);assert.equal(expired.holdsQuota,false);assert.equal(calls.close.length,1);assert.equal(time.timers,0);
 assert.equal(registry.create('a',request,{idempotencyKey:'one'}).sessionId,created.sessionId);const next=registry.create('a',request,{idempotencyKey:'two'});assert.notEqual(next.sessionId,created.sessionId);await flush();await registry.shutdown();
});

test('readiness enforces expiry even when the event loop has not delivered the timer',async()=>{
 const time=clock(),closing=deferred(),{registry}=setup({close:()=>closing.promise},{clock:time,defaultTtlSeconds:1});const created=registry.create('a',request,{idempotencyKey:'one'});await flush();time.advance(1001);
 assert.throws(()=>registry.requireReady('a',created.sessionId),code('SESSION_EXPIRED'));assert.equal(registry.getSession('a',created.sessionId).holdsQuota,true);closing.resolve({status:'closed'});await flush();assert.equal(registry.getSession('a',created.sessionId).state,'expired');
});

test('one timer handles multiple TTLs and concurrent expiry never duplicates cleanup',async()=>{
 const time=clock(),{registry,calls}=setup({}, {clock:time});const a=registry.create('a',{...request,ttlSeconds:1},{idempotencyKey:'a'}),b=registry.create('a',{...request,ttlSeconds:2},{idempotencyKey:'b'});await flush();assert.equal(time.timers,1);
 time.advance(1000);time.fire();registry.release('a',a.sessionId);await flush();assert.equal(registry.getSession('a',a.sessionId).state,'expired');assert.equal(registry.getSession('a',b.sessionId).state,'ready');assert.equal(time.timers,1);
 time.advance(1000);time.fire();await flush();assert.equal(calls.close.length,2);assert.equal(time.timers,0);assert.equal(registry.stats().reservedSessions,0);
});

test('cleanup failure remains reserved; explicit retries have new queryable outcomes and a fixed attempt bound',async()=>{
 const {registry,calls}=setup({close:async args=>{calls.close.push(args);throw new Error('private close diagnostic');}},{maxCloseAttempts:2});const created=registry.create('a',request,{idempotencyKey:'a'});await flush();const first=registry.release('a',created.sessionId);await flush();
 assert.equal(registry.getOperation('a',first.operationId).status,'failed');const second=registry.release('a',created.sessionId);assert.notEqual(first.operationId,second.operationId);await flush();
 assert.equal(registry.getOperation('a',first.operationId).status,'failed');assert.equal(registry.getOperation('a',second.operationId).status,'failed');assert.equal(calls.close.length,2);assert.equal(registry.stats().reservedSessions,1);assert.throws(()=>registry.release('a',created.sessionId),code('SESSION_CLEANUP_LIMIT'));
 const stopped=await registry.shutdown();assert.equal(stopped.status,'cleanup-incomplete');assert.deepEqual(stopped.remainingSessions,[created.sessionId]);assert.equal(calls.close.length,2);
});

test('a startup cleanup and reentrant release share ownership rather than closing twice',async()=>{
 const closing=deferred(),{registry,calls}=setup({create:async()=>{throw new Error('startup failed');},close:args=>{calls.close.push(args);return closing.promise;}});const created=registry.create('a',request,{idempotencyKey:'a'});await flush();const release=registry.release('a',created.sessionId);closing.resolve({status:'closed'});await flush();
 assert.equal(calls.close.length,1);assert.equal(registry.getOperation('a',release.operationId).status,'succeeded');assert.equal(registry.stats().reservedSessions,0);
});

test('reentrant shutdown during an abort waits for the creation and release completion fences',async()=>{
 const started=deferred();let registry,nestedShutdown;
 const configured=setup({create:args=>{args.signal.addEventListener('abort',()=>{nestedShutdown=registry.shutdown();},{once:true});return started.promise;}});registry=configured.registry;
 const created=registry.create('a',request,{idempotencyKey:'a'});registry.release('a',created.sessionId);let done=false;nestedShutdown.then(()=>{done=true;});await flush();assert.equal(done,false);assert.equal(registry.shutdown(),nestedShutdown);
 started.resolve({version:'late'});assert.deepEqual(await nestedShutdown,{status:'closed',remainingSessions:[]});assert.equal(configured.calls.close.length,1);assert.throws(()=>registry.create('a',request,{idempotencyKey:'b'}),code('REGISTRY_CLOSED'));
});

test('provider creation can synchronously request release without escaping its creation fence',async()=>{
 let registry,released;const pending=deferred();const configured=setup({create:args=>{released=registry.release('a',args.sessionId);return pending.promise;}});registry=configured.registry;const created=registry.create('a',request,{idempotencyKey:'a'});await flush();assert.equal(configured.calls.close.length,0);assert.equal(registry.getSession('a',created.sessionId).state,'closing');
 pending.resolve({version:'late'});await flush();assert.equal(configured.calls.close.length,1);assert.equal(registry.getOperation('a',released.operationId).status,'succeeded');
});

test('TTL validation precedes admission and changing the TTL conflicts with an existing key',async()=>{
 const {registry,calls}=setup({}, {defaultTtlSeconds:3,maxTtlSeconds:5});
 for(const ttlSeconds of [0,-1,1.5,6,Infinity,'3'])assert.throws(()=>registry.create('a',{...request,ttlSeconds},{idempotencyKey:'a'}),code('INVALID_TTL'));
 assert.equal(calls.create.length,0);registry.create('a',request,{idempotencyKey:'a'});assert.throws(()=>registry.create('a',{...request,ttlSeconds:4},{idempotencyKey:'a'}),code('IDEMPOTENCY_CONFLICT'));await flush();await registry.shutdown();
 for(const options of [{defaultTtlSeconds:0},{maxTtlSeconds:2,defaultTtlSeconds:3},{maxCloseAttempts:0},{clock:{}}])assert.throws(()=>setup({},options),TypeError);
});

test('TTL starts on ready rather than consuming the requested lifetime during initialization',async()=>{
 const time=clock(),starting=deferred(),{registry}=setup({create:()=>starting.promise},{clock:time,defaultTtlSeconds:1});const created=registry.create('a',request,{idempotencyKey:'a'});time.advance(10000);await flush();assert.equal(time.timers,0);assert.equal(registry.getSession('a',created.sessionId).state,'creating');
 starting.resolve({version:'fixture-v1'});await flush();time.advance(999);time.fire();assert.equal(registry.requireReady('a',created.sessionId).state,'ready');time.advance(1);time.fire();await flush();assert.equal(registry.getSession('a',created.sessionId).state,'expired');
});

test('a failed release can be retried without rewriting its terminal outcome or freeing quota early',async()=>{
 const closing=deferred();let closes=0;const {registry}=setup({close:async()=>{if(++closes===1)throw new Error('first close failed');return closing.promise;}});const created=registry.create('a',request,{idempotencyKey:'a'});await flush();const first=registry.release('a',created.sessionId);await flush();const second=registry.release('a',created.sessionId);await flush();assert.equal(registry.release('a',created.sessionId).operationId,second.operationId);assert.equal(registry.stats().reservedSessions,1);
 closing.resolve({status:'closed'});await flush();assert.equal(registry.getOperation('a',first.operationId).status,'failed');assert.equal(registry.getOperation('a',second.operationId).status,'succeeded');assert.equal(registry.stats().reservedSessions,0);assert.equal(closes,2);
});

test('direct shutdown is single-flight even when multiple abort handlers reenter it',async()=>{
 const starters=[deferred(),deferred()],nested=[];let registry,index=0;const configured=setup({create:args=>{const result=starters[index++];args.signal.addEventListener('abort',()=>nested.push(registry.shutdown()),{once:true});return result.promise;}});registry=configured.registry;
 registry.create('a',request,{idempotencyKey:'a'});registry.create('b',request,{idempotencyKey:'b'});const stopping=registry.shutdown();assert.equal(nested.length,2);assert.ok(nested.every(p=>p===stopping));let done=false;stopping.then(()=>{done=true;});starters[0].resolve({version:'v1'});await flush();assert.equal(done,false);starters[1].resolve({version:'v1'});assert.deepEqual(await stopping,{status:'closed',remainingSessions:[]});assert.equal(configured.calls.close.length,2);
});

test('provider result accessors cannot run during the transition to ready',async()=>{
 let reads=0;const {registry,calls}=setup({create:async()=>({get version(){reads++;return 'side effect';}})});const created=registry.create('a',request,{idempotencyKey:'a'});await flush();assert.equal(reads,0);assert.equal(registry.getOperation('a',created.operationId).status,'failed');assert.equal(calls.close.length,1);
 assert.throws(()=>setup({}, {clock:{now:()=>NaN,wallNow:()=>0,setTimer(){},clearTimer(){}}}),TypeError);
});
