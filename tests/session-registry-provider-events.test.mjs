import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionRegistry} from '../service/session-registry.mjs';
const flush=()=>new Promise(setImmediate),defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
function setup({pending=false,closeStatus='closed'}={}){
 const start=defer(),cleanup=defer(),calls=[],listeners=new Set();let subscriptions=0,unsubscriptions=0;
 const provider={create:args=>{calls.push({kind:'create',args});return pending?start.promise:Promise.resolve({version:'fixture'});},close:args=>{calls.push({kind:'close',args});return cleanup.promise;},subscribeUnavailable:fn=>{subscriptions++;listeners.add(fn);return()=>{unsubscriptions++;listeners.delete(fn);};}};
 const registry=new SessionRegistry({providers:new Map([['region-a',provider]]),defaultRegion:'region-a'});
 return {registry,calls,listeners,start,cleanup,close:()=>cleanup.resolve({status:closeStatus}),counts:()=>({subscriptions,unsubscriptions}),emit:event=>{for(const fn of listeners)fn(event);}};
}
const event=op=>({sessionId:op.sessionId,tenantId:'tenant-a',region:'region-a'});
test('provider loss immediately fences Ready and retains quota until actual provider confirmation',async()=>{
 const h=setup(),op=h.registry.create('tenant-a',{},{idempotencyKey:'create-1'});await flush();assert.equal(h.registry.requireReady('tenant-a',op.sessionId).state,'ready');
 h.emit(event(op));assert.equal(h.registry.getSession('tenant-a',op.sessionId).state,'closing');assert.throws(()=>h.registry.requireReady('tenant-a',op.sessionId),{code:'SESSION_NOT_READY'});assert.equal(h.registry.stats().reservedSessions,1);
 h.emit(event(op));await flush();assert.equal(h.calls.filter(x=>x.kind==='close').length,1);assert.equal(h.calls.at(-1).args.reason,'worker-unavailable');
 h.close();await flush();assert.equal(h.registry.getSession('tenant-a',op.sessionId).state,'closed');assert.equal(h.registry.stats().reservedSessions,0);await h.registry.shutdown();
});
test('wrong tenant, region and unknown Session events cannot revoke availability',async()=>{
 const h=setup(),op=h.registry.create('tenant-a',{},{idempotencyKey:'create-1'});await flush();
 for(const value of [{...event(op),tenantId:'tenant-b'},{...event(op),region:'region-b'},{...event(op),sessionId:'ses_unknown'},null])h.emit(value);
 assert.equal(h.registry.requireReady('tenant-a',op.sessionId).state,'ready');assert.equal(h.calls.length,1);h.close();await h.registry.shutdown();
});
test('loss during pending creation aborts the owner and prevents late Ready',async()=>{
 const h=setup({pending:true}),op=h.registry.create('tenant-a',{},{idempotencyKey:'create-1'});h.emit(event(op));assert.equal(h.calls[0].args.signal.aborted,true);
 h.start.resolve({version:'late'});await flush();assert.equal(h.registry.getSession('tenant-a',op.sessionId).state,'closing');assert.equal(h.registry.getOperation('tenant-a',op.operationId).error.code,'SESSION_CREATE_CANCELLED');
 h.close();await flush();assert.equal(h.registry.stats().reservedSessions,0);await h.registry.shutdown();
});
test('unconfirmed cleanup keeps the reservation and never restores Ready',async()=>{
 const h=setup({closeStatus:'unconfirmed'}),op=h.registry.create('tenant-a',{},{idempotencyKey:'create-1'});await flush();h.emit(event(op));h.close();await flush();
 assert.equal(h.registry.getSession('tenant-a',op.sessionId).state,'cleanup-failed');assert.equal(h.registry.getSession('tenant-a',op.sessionId).closeReason,'worker-unavailable');assert.equal(h.registry.stats().reservedSessions,1);assert.throws(()=>h.registry.requireReady('tenant-a',op.sessionId),{code:'SESSION_NOT_READY'});await h.registry.shutdown();
});
test('shutdown unsubscribes exactly once and stale callback cannot schedule new cleanup',async()=>{
 const h=setup(),callback=[...h.listeners][0],op=h.registry.create('tenant-a',{},{idempotencyKey:'create-1'});await flush();h.close();await h.registry.shutdown();callback(event(op));await h.registry.shutdown();await flush();
 assert.deepEqual(h.counts(),{subscriptions:1,unsubscriptions:1});assert.equal(h.listeners.size,0);assert.equal(h.calls.filter(x=>x.kind==='close').length,1);
});
test('subscription setup failure releases prior listeners and Registry ledger ownership',()=>{
 const owner=new Set(),store={claimRegistry:x=>owner.add(x),releaseRegistry:x=>owner.delete(x),load:()=>({revision:0,sessions:[],operations:[],bindings:[]}),commit:()=>assert.fail('no writes expected')};let removed=0;
 const base={create(){},close(){}},providers=new Map([['region-a',{...base,subscribeUnavailable:()=>()=>removed++}],['region-b',{...base,subscribeUnavailable(){throw Error('subscription failed');}}]]);
 assert.throws(()=>new SessionRegistry({providers,defaultRegion:'region-a',store}),{code:'REGISTRY_PROVIDER_UNAVAILABLE'});assert.equal(removed,1);assert.equal(owner.size,0);
});
