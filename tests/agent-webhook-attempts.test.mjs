import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {AGENT_WEBHOOK_FORMAT} from '../service/agent-webhook-journal.mjs';
import {legacyAgentWebhookSchemaSql} from '../service/agent-webhook-capture-v1.mjs';
import {activate,readyRecords,runIntent,invocationIntent,requested,injected,uuid} from './fixtures/session-agent-records.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=code=>({code}),options=(a,outcome='accepted')=>({deliveryId:a.deliveryId,attemptId:a.attemptId,bodySha256:a.bodySha256,outcome,transportSettled:true});
function edit(path,fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
export function legacyCapture(db){
 const subscriptions=db.prepare('SELECT subscription_id,agent_run_id,tenant,session_id,endpoint_id,start_after,queued_through,observed_latest,missing_from FROM agent_webhooks').all(),deliveries=db.prepare('SELECT subscription_id,agent_run_id,tenant,session_id,sequence,event_id,body,body_sha256 FROM agent_webhook_deliveries').all();
 db.exec('PRAGMA foreign_keys=OFF;DROP TABLE agent_webhook_deliveries;DROP TABLE agent_webhooks;'+legacyAgentWebhookSchemaSql);
 for(const s of subscriptions)db.prepare('INSERT INTO agent_webhooks VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(s));for(const d of deliveries)db.prepare('INSERT INTO agent_webhook_deliveries VALUES(?,?,?,?,?,?,?,?)').run(...Object.values(d));db.prepare("UPDATE metadata SET value='remote-paint-agent-webhooks-v1' WHERE name='agent_webhook_format'").run();
}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-webhook-attempts-')),path=join(directory,'state.sqlite'),store=new SqliteSessionStore({path,enableAgentWebhooks:true}),owner=Symbol(),batch=readyRecords();store.commit(batch);store.claimAgentController(owner);const run=activate(store,owner),s=store.subscribeAgentWebhook(run.agentRunId,run.tenant,{endpointId:'awh_'+uuid(1),after:0},{owner});let detached=false;
 const detach=()=>{store.releaseAgentController(owner);store.close();detached=true;};
 const read=()=>store.readAgentWebhookCapture(s.subscriptionId,run.tenant,{}, {owner});
 const begin=()=>store.beginAgentWebhookAttempt(s.subscriptionId,run.tenant,{owner}).attempt;
 const settle=(a,outcome='accepted')=>store.settleAgentWebhookAttempt(s.subscriptionId,run.tenant,options(a,outcome),{owner});
 t.after(async()=>{if(!detached){const head=read().deliveries[0];if(head?.lastOutcome==='requested')settle(head,'unknown');detach();}await rm(directory,{recursive:true,force:true});});
 return {directory,path,store,owner,run,s,read,begin,settle,detach};
}
function generate(f,n){const i=invocationIntent(f.run,n);for(const r of [i,requested(i),injected(i)])f.store.commitAgentInvocation(r,{owner:f.owner});}
async function killed(f,mode){const marker=join(f.directory,mode);await withOwnedTestChild(()=>fork(new URL('./fixtures/agent-webhook-attempts-child.mjs',import.meta.url),[f.path,mode,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{assert.deepEqual(await once(child,'close',{signal:AbortSignal.timeout(10000)}),[null,'SIGKILL']);});assert.equal(await readFile(marker,'utf8'),mode+'\n');}
function reopened(f,fn){const store=new SqliteSessionStore({path:f.path}),owner=Symbol();try{store.claimAgentController(owner);return fn(store,owner);}finally{store.releaseAgentController(owner);store.close();}}

test('webhook acknowledgment advances only the original current head and preserves its immutable start cursor',enabled,async t=>{
 const f=await fixture(t),before=f.read(),a=f.begin();assert.equal(a.sequence,1);assert.equal(a.body,before.deliveries[0].body);assert.equal(a.eventId,before.deliveries[0].eventId);assert.equal(f.read().acceptedThrough,0);const result=f.settle(a);assert.equal(result.capture.after,0);assert.equal(result.capture.acceptedThrough,1);assert.equal(result.capture.pending,2);assert.equal(f.read().deliveries[0].sequence,2);assert.throws(()=>f.store.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{after:0},{owner:f.owner}),code('STATE_WEBHOOK_CURSOR'));
});
test('a capture body cannot be acknowledged before its durable attempt or without original transport settlement',enabled,async t=>{
 const f=await fixture(t),d=f.read().deliveries[0];assert.throws(()=>f.settle({...d,attemptId:'awat_'+uuid(99)}),code('STATE_WEBHOOK_STALE_ATTEMPT'));const a=f.begin();assert.throws(()=>f.store.settleAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,{...options(a),transportSettled:false},{owner:f.owner}),code('STATE_WEBHOOK_INVALID'));assert.equal(f.read().acceptedThrough,0);f.settle(a);
});
test('retry retains original event ID delivery ID and exact raw body while replacing its one-use attempt ID',enabled,async t=>{
 const f=await fixture(t),a=f.begin();f.settle(a,'unknown');const b=f.begin();assert.equal(b.eventId,a.eventId);assert.equal(b.deliveryId,a.deliveryId);assert.equal(b.body,a.body);assert.equal(b.bodySha256,a.bodySha256);assert.notEqual(b.attemptId,a.attemptId);assert.equal(b.attempts,2);assert.throws(()=>f.settle(a),code('STATE_WEBHOOK_STALE_ATTEMPT'));assert.equal(f.read().acceptedThrough,0);f.settle(b);
});
test('a settled unknown outcome cannot be rewritten into acceptance by a late receipt from that same attempt',enabled,async t=>{
 const f=await fixture(t),a=f.begin();f.settle(a,'unknown');assert.throws(()=>f.settle(a),code('STATE_WEBHOOK_STALE_ATTEMPT'));assert.equal(f.read().acceptedThrough,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');
});
test('duplicate latest acknowledgment is an idempotent no-op even while a later head is actually requested',enabled,async t=>{
 const f=await fixture(t),a=f.begin();f.settle(a);const b=f.begin(),revision=f.read().revision;assert.equal(f.settle(a).duplicate,true);assert.equal(f.read().revision,revision);assert.equal(f.read().acceptedThrough,1);assert.equal(f.read().deliveries[0].attemptId,b.attemptId);f.settle(b);
});
test('old acknowledgments outside the single bounded receipt cannot advance or overwrite future delivery heads',enabled,async t=>{
 const f=await fixture(t),a=f.begin();f.settle(a);const b=f.begin();f.settle(b);const c=f.begin();assert.throws(()=>f.settle(a),code('STATE_WEBHOOK_STALE_ATTEMPT'));assert.equal(f.read().acceptedThrough,2);f.settle(c);assert.equal(f.begin(),null);
});
test('duplicate negative transport outcomes are idempotent but a different settled outcome is rejected',enabled,async t=>{
 const f=await fixture(t),a=f.begin();f.settle(a,'not-accepted');const revision=f.read().revision;assert.equal(f.settle(a,'not-accepted').duplicate,true);assert.equal(f.read().revision,revision);assert.throws(()=>f.settle(a,'unknown'),code('STATE_WEBHOOK_STALE_ATTEMPT'));assert.equal(f.read().pending,3);
});
test('eight actual requested attempts exhaust the original head without deleting it or skipping to a later event',enabled,async t=>{
 const f=await fixture(t),body=f.read().deliveries[0].body;for(let n=1;n<=8;n++){const a=f.begin();assert.equal(a.attempts,n);assert.equal(a.body,body);f.settle(a,n%2?'unknown':'not-accepted');}assert.throws(()=>f.begin(),code('STATE_WEBHOOK_EXHAUSTED'));assert.equal(f.read().acceptedThrough,0);assert.equal(f.read().deliveries[0].attempts,8);assert.equal(f.read().pending,3);f.detach();reopened(f,(s,owner)=>assert.throws(()=>s.beginAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,{owner}),code('STATE_WEBHOOK_EXHAUSTED')));
});
test('requested transport bookkeeping prevents a second attempt controller release or ledger close',enabled,async t=>{
 const f=await fixture(t),a=f.begin();assert.throws(()=>f.begin(),code('STATE_WEBHOOK_IN_FLIGHT'));assert.throws(()=>f.store.releaseAgentController(f.owner),code('STATE_WEBHOOK_IN_FLIGHT'));assert.throws(()=>f.store.close(),code('STATE_IN_USE'));f.store.claimAgentController(f.owner);assert.equal(f.read().deliveries[0].lastOutcome,'requested');f.settle(a,'unknown');f.store.releaseAgentController(f.owner);const next=Symbol();f.store.claimAgentController(next);assert.throws(()=>f.store.beginAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,{owner:f.owner}),code('STATE_AGENT_OWNER'));f.store.releaseAgentController(next);f.store.claimAgentController(f.owner);
});
test('attempt and receipt admission require the current opaque controller and original tenant subscription',enabled,async t=>{
 const f=await fixture(t),a=f.begin();assert.throws(()=>f.store.beginAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,{owner:Symbol()}),code('STATE_AGENT_OWNER'));assert.throws(()=>f.store.settleAgentWebhookAttempt(f.s.subscriptionId,'other',options(a),{owner:f.owner}),code('STATE_WEBHOOK_REFERENCE'));assert.throws(()=>f.store.settleAgentWebhookAttempt('awsub_'+uuid(99),f.run.tenant,options(a),{owner:f.owner}),code('STATE_WEBHOOK_REFERENCE'));assert.equal(f.read().acceptedThrough,0);f.settle(a);
});
test('transport outcomes cannot change original Agent Session writer or original event history',enabled,async t=>{
 const f=await fixture(t),before=f.store.loadAgents({owner:f.owner}),sessions=f.store.load(),events=f.store.listAgentEvents(f.run.agentRunId,f.run.tenant,{}, {owner:f.owner}),a=f.begin();f.settle(a,'unknown');f.settle(f.begin());assert.deepEqual(f.store.loadAgents({owner:f.owner}),before);assert.deepEqual(f.store.load(),sessions);assert.deepEqual(f.store.listAgentEvents(f.run.agentRunId,f.run.tenant,{}, {owner:f.owner}),events);assert.equal(f.store.findAgentWriter(f.run.sessionId,{owner:f.owner}).reserved,true);
});
test('acknowledged capacity is reusable beyond the replay window without rewriting initial subscription identity',enabled,async t=>{
 const f=await fixture(t);while(f.read().pending)f.settle(f.begin());for(let n=1;n<=24;n++){generate(f,n);while(f.read().pending)f.settle(f.begin());}assert.equal(f.read().acceptedThrough,75);assert.equal(f.read().after,0);assert.equal(f.read().pending,0);assert.equal(f.read().reconciliationRequired,false);const same=f.store.subscribeAgentWebhook(f.run.agentRunId,f.run.tenant,{endpointId:'awh_'+uuid(1),after:0},{owner:f.owner});assert.equal(same.subscriptionId,f.s.subscriptionId);assert.equal(same.acceptedThrough,75);
});
test('draining an overflowed known prefix cannot clear a gap or automatically resume past missing original history',enabled,async t=>{
 const f=await fixture(t);for(let n=1;n<=22;n++)generate(f,n);assert.equal(f.read().missingFrom,65);while(f.read().pending)f.settle(f.begin());generate(f,23);const page=f.read();assert.equal(page.acceptedThrough,64);assert.equal(page.queuedThrough,64);assert.equal(page.pending,0);assert.equal(page.missingFrom,65);assert.equal(page.missingThrough,72);assert.equal(f.begin(),null);assert.equal(page.reconciliationRequired,true);
});
test('receipt input validates exact identity hash fields outcomes and data descriptors without invoking getters',enabled,async t=>{
 const f=await fixture(t),a=f.begin();let getters=0;const accessor=Object.defineProperty({...options(a)},'outcome',{get(){getters++;return 'accepted';},enumerable:true});for(const value of [accessor,{...options(a),bodySha256:[]},{...options(a),attemptId:'bad'},{...options(a),outcome:'business-success'},{...options(a),unknown:'x'}])assert.throws(()=>f.store.settleAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,value,{owner:f.owner}),code('STATE_WEBHOOK_INVALID'));assert.equal(getters,0);for(const field of ['deliveryId','attemptId','bodySha256']){const wrong={...options(a),[field]:field==='bodySha256'?'0'.repeat(64):(field==='attemptId'?'awat_':'awdl_')+uuid(999)};assert.throws(()=>f.store.settleAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,wrong,{owner:f.owner}),code('STATE_WEBHOOK_STALE_ATTEMPT'));}f.settle(a);
});
test('receipt transaction failure rolls back body deletion accepted cursor receipt and notification revision together',enabled,async t=>{
 const f=await fixture(t),a=f.begin(),before=f.read(),prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE agent_webhooks SET accepted_through'))return {run(){throw Error('controlled ACK write failure');}};return prepare.call(this,sql);};try{assert.throws(()=>f.settle(a),code('STATE_WEBHOOK_WRITE'));}finally{DatabaseSync.prototype.prepare=prepare;}assert.deepEqual(f.read(),before);f.settle(a);assert.equal(f.read().acceptedThrough,1);
});
test('v1 migration preserves original raw bodies IDs revisions immutable cursor and ledger identity',enabled,async t=>{
 const f=await fixture(t),before=f.read(),identity=f.store.identity(),head=f.store.agentHead({owner:f.owner});f.detach();edit(f.path,legacyCapture);reopened(f,(s,owner)=>{assert.deepEqual(s.identity(),identity);assert.deepEqual(s.agentHead({owner}),head);const page=s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner});assert.equal(page.revision,before.revision);assert.equal(page.after,0);assert.equal(page.acceptedThrough,0);assert.deepEqual(page.deliveries.map(x=>[x.eventId,x.body,x.bodySha256]),before.deliveries.map(x=>[x.eventId,x.body,x.bodySha256]));assert.ok(page.deliveries.every(x=>x.deliveryId.startsWith('awdl_')&&x.attempts===0&&x.attemptId===null));});edit(f.path,db=>assert.equal(db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_format'").get().value,AGENT_WEBHOOK_FORMAT));
});
test('invalid legacy capture is rejected before v2 columns or metadata can be committed',enabled,async t=>{
 const f=await fixture(t);f.detach();edit(f.path,db=>{legacyCapture(db);db.exec("UPDATE agent_webhook_deliveries SET body_sha256='bad' WHERE sequence=1");});assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));edit(f.path,db=>{assert.equal(db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_format'").get().value,'remote-paint-agent-webhooks-v1');assert.equal(db.prepare('PRAGMA table_info(agent_webhooks)').all().some(x=>x.name==='accepted_through'),false);});
});
test('v2 corruption of accepted cursors attempt counts head ordering receipt metadata or body ownership fails closed',enabled,async t=>{
 for(const mode of ['cursor','count','second','ack','outcome','identity']){const f=await fixture(t);f.detach();edit(f.path,db=>{if(mode==='cursor')db.exec('UPDATE agent_webhooks SET accepted_through=1');if(mode==='count')db.exec('UPDATE agent_webhook_deliveries SET attempts=9 WHERE sequence=1');if(mode==='second')db.exec("UPDATE agent_webhook_deliveries SET attempts=1,attempt_id='awat_"+uuid(99)+"',last_outcome='unknown' WHERE sequence=2");if(mode==='ack')db.exec("UPDATE agent_webhooks SET last_ack='{}'");if(mode==='outcome')db.exec("UPDATE agent_webhook_deliveries SET last_outcome='accepted' WHERE sequence=1");if(mode==='identity')db.exec("UPDATE agent_webhook_deliveries SET delivery_id='bad' WHERE sequence=1");});assert.throws(()=>new SqliteSessionStore({path:f.path}),code('STATE_CORRUPT'));}
});
test('real SIGKILL before v1 migration commit retains the old extension for an intact retry',enabled,async t=>{
 const f=await fixture(t),before=f.read();f.detach();edit(f.path,legacyCapture);await killed(f,'migration');edit(f.path,db=>{assert.equal(db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_format'").get().value,'remote-paint-agent-webhooks-v1');assert.equal(db.prepare('PRAGMA table_info(agent_webhooks)').all().some(x=>x.name==='accepted_through'),false);});reopened(f,(s,owner)=>assert.deepEqual(s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner}).deliveries.map(x=>x.body),before.deliveries.map(x=>x.body)));
});
test('real SIGKILL before begin commit cannot consume an attempt or publish a requested transport',enabled,async t=>{
 const f=await fixture(t);f.detach();await killed(f,'begin-rollback');reopened(f,(s,owner)=>{const page=s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner});assert.equal(page.deliveries[0].attempts,0);assert.equal(page.deliveries[0].attemptId,null);assert.equal(page.acceptedThrough,0);});
});
test('real SIGKILL after begin commit recovers requested as unknown without refunding its attempt count or changing Source state',enabled,async t=>{
 const f=await fixture(t),body=f.read().deliveries[0].body,head=f.store.agentHead({owner:f.owner});f.detach();await killed(f,'begin-commit');reopened(f,(s,owner)=>{const page=s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner});assert.equal(page.deliveries[0].attempts,1);assert.equal(page.deliveries[0].lastOutcome,'unknown');assert.equal(page.deliveries[0].body,body);assert.equal(page.acceptedThrough,0);assert.deepEqual(s.agentHead({owner}),head);assert.equal(s.getAgentRun(f.run.agentRunId,{owner}).state,'active');const a=s.beginAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,{owner}).attempt;assert.equal(a.attempts,2);s.settleAgentWebhookAttempt(f.s.subscriptionId,f.run.tenant,options(a,'unknown'),{owner});});
});
test('real SIGKILL before ACK commit retains the original body and recovery cannot invent acceptance',enabled,async t=>{
 const f=await fixture(t),body=f.read().deliveries[0].body;f.detach();await killed(f,'ack-rollback');reopened(f,(s,owner)=>{const p=s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner});assert.equal(p.acceptedThrough,0);assert.equal(p.pending,3);assert.equal(p.deliveries[0].body,body);assert.equal(p.deliveries[0].lastOutcome,'unknown');});
});
test('real SIGKILL after ACK commit retains only the original accepted head and its bounded duplicate receipt',enabled,async t=>{
 const f=await fixture(t);f.detach();await killed(f,'ack-commit');reopened(f,(s,owner)=>{const p=s.readAgentWebhookCapture(f.s.subscriptionId,f.run.tenant,{}, {owner});assert.equal(p.acceptedThrough,1);assert.equal(p.pending,2);assert.equal(p.deliveries[0].sequence,2);assert.equal(p.deliveries[0].attempts,0);});
});
