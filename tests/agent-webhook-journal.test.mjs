import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {AGENT_WEBHOOK_FORMAT} from '../service/agent-webhook-journal.mjs';
import {readyRecords,runIntent,activate,invocationIntent,requested,injected,unknown,unstartedClosed,uuid} from './fixtures/session-agent-records.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=code=>({code}),endpoint=n=>'awh_'+uuid(n),digest=s=>createHash('sha256').update(s).digest('hex');
function edit(path,fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-webhook-capture-')),path=join(directory,'state.sqlite'),store=new SqliteSessionStore({path,enableAgentWebhooks:true,...options}),owner=Symbol(),batch=readyRecords();store.commit(batch);store.claimAgentController(owner);
 const detach=()=>{try{store.releaseAgentController(owner);}catch{}store.close();};t.after(async()=>{detach();await rm(directory,{recursive:true,force:true});});
 return {store,owner,path,directory,batch,detach,subscribe:(run=runIntent(),after=0,n=1)=>store.subscribeAgentWebhook(run.agentRunId,run.tenant,{endpointId:endpoint(n),after},{owner}),read:(s,options)=>store.readAgentWebhookCapture(s.subscriptionId,batch.sessions[0].tenant,options,{owner}),inv:r=>store.commitAgentInvocation(r,{owner})};
}
function all(f,s){const out=[];let after=s.after;for(;;){const page=f.read(s,{after});out.push(...page.deliveries);if(!page.hasMore)return out;after=page.nextCursor;}}
function generate(f,run,n){const i=invocationIntent(run,n);for(const r of [i,requested(i),injected(i)])f.inv(r);}
async function killed(f,mode){const marker=join(f.directory,mode);await withOwnedTestChild(()=>fork(new URL('./fixtures/agent-webhook-journal-child.mjs',import.meta.url),[f.path,mode,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{const exit=await once(child,'close',{signal:AbortSignal.timeout(5000)});assert.deepEqual(exit,[null,'SIGKILL']);});assert.equal(await readFile(marker,'utf8'),mode+'\n');}

test('webhook capture opt-in preserves legacy ledgers without creating notification state',enabled,async t=>{
 const f=await fixture(t,{enableAgentWebhooks:false}),run=activate(f.store,f.owner);assert.throws(()=>f.subscribe(run),code('STATE_WEBHOOK_DISABLED'));f.detach();edit(f.path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'agent_webhook%'").get().n,0);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_format'").get(),undefined);});
});
test('subscription catch-up retains exact original event IDs bodies and independent pagination',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),before=f.store.loadAgents({owner:f.owner}),s=f.subscribe(run);generate(f,run,1);const items=all(f,s);assert.deepEqual(items.map(d=>d.sequence),[1,2,3,4,5,6]);assert.equal(items.length,new Set(items.map(d=>d.eventId)).size);for(const d of items){const e=JSON.parse(d.body);assert.equal(e.schema,'agent-webhook-v1');assert.equal(e.endpointId,endpoint(1));assert.equal(e.subscriptionId,s.subscriptionId);assert.equal(e.event.eventId,d.eventId);assert.equal(d.bodySha256,digest(d.body));}assert.equal(f.read(s).deliveries.length,4);assert.equal(f.read(s,{after:4}).deliveries.length,2);assert.equal(before.revision,3);assert.equal(f.store.agentHead({owner:f.owner}).revision,6);
});
test('notification registration and reads cannot advance Agent revision or produce Source completion',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),before=f.store.loadAgents({owner:f.owner}),session=f.store.load(),s=f.subscribe(run,3);assert.equal(s.pending,0);assert.equal(f.read(s).deliveries.length,0);assert.deepEqual(f.store.loadAgents({owner:f.owner}),before);assert.deepEqual(f.store.load(),session);assert.equal(f.store.findAgentWriter(run.sessionId,{owner:f.owner}).reserved,true);
});
test('same endpoint subscription retries are idempotent while the starting cursor is immutable',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run,1),revision=f.read(s).revision;assert.deepEqual(f.subscribe(run,1),s);assert.equal(f.read(s).revision,revision);assert.throws(()=>f.subscribe(run,2),code('STATE_WEBHOOK_CONFLICT'));assert.equal(f.read(s).revision,revision);
});
test('subscription admission rejects ahead and pruned cursors without silently replacing lost history',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner);assert.throws(()=>f.subscribe(run,4),code('STATE_WEBHOOK_CURSOR'));for(let n=1;n<=22;n++)generate(f,run,n);assert.throws(()=>f.subscribe(run,0),code('STATE_WEBHOOK_CURSOR'));const s=f.subscribe(run,5);assert.equal(s.pending,64);assert.deepEqual(all(f,s).map(d=>d.sequence),Array.from({length:64},(_,i)=>i+6));
});
test('full capture preserves its known prefix and records an expanding gap without blocking original actions',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run);for(let n=1;n<=22;n++)generate(f,run,n);const page=f.read(s);assert.equal(page.pending,64);assert.equal(page.queuedThrough,64);assert.equal(page.observedLatest,69);assert.equal(page.reconciliationRequired,true);assert.equal(page.missingFrom,65);assert.equal(page.missingThrough,69);assert.equal(f.store.getAgentInvocation(invocationIntent(run,22).invocationId,{owner:f.owner}).state,'injected');const before=all(f,s);generate(f,run,23);assert.deepEqual(all(f,s),before);assert.equal(f.read(s).missingThrough,72);assert.equal(f.store.findAgentWriter(run.sessionId,{owner:f.owner}).reserved,true);
});
test('queued bodies survive pruning of the independent 64-event replay window unchanged',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run),first=f.read(s).deliveries[0];for(let n=1;n<=23;n++)generate(f,run,n);assert.equal(f.store.listAgentEvents(run.agentRunId,run.tenant,{}, {owner:f.owner}).gap,true);assert.deepEqual(f.read(s).deliveries[0],first);assert.equal(JSON.parse(first.body).event.sequence,1);
});
test('notification capacity is bounded per Run and globally without changing original Agent admission',enabled,async t=>{
 const f=await fixture(t);let first;for(let n=1;n<=16;n++){const batch=n===1?f.batch:readyRecords('run-'+n,'tenant-run-'+n);if(n!==1)f.store.commit(batch);const run=runIntent(n,batch);f.store.commitAgentRun(run,{owner:f.owner});if(!first)first=run;for(let k=1;k<=4;k++)f.subscribe(run,1,k);assert.throws(()=>f.subscribe(run,1,5),code('STATE_WEBHOOK_LIMIT'));}const batch=readyRecords('overflow','tenant-overflow');f.store.commit(batch);const run=runIntent(17,batch);f.store.commitAgentRun(run,{owner:f.owner});assert.throws(()=>f.subscribe(run,1),code('STATE_WEBHOOK_LIMIT'));assert.equal(f.store.getAgentRun(run.agentRunId,{owner:f.owner}).state,'intent');assert.equal(f.store.getAgentRun(first.agentRunId,{owner:f.owner}).reserved,true);
});
test('capture calls require original opaque controller ownership and fixed tenant identity',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run);assert.throws(()=>f.store.subscribeAgentWebhook(run.agentRunId,run.tenant,{endpointId:endpoint(2),after:0}),code('STATE_AGENT_OWNER'));assert.throws(()=>f.store.readAgentWebhookCapture(s.subscriptionId,run.tenant,{}, {owner:Symbol()}),code('STATE_AGENT_OWNER'));assert.throws(()=>f.store.subscribeAgentWebhook(run.agentRunId,'other',{endpointId:endpoint(2),after:0},{owner:f.owner}),code('STATE_AGENT_REFERENCE'));assert.throws(()=>f.store.readAgentWebhookCapture(s.subscriptionId,'other',{}, {owner:f.owner}),code('STATE_WEBHOOK_REFERENCE'));
});
test('bounded capture options reject accessors extra fields coercions and out-of-range cursors',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run);let getters=0;const invalid=Object.defineProperty({endpointId:endpoint(2)},'after',{get(){getters++;return 0;},enumerable:true});for(const options of [invalid,{endpointId:endpoint(2),after:'0'},{endpointId:endpoint(2),after:-1},{endpointId:endpoint(2),after:0,url:'https://private.invalid'}])assert.throws(()=>f.store.subscribeAgentWebhook(run.agentRunId,run.tenant,options,{owner:f.owner}),code('STATE_WEBHOOK_INVALID'));for(const options of [{limit:0},{limit:5},{limit:null},{after:null},{after:4},{after:-1},{after:'0'}])assert.throws(()=>f.read(s,options),code('STATE_WEBHOOK_CURSOR'));assert.throws(()=>f.read(s,{url:'https://private.invalid'}),code('STATE_WEBHOOK_INVALID'));assert.equal(getters,0);
});
test('closed original Run capture remains readable and cannot reopen its writer reservation',enabled,async t=>{
 const f=await fixture(t),run=runIntent();f.store.commitAgentRun(run,{owner:f.owner});const s=f.subscribe(run);f.store.commitAgentRun(unstartedClosed(run),{owner:f.owner});assert.equal(JSON.parse(all(f,s).at(-1).body).event.data.state,'closed');assert.equal(f.store.findAgentWriter(run.sessionId,{owner:f.owner}),null);assert.equal(f.read(s).pending,2);
});
test('existing capture automatically resumes on reopen without needing the creation flag',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run),i=invocationIntent(run);f.inv(i);f.inv(requested(i));const before=all(f,s),identity=f.store.identity();f.detach();const next=new SqliteSessionStore({path:f.path}),owner=Symbol();try{next.claimAgentController(owner);assert.deepEqual(next.identity(),identity);next.commitAgentInvocation(unknown(requested(i)),{owner});const page=next.readAgentWebhookCapture(s.subscriptionId,run.tenant,{after:3},{owner});assert.deepEqual(page.deliveries.slice(0,2),before.slice(3));assert.equal(JSON.parse(page.deliveries[2].body).event.data.state,'unknown');assert.equal(next.getAgentInvocation(i.invocationId,{owner}).receipt,null);}finally{next.releaseAgentController(owner);next.close();}
});
test('notification insertion failure rolls back Agent state event cursor capture and both revisions together',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run),i=invocationIntent(run);f.inv(i);const before=f.read(s),head=f.store.agentHead({owner:f.owner}),prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('INSERT INTO agent_webhook_deliveries'))return {run(){throw Error('controlled capture insert failure');}};return prepare.call(this,sql);};try{assert.throws(()=>f.inv(requested(i)),code('STATE_AGENT_WRITE'));}finally{DatabaseSync.prototype.prepare=prepare;}assert.deepEqual(f.read(s),before);assert.deepEqual(f.store.agentHead({owner:f.owner}),head);assert.equal(f.store.getAgentInvocation(i.invocationId,{owner:f.owner}).state,'intent');f.inv(requested(i));assert.equal(f.read(s,{after:4}).deliveries[0].sequence,5);
});
test('unsupported capture format missing tables foreign tables and corrupt revision fail closed',enabled,async t=>{
 for(const mode of ['format','missing','foreign','revision','without-events']){const f=await fixture(t);f.detach();edit(f.path,db=>{if(mode==='format')db.exec("UPDATE metadata SET value='foreign' WHERE name='agent_webhook_format'");if(mode==='missing')db.exec('DROP TABLE agent_webhook_deliveries');if(mode==='foreign')db.exec('CREATE TABLE zz_foreign(body TEXT)');if(mode==='revision')db.exec("UPDATE metadata SET value='01' WHERE name='agent_webhook_revision'");if(mode==='without-events')db.exec("DROP TABLE agent_events;DROP TABLE agent_event_heads;DELETE FROM metadata WHERE name='agent_event_format'");});assert.throws(()=>new SqliteSessionStore({path:f.path}),code(mode==='revision'?'STATE_CORRUPT':'STATE_SCHEMA'));}
});
test('persisted capture rejects altered event identity body hash holes and inconsistent overflow metadata',enabled,async t=>{
 for(const mode of ['hash','event','hole','gap','tenant','fields']){const f=await fixture(t),run=activate(f.store,f.owner);f.subscribe(run);f.detach();edit(f.path,db=>{if(mode==='hash')db.exec("UPDATE agent_webhook_deliveries SET body_sha256='bad' WHERE sequence=1");if(mode==='event')db.exec("UPDATE agent_webhook_deliveries SET event_id='aevt_"+uuid(999)+"' WHERE sequence=1");if(mode==='hole')db.exec('DELETE FROM agent_webhook_deliveries WHERE sequence=2');if(mode==='gap')db.exec('UPDATE agent_webhooks SET missing_from=4,observed_latest=4');if(mode==='tenant'){db.exec('PRAGMA foreign_keys=OFF');db.exec("UPDATE agent_webhook_deliveries SET tenant='other'");}if(mode==='fields'){const r=db.prepare('SELECT body FROM agent_webhook_deliveries WHERE sequence=1').get(),body=JSON.stringify({...JSON.parse(r.body),secret:'forbidden'});db.prepare('UPDATE agent_webhook_deliveries SET body=?,body_sha256=? WHERE sequence=1').run(body,digest(body));}});assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));}
});
test('real writer SIGKILL before capture migration commit leaves original schema identity and revisions intact',enabled,async t=>{
 const f=await fixture(t,{enableAgentWebhooks:false});activate(f.store,f.owner);const identity=f.store.identity(),head=f.store.agentHead({owner:f.owner});f.detach();await killed(f,'migration');edit(f.path,db=>{assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'agent_webhook%'").get().n,0);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_format'").get(),undefined);});const next=new SqliteSessionStore({path:f.path,enableAgentWebhooks:true}),owner=Symbol();try{next.claimAgentController(owner);assert.deepEqual(next.identity(),identity);assert.deepEqual(next.agentHead({owner}),head);}finally{next.releaseAgentController(owner);next.close();}
});
test('real writer SIGKILL before subscription commit cannot publish a partial capture prefix',enabled,async t=>{
 const f=await fixture(t);activate(f.store,f.owner);f.detach();await killed(f,'subscribe');const next=new SqliteSessionStore({path:f.path}),owner=Symbol();try{next.claimAgentController(owner);const s=next.subscribeAgentWebhook(runIntent().agentRunId,runIntent().tenant,{endpointId:endpoint(1),after:0},{owner});assert.equal(s.pending,3);assert.equal(next.readAgentWebhookCapture(s.subscriptionId,runIntent().tenant,{}, {owner}).revision,1);}finally{next.releaseAgentController(owner);next.close();}
});
test('real writer SIGKILL before outcome commit retains original requested effect event and capture together',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),s=f.subscribe(run),i=invocationIntent(run);f.inv(i);f.inv(requested(i));const before=all(f,s),head=f.store.agentHead({owner:f.owner});f.detach();await killed(f,'outcome');const next=new SqliteSessionStore({path:f.path}),owner=Symbol();try{next.claimAgentController(owner);assert.equal(next.getAgentInvocation(i.invocationId,{owner}).state,'requested');assert.deepEqual(next.agentHead({owner}),head);assert.equal(next.readAgentWebhookCapture(s.subscriptionId,run.tenant,{}, {owner}).observedLatest,5);assert.deepEqual(next.readAgentWebhookCapture(s.subscriptionId,run.tenant,{after:3},{owner}).deliveries,before.slice(3));}finally{next.releaseAgentController(owner);next.close();}
});

function closedRun(f,n,batch=f.batch){const run=runIntent(n,batch);f.store.commitAgentRun(run,{owner:f.owner});f.store.commitAgentRun(unstartedClosed(run),{owner:f.owner});return run;}
const subscriptions=(f,options={},tenant=f.batch.sessions[0].tenant)=>f.store.listAgentWebhookSubscriptions(tenant,{endpointId:endpoint(1),...options},{owner:f.owner});
test('endpoint subscription discovery returns at most four ordered metadata records without delivery bodies or state writes',enabled,async t=>{
 const f=await fixture(t),ids=[];for(let n=1;n<=9;n++)ids.push(f.subscribe(closedRun(f,n)).subscriptionId);const before=f.store.agentWebhookHead({owner:f.owner}),seen=[];let after='';for(;;){const page=subscriptions(f,{after});assert.ok(page.subscriptions.length<=4);assert.equal(page.revision,before.revision);for(const s of page.subscriptions){assert.equal(s.pending,2);assert.deepEqual(Object.keys(s.head),['eventId','sequence','attempts','lastOutcome']);assert.ok(!JSON.stringify(s).includes('body'));seen.push(s.subscriptionId);}if(!page.hasMore)break;assert.notEqual(page.nextCursor,after);after=page.nextCursor;}assert.deepEqual(seen,ids.sort());assert.deepEqual(f.store.agentWebhookHead({owner:f.owner}),before);
});
test('subscription discovery pins tenant endpoint and original cursor ownership instead of borrowing foreign cursors',enabled,async t=>{
 const f=await fixture(t),a=closedRun(f,1),one=f.subscribe(a),two=f.subscribe(a,0,2),batch=readyRecords('other','tenant-b');f.store.commit(batch);const foreign=f.store.subscribeAgentWebhook(closedRun(f,2,batch).agentRunId,'tenant-b',{endpointId:endpoint(1),after:0},{owner:f.owner});assert.equal(subscriptions(f).subscriptions.length,1);assert.equal(subscriptions(f,{endpointId:endpoint(2)}).subscriptions.length,1);assert.equal(subscriptions(f,{},'tenant-b').subscriptions.length,1);for(const after of [two.subscriptionId,foreign.subscriptionId,'awsub_'+uuid(999)])assert.throws(()=>subscriptions(f,{after}),code('STATE_WEBHOOK_REFERENCE'));assert.equal(subscriptions(f,{after:one.subscriptionId}).subscriptions.length,0);
});
test('subscription discovery rejects malformed bounds getters proxies and extra routing fields without executing caller code',enabled,async t=>{
 const f=await fixture(t);let calls=0;for(const value of [null,[],{}, {endpointId:endpoint(1),limit:0},{endpointId:endpoint(1),limit:5},{endpointId:endpoint(1),after:null},{endpointId:endpoint(1),after:undefined},{endpointId:endpoint(1),url:'https://private/'}])assert.throws(()=>f.store.listAgentWebhookSubscriptions('tenant-a',value,{owner:f.owner}),code('STATE_WEBHOOK_INVALID'));const getter=Object.defineProperty({endpointId:endpoint(1)},'after',{get(){calls++;return '';}}),proxy=new Proxy({endpointId:endpoint(1)},{ownKeys(){calls++;return ['endpointId'];}});for(const value of [getter,proxy])assert.throws(()=>f.store.listAgentWebhookSubscriptions('tenant-a',value,{owner:f.owner}),code('STATE_WEBHOOK_INVALID'));assert.equal(calls,0);
});
test('subscription revision and discovery require the original controller and explicit webhook extension',enabled,async t=>{
 const f=await fixture(t);f.subscribe(closedRun(f,1));assert.throws(()=>f.store.agentWebhookHead(),code('STATE_AGENT_OWNER'));assert.throws(()=>f.store.listAgentWebhookSubscriptions('tenant-a',{endpointId:endpoint(1)}),code('STATE_AGENT_OWNER'));f.store.releaseAgentController(f.owner);assert.throws(()=>subscriptions(f),code('STATE_AGENT_OWNER'));f.store.claimAgentController(f.owner);const disabled=await fixture(t,{enableAgentWebhooks:false});assert.throws(()=>disabled.store.agentWebhookHead({owner:disabled.owner}),code('STATE_WEBHOOK_DISABLED'));assert.throws(()=>subscriptions(disabled),code('STATE_WEBHOOK_DISABLED'));
});
test('subscription metadata restart preserves original IDs cursors and revision without recreating captured work',enabled,async t=>{
 const f=await fixture(t);for(let n=1;n<=5;n++)f.subscribe(closedRun(f,n));const page=subscriptions(f),head=f.store.agentWebhookHead({owner:f.owner});f.detach();const next=new SqliteSessionStore({path:f.path}),owner=Symbol();try{next.claimAgentController(owner);assert.deepEqual(next.agentWebhookHead({owner}),head);assert.deepEqual(next.listAgentWebhookSubscriptions('tenant-a',{endpointId:endpoint(1)},{owner}),page);}finally{next.releaseAgentController(owner);next.close();}
});
test('subscription metadata head reflects exact durable attempt consumption and ACK advancement without claiming delivery',enabled,async t=>{
 const f=await fixture(t),sub=f.subscribe(closedRun(f,1));for(let n=1;n<=8;n++){const a=f.store.beginAgentWebhookAttempt(sub.subscriptionId,'tenant-a',{owner:f.owner}).attempt;let item=subscriptions(f).subscriptions[0];assert.equal(item.head.attempts,n);assert.equal(item.head.lastOutcome,'requested');assert.equal(item.head.eventId,a.eventId);f.store.settleAgentWebhookAttempt(sub.subscriptionId,'tenant-a',{deliveryId:a.deliveryId,attemptId:a.attemptId,bodySha256:a.bodySha256,outcome:n===8?'accepted':'unknown',transportSettled:true},{owner:f.owner});}const item=subscriptions(f).subscriptions[0];assert.equal(item.acceptedThrough,1);assert.equal(item.head.sequence,2);assert.equal(item.head.attempts,0);assert.equal(item.head.lastOutcome,null);
});
test('subscription discovery reports the retained prefix and explicit gap without skipping missing Source history',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),sub=f.subscribe(run);for(let n=1;n<=22;n++)generate(f,run,n);const before=f.read(sub),item=subscriptions(f).subscriptions[0];assert.equal(item.pending,64);assert.equal(item.head.sequence,1);assert.equal(item.reconciliationRequired,true);assert.equal(item.missingFrom,65);assert.equal(item.missingThrough,69);assert.deepEqual(f.read(sub),before);assert.equal(f.store.findAgentWriter(run.sessionId,{owner:f.owner}).reserved,true);
});
test('trusted dispatcher discovery captures its endpoint and revision without accepting per-read URLs or keys',enabled,async t=>{
 const {createAgentWebhookDispatcher}=await import('../service/agent-webhook-dispatcher.mjs'),f=await fixture(t),sub=f.subscribe(closedRun(f,1)),worker=createAgentWebhookDispatcher({store:f.store,owner:f.owner,tenantId:'tenant-a',endpointId:endpoint(1),url:'https://127.0.0.1:443/hook',keys:[{keyId:'fixture',secret:Buffer.alloc(32,0x57)}],activeKeyId:'fixture'});try{assert.equal(worker.revision(),f.store.agentWebhookHead({owner:f.owner}).revision);assert.equal(worker.list().subscriptions[0].subscriptionId,sub.subscriptionId);for(const options of [{endpointId:endpoint(2)},{url:'https://private/'},{keys:[]}])assert.throws(()=>worker.list(options),code('AGENT_WEBHOOK_STATE_UNAVAILABLE'));}finally{await worker.close();}
});


test('one capture validation shares a fresh invocation parent within the exact retained Source window',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),sub=f.subscribe(run);generate(f,run,1);const before=all(f,sub),expected=new Set(before.map(r=>JSON.parse(r.body).event).filter(e=>e.type==='invocation.updated').map(e=>e.data.invocationId)).size,prepare=DatabaseSync.prototype.prepare;let parentReads=0;
 DatabaseSync.prototype.prepare=function(sql,...args){if(sql.startsWith('SELECT invocation_id,agent_run_id,tenant,session_id,body FROM agent_invocations WHERE invocation_id IN ('))parentReads++;return prepare.call(this,sql,...args);};try{assert.equal(f.read(sub).pending,6);}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(parentReads,expected);assert.equal(parentReads,1);assert.deepEqual(all(f,sub),before);
});
test('retained capture equality rejects valid-but-different Source or captured event bytes after recomputing hashes',enabled,async t=>{
 for(const side of ['source','capture']){const f=await fixture(t),run=activate(f.store,f.owner);f.subscribe(run);f.detach();edit(f.path,db=>{const table=side==='source'?'agent_events':'agent_webhook_deliveries',row=db.prepare('SELECT body FROM '+table+' WHERE sequence=1').get(),value=JSON.parse(row.body),event=side==='source'?value:value.event;event.observedAt=new Date(Date.parse(event.observedAt)+1).toISOString();const body=JSON.stringify(value);if(side==='source')db.prepare('UPDATE agent_events SET body=? WHERE sequence=1').run(body);else db.prepare('UPDATE agent_webhook_deliveries SET body=?,body_sha256=? WHERE sequence=1').run(body,digest(body));});assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));}
});
test('retained and evicted capture envelopes reject foreign routing and noncanonical bytes even with matching hashes',enabled,async t=>{
 for(const evicted of [false,true])for(const mode of ['endpoint','extra','order','whitespace']){
  const f=await fixture(t),run=activate(f.store,f.owner);f.subscribe(run);if(evicted)for(let n=1;n<=22;n++)generate(f,run,n);f.detach();
  edit(f.path,db=>{const value=JSON.parse(db.prepare('SELECT body FROM agent_webhook_deliveries WHERE sequence=1').get().body);let body;
   if(mode==='endpoint'){value.endpointId=endpoint(2);body=JSON.stringify(value);}else if(mode==='extra')body=JSON.stringify({...value,extra:true});else if(mode==='order')body=JSON.stringify({endpointId:value.endpointId,schema:value.schema,subscriptionId:value.subscriptionId,event:value.event});else body=' '+JSON.stringify(value);
   db.prepare('UPDATE agent_webhook_deliveries SET body=?,body_sha256=? WHERE sequence=1').run(body,digest(body));
  });assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));
 }
});
test('original prefix evicted from Source replay still checks its real invocation parent after canonical hash recomputation',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner);f.subscribe(run);for(let i=1;i<=22;i++)generate(f,run,i);f.detach();edit(f.path,db=>{assert.equal(db.prepare('SELECT min(sequence) AS first FROM agent_events').get().first,6);const row=db.prepare('SELECT body FROM agent_webhook_deliveries WHERE sequence=4').get(),value=JSON.parse(row.body);value.event.data.tool='click';const body=JSON.stringify(value);db.prepare('UPDATE agent_webhook_deliveries SET body=?,body_sha256=? WHERE sequence=4').run(body,digest(body));});assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));
});


test('warm projection parsing never bypasses fresh current invocation ownership and semantic checks',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),sub=f.subscribe(run);generate(f,run,1);const before=all(f,sub),prepare=DatabaseSync.prototype.prepare;
 for(const mode of ['tenant','tool','state']){DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);if(!sql.startsWith('SELECT invocation_id,agent_run_id,tenant,session_id,body FROM agent_invocations WHERE invocation_id IN ('))return statement;return {all(...values){return statement.all(...values).map(row=>{if(mode==='tenant')return {...row,tenant:'foreign'};const current=JSON.parse(row.body);if(mode==='tool')current.tool='click';else current.state='unknown';return {...row,body:JSON.stringify(current)};});}};};try{assert.throws(()=>f.read(sub),code('STATE_CORRUPT'));}finally{DatabaseSync.prototype.prepare=prepare;}}
 assert.deepEqual(all(f,sub),before);
});
test('a caller cannot mutate the internally cached exact event projection through a returned capture page',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),sub=f.subscribe(run),before=all(f,sub),page=f.store.listAgentEvents(run.agentRunId,run.tenant,{}, {owner:f.owner});page.events[0].data.state='closed';page.events[0].eventId='aevt_'+uuid(123);assert.deepEqual(all(f,sub),before);const again=f.store.listAgentEvents(run.agentRunId,run.tenant,{}, {owner:f.owner});assert.notEqual(again.events[0].data.state,'closed');assert.notEqual(again.events[0].eventId,page.events[0].eventId);
});

test('warm retained envelope reuse rejects fresh forged Source bytes capture bytes hashes and endpoint routing',enabled,async t=>{
 const f=await fixture(t),run=activate(f.store,f.owner),sub=f.subscribe(run),before=all(f,sub),prepare=DatabaseSync.prototype.prepare;
 for(const mode of ['source-body','capture-body','capture-hash','routing']){
  assert.deepEqual(all(f,sub),before);
  DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);
   if(mode==='routing'&&sql==='SELECT * FROM agent_webhooks WHERE subscription_id=? AND tenant=?')return {get(...values){return {...statement.get(...values),endpoint_id:endpoint(2)};}};
   const source=sql==='SELECT * FROM agent_events WHERE agent_run_id=? ORDER BY sequence LIMIT 65',capture=sql==='SELECT * FROM agent_webhook_deliveries WHERE subscription_id=? ORDER BY sequence LIMIT 65';
   if(!(source&&mode==='source-body'||capture&&mode.startsWith('capture-')))return statement;
   return {all(...values){return statement.all(...values).map((row,i)=>{if(i)return row;if(mode==='capture-hash')return {...row,body_sha256:'0'.repeat(64)};const value=JSON.parse(row.body),event=source?value:value.event;event.observedAt=new Date(Date.parse(event.observedAt)+1).toISOString();const body=JSON.stringify(value);return source?{...row,body}:{...row,body,body_sha256:digest(body)};});}};
  };
  try{assert.throws(()=>f.read(sub),code('STATE_CORRUPT'));}finally{DatabaseSync.prototype.prepare=prepare;}
 }
 assert.deepEqual(all(f,sub),before);assert.equal(f.store.findAgentWriter(run.sessionId,{owner:f.owner}).reserved,true);
});
