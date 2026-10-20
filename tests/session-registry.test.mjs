import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionRegistry,SessionApiError} from '../service/session-registry.mjs';
const flush=()=>new Promise(setImmediate);
const request={url:'https://example.test/',region:'test-region'};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function setup(overrides={},limits={}){
 const calls={create:[],close:[]},provider={create:async args=>{calls.create.push(args);return {version:'fixture-v1'};},close:async args=>{calls.close.push(args);return {status:'closed'};},...overrides};
 return {calls,provider,registry:new SessionRegistry({providers:new Map([['test-region',provider]]),defaultRegion:'test-region',...limits})};
}
const code=expected=>error=>error instanceof SessionApiError&&error.code===expected;

test('pending and completed create retries bind one operation and one provider invocation',async()=>{
 const pending=defer(),{registry,calls}=setup({create:args=>{calls.create.push(args);return pending.promise;}});
 const a=registry.create('tenant-a',request,{idempotencyKey:'create-1'}),b=registry.create('tenant-a',{url:request.url},{idempotencyKey:'create-1'});
 assert.equal(a.status,'pending');assert.deepEqual(a,b);assert.equal(calls.create.length,1);assert.equal(registry.stats().reservedSessions,1);
 pending.resolve({version:'fixture-v1',secret:'must-not-escape',browser:{private:true}});await flush();
 const ready=registry.create('tenant-a',request,{idempotencyKey:'create-1'});assert.equal(ready.operationId,a.operationId);assert.equal(ready.status,'succeeded');assert.equal(calls.create.length,1);
 const session=registry.getSession('tenant-a',a.sessionId);assert.equal(session.version,'fixture-v1');assert.equal(session.state,'ready');assert.equal(session.secret,undefined);assert.equal(session.browser,undefined);assert.equal(session.tenant,undefined);
 session.state='closed';ready.status='failed';assert.equal(registry.getSession('tenant-a',a.sessionId).state,'ready');assert.equal(registry.getOperation('tenant-a',a.operationId).status,'succeeded');
});

test('idempotency is tenant-scoped and conflicts never allocate a second resource',async()=>{
 const {registry,calls}=setup();const a=registry.create('tenant-a',request,{idempotencyKey:'same'});
 assert.throws(()=>registry.create('tenant-a',{...request,url:'https://different.test/'},{idempotencyKey:'same'}),code('IDEMPOTENCY_CONFLICT'));
 const b=registry.create('tenant-b',request,{idempotencyKey:'same'});assert.notEqual(a.sessionId,b.sessionId);assert.equal(calls.create.length,2);await flush();
 assert.throws(()=>registry.getSession('tenant-b',a.sessionId),code('SESSION_NOT_FOUND'));assert.throws(()=>registry.getOperation('tenant-b',a.operationId),code('OPERATION_NOT_FOUND'));
});

test('creating Sessions count toward tenant and global quotas before asynchronous work',async()=>{
 const pending=defer(),{registry,calls}=setup({create:args=>{calls.create.push(args);return pending.promise;}},{tenantQuota:1,globalQuota:2});
 const a=registry.create('tenant-a',request,{idempotencyKey:'a'});assert.throws(()=>registry.create('tenant-a',request,{idempotencyKey:'b'}),code('SESSION_QUOTA'));
 registry.create('tenant-b',request,{idempotencyKey:'a'});assert.throws(()=>registry.create('tenant-c',request,{idempotencyKey:'a'}),code('SESSION_QUOTA'));
 assert.equal(calls.create.length,2);assert.equal(registry.create('tenant-a',request,{idempotencyKey:'a'}).operationId,a.operationId);pending.resolve({version:'fixture-v1'});await flush();
});

test('startup failure frees quota only after confirmed provider cleanup and keeps the failure idempotent',async()=>{
 const cleanup=defer(),{registry,calls}=setup({create:async args=>{calls.create.push(args);throw new Error('secret credential must not escape');},close:args=>{calls.close.push(args);return cleanup.promise;}},{tenantQuota:1,globalQuota:1});
 const a=registry.create('tenant-a',request,{idempotencyKey:'a'});await flush();assert.equal(registry.getOperation('tenant-a',a.operationId).status,'pending');assert.equal(registry.stats().reservedSessions,1);
 assert.throws(()=>registry.create('tenant-a',request,{idempotencyKey:'b'}),code('SESSION_QUOTA'));
 cleanup.resolve({status:'closed'});await flush();assert.equal(registry.stats().reservedSessions,0);assert.equal(registry.getSession('tenant-a',a.sessionId).state,'failed');
 const retry=registry.create('tenant-a',request,{idempotencyKey:'a'});assert.equal(retry.operationId,a.operationId);assert.equal(retry.error.code,'SESSION_START_FAILED');assert.doesNotMatch(JSON.stringify(retry),/secret|credential/);assert.equal(calls.create.length,1);assert.equal(calls.close.length,1);
});

test('failed or unconfirmed cleanup quarantines the reserved slot instead of admitting another live instance',async()=>{
 for(const close of [async()=>{throw new Error('close failed');},async()=>undefined,async()=>({status:'closing'})]){
  const {registry}=setup({create:async()=>{throw new Error('startup failed');},close},{tenantQuota:1,globalQuota:1});const a=registry.create('tenant-a',request,{idempotencyKey:'a'});await flush();
  assert.equal(registry.getSession('tenant-a',a.sessionId).state,'cleanup-failed');assert.equal(registry.getSession('tenant-a',a.sessionId).holdsQuota,true);assert.equal(registry.getOperation('tenant-a',a.operationId).error.code,'SESSION_CLEANUP_INCOMPLETE');
  assert.throws(()=>registry.create('tenant-a',request,{idempotencyKey:'b'}),code('SESSION_QUOTA'));
 }
});

test('bounded tombstone capacity never silently forgets an existing idempotency binding',async()=>{
 const {registry}=setup({create:async()=>{throw new Error('startup failed');}},{maxRecords:1});const a=registry.create('tenant-a',request,{idempotencyKey:'a'});await flush();
 assert.equal(registry.stats().reservedSessions,0);assert.throws(()=>registry.create('tenant-b',request,{idempotencyKey:'b'}),code('REGISTRY_CAPACITY'));
 assert.equal(registry.create('tenant-a',request,{idempotencyKey:'a'}).operationId,a.operationId);assert.deepEqual(registry.stats(),{records:1,operations:1,idempotencyBindings:1,reservedSessions:0,maxRecords:1,globalQuota:16});
});

test('invalid regions, URLs, side-effecting request fields and keys are rejected before admission',()=>{
 const {registry,calls}=setup();let getters=0;const accessor={get url(){getters++;return request.url;}};
 for(const input of [null,[],{...request,region:'elsewhere'},{url:'file:///private'},{url:'https://user:password@example.test/'},{url:'not a URL'},{...request,extra:true},accessor,Object.assign(Object.create({}),request),{...request,[Symbol('hidden')]:1}])assert.throws(()=>registry.create('tenant-a',input,{idempotencyKey:'a'}),SessionApiError);
 for(const key of ['', 'has space','x\0y','x'.repeat(129),1])assert.throws(()=>registry.create('tenant-a',request,{idempotencyKey:key}),code('INVALID_IDEMPOTENCY_KEY'));
 assert.equal(getters,0);assert.equal(calls.create.length,0);assert.equal(registry.stats().records,0);
});

test('missing provider version is a startup failure with cleanup rather than a false ready Session',async()=>{
 const {registry,calls}=setup({create:async()=>({secret:'private'})});const a=registry.create('tenant-a',request,{idempotencyKey:'a'});await flush();assert.equal(registry.getOperation('tenant-a',a.operationId).status,'failed');assert.equal(registry.getSession('tenant-a',a.sessionId).state,'failed');assert.equal(calls.close.length,1);
 for(const config of [{},{providers:new Map(),defaultRegion:'test-region'},{providers:new Map([['test-region',{}]]),defaultRegion:'test-region'},{providers:new Map([['test-region',{create(){},close(){}}]]),defaultRegion:'test-region',tenantQuota:2,globalQuota:1}])assert.throws(()=>new SessionRegistry(config),TypeError);
});


test('omitted initial URL uses exact blank page and explicit blank shares the original binding',async()=>{
 const {registry,calls}=setup();const created=registry.create('a',{}, {idempotencyKey:'blank'});
 assert.equal(calls.create[0].url,'about:blank');assert.equal(registry.create('a',{url:'about:blank'},{idempotencyKey:'blank'}).operationId,created.operationId);
 assert.throws(()=>registry.create('a',{url:request.url},{idempotencyKey:'blank'}),code('IDEMPOTENCY_CONFLICT'));assert.equal(calls.create.length,1);await registry.shutdown();
});

test('only exact about:blank is accepted as a non-HTTP initial page',async()=>{
 const {registry,calls}=setup();
 for(const url of [null,1,'',' about:blank','about:blank ','ABOUT:blank','about:blank#fragment','about:blank?query','about:srcdoc','data:text/html,private','javascript:alert(1)','file:///private'])assert.throws(()=>registry.create('a',{url},{idempotencyKey:'key'}),code('INVALID_URL'));
 assert.equal(calls.create.length,0);assert.equal(registry.stats().records,0);await registry.shutdown();
});
