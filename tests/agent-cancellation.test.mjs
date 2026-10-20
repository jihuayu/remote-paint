import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {agentCancellationAfter,agentCancellationReport,AGENT_CANCELLATION_LIMITS} from '../service/agent-cancellation.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {DurableAgentExecutor} from '../service/agent-executor.mjs';
import {AgentRpcError} from '../service/agent-rpc.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {fixture,until,deferred,tenantId,actionKey} from './fixtures/agent-executor-fixture.mjs';
import {readyRecords,runIntent,activate,invocationIntent,requested,injected,unknown,rejected,uuid} from './fixtures/session-agent-records.mjs';
import {agentHttpClient,agentPaths} from './fixtures/agent-http-client.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=value=>({code:value}),cursor=(run,sequence,id)=>'acc1.'+run.agentRunId+'.'+sequence+'.'+id;
const token=x=>'fixture_agent_cancel_'+x+'_0000000000000000000',ALL=token('all'),READ=token('read'),END=token('end'),OTHER=token('other'),OTHER_END=token('other_end'),SLOW=token('slow');
const credentials=[{apiKey:ALL,tenantId,scopes:['agents:read','agents:write','agents:end']},{apiKey:READ,tenantId,scopes:['agents:read']},{apiKey:END,tenantId,scopes:['agents:end']},{apiKey:OTHER,tenantId:'tenant-other',scopes:['agents:read']},{apiKey:OTHER_END,tenantId:'tenant-other',scopes:['agents:end']}];
const path=(run,suffix='cancellation')=>'/v1/agent-runs/'+run.agentRunId+'/'+suffix;
const error=(r,status,value)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.body.error.code,value);};
async function httpFixture(t,{http={},authenticate=createApiKeyAuthenticator(credentials),configure}={}){
 const f=await fixture(t),sockets=new Set(),server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate,...http});configure?.(server);server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port,api=agentHttpClient(base,ALL),report=(run,after,key=READ)=>agentHttpClient(base,key)('GET',path(run)+(after===undefined?'':'?after='+after)),cancel=(run,key=END,options)=>agentHttpClient(base,key)('POST',path(run,'cancel'),options);return {...f,server,base,api,report,cancel};
}
async function storeFixture(t){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-cancel-store-')),path=join(directory,'state.sqlite'),store=new SqliteSessionStore({path}),owner=Symbol('cancellation owner'),batch=readyRecords();store.commit(batch);store.claimAgentController(owner);const run=activate(store,owner);const close=()=>{store.releaseAgentController(owner);store.close();};t.after(async()=>{try{close();}catch{}await rm(directory,{recursive:true,force:true});});
 return {directory,path,store,owner,batch,run,close,put:row=>store.commitAgentInvocation(row,{owner}),page:options=>store.agentCancellationSnapshot(run.agentRunId,run.tenant,options,{owner})};
}

test('cancellation cursors bind original Run, generation and invocation without accepting ambiguous numbers',()=>{
 const run={agentRunId:'arun_'+uuid(1)},id='ainv_'+uuid(2);assert.deepEqual(agentCancellationAfter(run.agentRunId),{});assert.deepEqual(agentCancellationAfter(run.agentRunId,cursor(run,1,id)),{eventSequence:1,afterId:id});
 for(const v of ['',null,0,{},cursor(run,0,id),cursor(run,'01',id),cursor(run,9007199254740992,id),cursor(run,1,id)+'\n',cursor({agentRunId:'arun_'+uuid(3)},1,id)])assert.throws(()=>agentCancellationAfter(run.agentRunId,v),TypeError);
});
test('actual cancellation snapshot is owner protected, read only and bounded to four original invocations',enabled,async t=>{
 const f=await storeFixture(t);for(let n=1;n<=9;n++){const row=invocationIntent(f.run,n);f.put(row);f.put(requested(row));f.put(injected(row));}const revision=f.store.agentHead({owner:f.owner}),events=f.store.listAgentEvents(f.run.agentRunId,f.run.tenant,{after:0},{owner:f.owner}),before=await readFile(f.path);
 assert.throws(()=>f.store.agentCancellationSnapshot(f.run.agentRunId,f.run.tenant,{}),code('STATE_AGENT_OWNER'));assert.throws(()=>f.store.agentCancellationSnapshot(f.run.agentRunId,f.run.tenant,{}, {owner:Symbol()}),code('STATE_AGENT_OWNER'));
 let options={},rows=[];for(;;){const page=f.page(options);assert.ok(page.records.length<=4);rows.push(...page.records);if(!page.hasMore)break;options={eventSequence:page.eventSequence,afterId:page.records.at(-1).invocationId};}assert.equal(rows.length,9);assert.equal(new Set(rows.map(r=>r.invocationId)).size,9);assert.deepEqual(f.store.agentHead({owner:f.owner}),revision);assert.deepEqual(f.store.listAgentEvents(f.run.agentRunId,f.run.tenant,{after:0},{owner:f.owner}),events);assert.deepEqual(await readFile(f.path),before);
});
test('store cancellation pages reject malformed accessors, changed generations and invented invocation anchors without poisoning the next read',enabled,async t=>{
 const f=await storeFixture(t);let gets=0;for(const options of [null,[],{limit:5},{afterId:'ainv_'+uuid(1)},{eventSequence:1},{get afterId(){gets++;return 'ainv_'+uuid(1);},eventSequence:1}])assert.throws(()=>f.page(options),code('STATE_AGENT_INVALID'));assert.equal(gets,0);
 const first=f.page({});assert.throws(()=>f.page({eventSequence:first.eventSequence+1,afterId:'ainv_'+uuid(1)}),code('STATE_AGENT_CANCELLATION_CURSOR'));assert.throws(()=>f.page({eventSequence:first.eventSequence,afterId:'ainv_'+uuid(99)}),code('STATE_AGENT_CANCELLATION_CURSOR'));const row=invocationIntent(f.run);f.put(row);assert.throws(()=>f.page({eventSequence:first.eventSequence,afterId:row.invocationId}),code('STATE_AGENT_CANCELLATION_CHANGED'));assert.equal(f.page({}).records.length,1);
});
test('stored cancellation record corruption is rejected before a recovered reader can claim no effects',enabled,async t=>{
 const f=await storeFixture(t),row=invocationIntent(f.run);f.put(row);f.close();const db=new DatabaseSync(f.path);try{db.prepare('UPDATE agent_invocations SET body=? WHERE invocation_id=?').run('{broken',row.invocationId);}finally{db.close();}let next;try{assert.throws(()=>{next=new SqliteSessionStore({path:f.path});next.claimAgentController(Symbol('recovery'));},code('STATE_CORRUPT'));}finally{next?.close();}
});
test('end before queued invocation dispatch reports the original intent and later not dispatched without provider effects',enabled,async t=>{
 const f=await fixture(t),{run,context}=await f.active(),row=f.perform(run,context);f.executor.end(f.runRef(run));const first=f.executor.cancellation(f.runRef(run));assert.equal(first.status,'pending');assert.equal(first.work.ordinaryPending,true);assert.equal(first.invocations[0].effect,'not-dispatched-yet');assert.equal(first.rollbackSupported,false);assert.equal(first.rollbackPerformed,false);await f.invocation(row);await until(()=>f.executor.getRun(f.runRef(run)).state==='closed');const last=f.executor.cancellation(f.runRef(run));assert.equal(last.status,'closed');assert.equal(last.invocations[0].effect,'not-dispatched');assert.equal(last.invocations[0].dispatchStarted,false);assert.equal(f.effects.length,0);
});
test('end before begin reports settling while the actual queued task exists and closes without opening a worker',enabled,async t=>{
 const f=await fixture(t),run=f.create();f.executor.end(f.runRef(run));const first=f.executor.cancellation(f.runRef(run));assert.equal(first.status,'settling');assert.equal(first.run.closeEvidenceKind,'never-dispatched');assert.equal(first.run.holdsWriter,false);assert.equal(first.work.ordinaryPending,true);await until(()=>f.executor.status().ordinary===0);assert.equal(f.executor.cancellation(f.runRef(run)).status,'closed');assert.equal(f.calls.length,0);
});
test('confirmed run closure while an actual invocation remains pending does not claim effects settled or rolled back',enabled,async t=>{
 const f=await fixture(t),{run,context}=await f.active(),gate=deferred(),entered=deferred();f.hooks.perform=async r=>{entered.resolve();await gate.promise;f.effects.push(r.command);return {stage:'input-injected',binding:context.binding,fence:context.fence,inputs:1};};const row=f.perform(run,context);await entered.promise;f.executor.end(f.runRef(run));await until(()=>f.executor.getRun(f.runRef(run)).state==='closed');const pending=f.executor.cancellation(f.runRef(run));assert.equal(pending.status,'settling');assert.equal(pending.run.holdsWriter,false);assert.equal(pending.work.ordinaryPending,true);assert.equal(pending.invocations[0].effect,'unknown');assert.equal(pending.invocations[0].state,'requested');gate.resolve();await f.invocation(row);const final=f.executor.cancellation(f.runRef(run));assert.equal(final.status,'closed');assert.equal(final.invocations[0].effect,'input-injected');assert.deepEqual(final.invocations[0].receipt,{stage:'input-injected',inputs:1});assert.equal(final.rollbackPerformed,false);assert.equal(final.businessSuccessConfirmed,false);assert.equal(f.effects.length,1);
});
test('unknown effect stays unknown after end and idempotent cancellation never replays it',enabled,async t=>{
 const h=await httpFixture(t),{run,context}=await h.active();h.hooks.perform=r=>{h.effects.push(r.command);throw new AgentRpcError('AGENT_RPC_TIMEOUT','unknown');};const row=h.perform(run,context);await h.invocation(row);assert.equal((await h.report(run)).body.data.status,'reconciliation-required');await h.cancel(run);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');const done=await h.cancel(run);assert.equal(done.status,200);assert.equal(done.body.data.status,'closed');assert.equal(done.body.data.invocations[0].effect,'unknown');assert.equal(done.body.data.rollbackPerformed,false);assert.equal(h.perform(run,context).invocationId,row.invocationId);assert.equal(h.effects.length,1);assert.equal(h.calls.filter(r=>r.command.op==='end').length,1);
});
test('failed actual end keeps writer reservation and reports reconciliation rather than successful cancellation',enabled,async t=>{
 const h=await httpFixture(t),{run}=await h.active();h.hooks.end=()=>{throw new AgentRpcError('AGENT_RPC_TIMEOUT','unknown');};assert.equal((await h.cancel(run)).status,202);await until(()=>h.executor.status().ending===0);const result=await h.cancel(run);assert.equal(result.body.data.status,'reconciliation-required');assert.equal(result.body.data.run.holdsWriter,true);assert.equal(result.body.data.run.endDispatch,'requested');assert.equal(h.calls.filter(r=>r.command.op==='end').length,1);
});
test('public cancellation requires agents end while read reports require agents read and exact tenant authority',enabled,async t=>{
 const h=await httpFixture(t),{run}=await h.active();error(await h.cancel(run,READ),403,'FORBIDDEN');error(await h.report(run,undefined,END),403,'FORBIDDEN');error(await h.report(run,undefined,OTHER),404,'AGENT_RUN_NOT_FOUND');error(await h.cancel(run,OTHER_END),404,'AGENT_RUN_NOT_FOUND');assert.equal(h.calls.filter(r=>r.command.op==='end').length,0);const result=await h.cancel(run,END);assert.equal(result.status,202);assert.equal(result.headers.location,path(run));assert.equal(result.body.data.schema,'agent-cancellation-v1');assert.equal(result.headers['cache-control'],'no-store');
});
test('public cancel rejects Origin, request bodies and event headers before invoking end',enabled,async t=>{
 const h=await httpFixture(t),{run}=await h.active();error(await h.cancel(run,END,{headers:{origin:'https://browser.example'}}),403,'MANAGEMENT_ORIGIN_FORBIDDEN');error(await h.cancel(run,END,{data:{rollback:true}}),400,'INVALID_REQUEST');error(await h.cancel(run,END,{headers:{'last-event-id':'x'}}),400,'INVALID_REQUEST');error(await h.api('POST',path(run)),405,'METHOD_NOT_ALLOWED');error(await h.api('GET',path(run,'cancel')),405,'METHOD_NOT_ALLOWED');assert.equal(h.calls.filter(r=>r.command.op==='end').length,0);assert.equal((await h.report(run)).body.data.status,'not-requested');
});
test('public report pagination exposes all original invocation outcomes even after the event retention window has a gap',enabled,async t=>{
 const h=await httpFixture(t),{run,context}=await h.active();for(let i=0;i<24;i++)await h.invocation(h.perform(run,context,'cancel-page-'+i,{text:'secret-cancel-action'}));assert.equal(h.executor.events(h.runRef(run)).gap,true);let after,records=[],generation;for(;;){const r=await h.report(run,after);assert.equal(r.status,200);const p=r.body.data;assert.ok(p.invocations.length<=4);assert.ok(Buffer.byteLength(JSON.stringify(p))<=AGENT_CANCELLATION_LIMITS.pageBytes);generation??=p.page.generation;assert.equal(p.page.generation,generation);assert.equal(p.page.completeRun,false);records.push(...p.invocations);if(!p.page.hasMore)break;after=p.page.nextCursor;assert.match(after,/^acc1\./);}
 assert.equal(records.length,24);assert.equal(new Set(records.map(x=>x.invocationId)).size,24);assert.ok(records.every(x=>x.effect==='input-injected'));assert.doesNotMatch(JSON.stringify(records),/secret-cancel-action|fence|controlSessionId|workerRunId|evidenceSha256|fingerprint/);assert.equal(h.effects.length,24);
});
test('a same Run update invalidates a report page cursor and leaves the executor usable for a fresh report',enabled,async t=>{
 const h=await httpFixture(t),{run,context}=await h.active();for(let i=0;i<5;i++)await h.invocation(h.perform(run,context,'generation-'+i));const first=(await h.report(run)).body.data;assert.ok(first.page.nextCursor);await h.invocation(h.perform(run,context,'generation-new'));error(await h.report(run,first.page.nextCursor),409,'AGENT_CANCELLATION_CHANGED');assert.equal(h.executor.status().state,'active');assert.equal((await h.report(run)).status,200);
});
test('another Run update does not invalidate an original cancellation generation or expose a global ledger revision',enabled,async t=>{
 const h=await httpFixture(t),{run,context}=await h.active();for(let i=0;i<5;i++)await h.invocation(h.perform(run,context,'local-'+i));const first=(await h.report(run)).body.data,ready=await h.createSession('other-run-session'),other=h.executor.create({tenantId,sessionId:ready.sessionId,region:'test',version:ready.version,idempotencyKey:'other-run'});await until(()=>h.executor.getRun(h.runRef(other)).state==='active');const next=(await h.report(run,first.page.nextCursor)).body.data;assert.equal(next.page.generation,first.page.generation);assert.equal(next.invocations.length,1);assert.doesNotMatch(JSON.stringify(next),/ledgerRevision|agentRevision|other-run/);
});
test('public cursor inputs cannot switch Run, invent an anchor or advance into a future generation',enabled,async t=>{
 const h=await httpFixture(t),{run}=await h.active(),report=(await h.report(run)).body.data,sequence=Number(report.page.generation.split('.').at(-1)),id='ainv_'+uuid(900);
 error(await h.report(run,cursor(run,sequence,id)),400,'AGENT_CANCELLATION_CURSOR_INVALID');error(await h.report(run,cursor(run,sequence+1,id)),400,'AGENT_CANCELLATION_CURSOR_INVALID');error(await h.report(run,cursor({agentRunId:'arun_'+uuid(99)},sequence,id)),400,'AGENT_CANCELLATION_CURSOR_INVALID');error(await h.api('GET',path(run)+'?after='+cursor(run,sequence,id)+'&limit=4'),404,'ROUTE_NOT_FOUND');assert.equal(h.executor.status().state,'active');
 let reads=0;assert.throws(()=>h.executor.cancellation(Object.defineProperty(h.runRef(run),'after',{get(){reads++;return 'x';}})),code('AGENT_INVALID_REQUEST'));assert.equal(reads,0);
});
test('independent cancel admission bypasses a noncooperative ordinary HTTP authentication request',enabled,async t=>{
 const gate=deferred(),entered=deferred(),resolve=createApiKeyAuthenticator(credentials),h=await httpFixture(t,{http:{maxConcurrentRequests:1,maxAgentEndRequests:1},authenticate:({token})=>{if(token===SLOW){entered.resolve();return gate.promise;}return resolve({token});}}),{run}=await h.active(),pending=agentHttpClient(h.base,SLOW)('GET',path(run));await entered.promise;assert.equal((await h.cancel(run)).status,202);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');gate.resolve({tenantId,scopes:['agents:read']});assert.equal((await pending).body.data.status,'closed');
});
test('lost cancel HTTP reply keeps the admitted stop and a retry returns the same original effects without a second end',enabled,async t=>{
 let dropped=false;const h=await httpFixture(t,{configure:server=>server.on('request',(req,res)=>{if(!req.url.endsWith('/cancel')||dropped)return;dropped=true;res.end=()=>{res.socket?.destroy();return res;};})}),{run,context}=await h.active();await h.invocation(h.perform(run,context));await assert.rejects(h.cancel(run));await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');const result=await h.cancel(run);assert.equal(result.body.data.status,'closed');assert.equal(result.body.data.invocations[0].effect,'input-injected');assert.equal(h.calls.filter(r=>r.command.op==='end').length,1);assert.equal(h.effects.length,1);
});
test('ledger identity loss fences cancellation admission and report rather than fabricating a cleanup outcome',enabled,async t=>{
 const h=await httpFixture(t),{run}=await h.active(),moved=join(h.directory,'cancel-original.sqlite');await rename(h.path,moved);error(await h.report(run),503,'AGENT_STORAGE_UNAVAILABLE');error(await h.cancel(run),503,'AGENT_STORAGE_UNAVAILABLE');assert.equal(h.calls.filter(r=>r.command.op==='end').length,0);await rename(moved,h.path);
});
test('maximum Unicode Run metadata and a full four invocation report remain inside the fixed byte budget',enabled,async t=>{
 const f=await storeFixture(t);let n=10;for(const character of ['界',String.fromCharCode(0xd800)]){
  n++;const batch=readyRecords('cancel-unicode-'+n,'tenant-unicode-'+n);batch.sessions[0].region=character.repeat(64);batch.sessions[0].version=character.repeat(256);batch.bindings[0].defaults.region=batch.sessions[0].region;f.store.commit(batch);const run=activate(f.store,f.owner,runIntent(n,batch));
  for(let i=1;i<=5;i++){const row=invocationIntent(run,n*10+i);f.put(row);f.put(requested(row));f.put(injected(row));}
  const raw=f.store.agentCancellationSnapshot(run.agentRunId,run.tenant,{}, {owner:f.owner}),report=agentCancellationReport(raw,{ordinaryPending:false,endPending:false,recoveryRequired:false,executorStopping:false});assert.equal(report.invocations.length,4);assert.equal(report.page.hasMore,true);assert.ok(Buffer.byteLength(JSON.stringify(report))<=16384);assert.equal(report.version,batch.sessions[0].version);
 }
});
test('noncooperative cancel authentication retains the shared end lane after timeout without consuming ordinary read capacity',enabled,async t=>{
 const gate=deferred(),resolve=createApiKeyAuthenticator(credentials),h=await httpFixture(t,{http:{maxConcurrentRequests:1,maxAgentEndRequests:1,requestTimeoutMs:50},authenticate:({token})=>token===SLOW?gate.promise:resolve({token})}),{run}=await h.active();error(await h.cancel(run,SLOW),408,'REQUEST_TIMEOUT');error(await h.cancel(run),503,'SERVICE_BUSY');error(await agentHttpClient(h.base,END)('POST',agentPaths.end(run.agentRunId)),503,'SERVICE_BUSY');assert.equal((await h.report(run)).status,200);assert.equal(h.calls.filter(r=>r.command.op==='end').length,0);gate.resolve({tenantId,scopes:['agents:end']});await until(async()=>{const r=await h.cancel(run);return [200,202].includes(r.status);});
});
test('public cancellation during actual pending begin keeps both tasks and never reports a late active Run',enabled,async t=>{
 const h=await httpFixture(t),gate=deferred(),entered=deferred();h.hooks.begin=request=>{entered.resolve(request);return gate.promise;};const run=h.create(),request=await entered.promise,first=await h.cancel(run);assert.equal(first.status,202);assert.equal(first.body.data.status,'pending');assert.equal(first.body.data.work.ordinaryPending,true);assert.equal(first.body.data.work.endPending,true);assert.equal(first.body.data.run.holdsWriter,true);
 const context={binding:{tenantId,sessionId:request.sessionId,targetId:'target_'+uuid(700),runId:'run_'+uuid(701)},fence:{controlSessionId:uuid(702),controlVersion:0,pageEpoch:1,viewportVersion:1}};h.contexts.set(request.sessionId,context);gate.resolve(context);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');const report=(await h.report(run)).body.data;assert.equal(report.status,'closed');assert.equal(report.run.closeEvidenceKind,'worker-run-closed');assert.equal(report.invocations.length,0);assert.equal(h.executor.events(h.runRef(run)).events.some(e=>e.data.state==='active'),false);assert.equal(h.calls.filter(r=>r.command.op==='end').length,1);
});
test('real killed writers recover injected and uncertain effects distinctly in cancellation reports without replay',enabled,async t=>{
 for(const mode of ['effect','receipt']){
  const directory=await mkdtemp(join(tmpdir(),'remote-paint-cancel-crash-')),path=join(directory,'state.sqlite');let message;
  try{
   await withOwnedTestChild(()=>fork(new URL('./fixtures/agent-executor-child.mjs',import.meta.url),[path,directory,mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{[message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,mode);});assert.equal(await readFile(join(directory,'effect'),'utf8'),'one-fixture-effect\n');
   const store=new SqliteSessionStore({path}),calls=[],provider={create(){throw Error('no new browser');},close(){return {status:'cleanup-failed'};},agent(r){calls.push(r);throw Error('no replay');}},providers=new Map([['test',provider]]),registry=new SessionRegistry({store,providers,defaultRegion:'test'}),executor=new DurableAgentExecutor({store,registry,providers,actionKey});
   try{const reference={tenantId,agentRunId:message.run.agentRunId},report=executor.cancellation(reference);assert.equal(report.invocations[0].effect,mode==='effect'?'unknown':'input-injected');assert.equal(report.invocations[0].state,mode==='effect'?'unknown':'injected');assert.equal(report.work.recoveryRequired,true);executor.end(reference);assert.equal(executor.cancellation(reference).run.holdsWriter,true);assert.equal(calls.length,0);assert.equal(await readFile(join(directory,'effect'),'utf8'),'one-fixture-effect\n');}finally{await executor.shutdown({timeoutMs:100});await registry.shutdown();await executor.shutdown({timeoutMs:100});store.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
 }
});
