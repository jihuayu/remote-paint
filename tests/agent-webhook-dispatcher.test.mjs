import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lookup} from 'node:dns';
import {DatabaseSync} from 'node:sqlite';
import {createAgentWebhookDispatcher} from '../service/agent-webhook-dispatcher.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {readyRecords,runIntent,activate,uuid} from './fixtures/session-agent-records.mjs';
import {fixture as executorFixture,deferred,until} from './fixtures/agent-executor-fixture.mjs';
import {receiver,dnsReceiver,acknowledge,cert,secret,endpointId} from './fixtures/agent-webhook-https.mjs';
const enabled={skip:!sessionStoreSupported},code=code=>({code}),tick=()=>new Promise(setImmediate),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const config=peer=>({tenantId:'tenant-a',endpointId,url:peer.url,keys:[{keyId:'fixture',secret:Buffer.from(secret)}],activeKeyId:'fixture',ca:cert,retryBaseMs:10,timeoutMs:2000});
async function fixture(t,peer,{workerOptions={},batch=readyRecords()}={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-webhook-https-')),owner=Symbol();let store,worker;
 t.after(async()=>{await worker?.close({signal:AbortSignal.timeout(2000)});if(store){try{store.releaseAgentController(owner);}catch{}store.close();}await rm(directory,{recursive:true,force:true});});
 store=new SqliteSessionStore({path:join(directory,'state.sqlite'),enableAgentWebhooks:true});store.commit(batch);store.claimAgentController(owner);const run=activate(store,owner,runIntent(1,batch)),options={...config(peer),tenantId:run.tenant,...workerOptions};worker=createAgentWebhookDispatcher({...options,store,owner});const sub=worker.subscribe({agentRunId:run.agentRunId,after:0});return {store,owner,run,options,worker,sub,read:()=>worker.read(sub.subscriptionId),deliver:(options={})=>worker.deliver(sub.subscriptionId,options)};
}
function gatedLookup(){
 const entered=deferred();let ready=null,released=false;
 const fn=(host,opts,callback)=>lookup('localhost',{...opts,family:4},(err,address,family)=>{ready=()=>callback(err,address,family);entered.resolve();if(released)ready();});
 return {fn,entered:entered.promise,release(){if(released)return;released=true;ready?.();}};
}

test('actual TLS receiver authenticates exact original signed bytes and advances only that head after complete ACK',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer),before=f.read().deliveries[0],result=await f.deliver();assert.equal(result.status,'accepted');assert.equal(result.sequence,1);assert.equal(result.acceptedThrough,1);assert.equal(result.attempts,1);assert.equal(peer.requests.length,1);assert.equal(peer.requests[0].body.toString('utf8'),before.body);assert.equal(peer.requests[0].bodySha256,before.bodySha256);assert.equal(peer.requests[0].eventId,before.eventId);assert.equal(peer.requests[0].headers['content-length'],String(Buffer.byteLength(before.body)));assert.equal(f.read().acceptedThrough,1);assert.equal(f.worker.status().inFlight,0);assert.equal(f.store.findAgentWriter(f.run.sessionId,{owner:f.owner}).reserved,true);await until(()=>peer.counts().connections===0);
});
test('actual TLS signing preserves supported Unicode projection bytes and original event IDs',enabled,async t=>{
 const peer=await receiver(t),batch=readyRecords();batch.sessions[0].region='雪'.repeat(64);batch.sessions[0].version='界'.repeat(256);batch.bindings[0].defaults.region=batch.sessions[0].region;const f=await fixture(t,peer,{batch}),before=f.read().deliveries[0];assert.ok(Buffer.byteLength(before.body)>before.body.length);await f.deliver();assert.equal(peer.requests[0].body.toString('utf8'),before.body);assert.equal(peer.requests[0].eventId,before.eventId);assert.equal(peer.requests[0].event.event.region,batch.sessions[0].region);assert.ok(peer.requests[0].body.length<=4096);
});
test('observer abort after actual request finish retains capacity and requested journal until the real response settles',enabled,async t=>{
 const entered=deferred(),answer=deferred(),peer=await receiver(t,async row=>{entered.resolve();await answer.promise;acknowledge(row.res,row.eventId,row.bodySha256);}),f=await fixture(t,peer,{workerOptions:{maxConcurrent:1}}),controller=new AbortController(),pending=f.deliver({signal:controller.signal}),rejected=assert.rejects(pending,code('AGENT_WEBHOOK_ABORTED'));
 try{await entered.promise;controller.abort(Error('private observer reason'));await rejected;assert.equal(f.worker.status().inFlight,1);assert.equal(f.read().deliveries[0].lastOutcome,'requested');const other=f.store.subscribeAgentWebhook(f.run.agentRunId,f.run.tenant,{endpointId:'awh_'+uuid(2),after:0},{owner:f.owner});await assert.rejects(f.worker.deliver(other.subscriptionId),code('AGENT_WEBHOOK_CAPACITY'));await assert.rejects(f.deliver(),code('AGENT_WEBHOOK_IN_FLIGHT'));assert.throws(()=>f.store.releaseAgentController(f.owner),code('STATE_WEBHOOK_IN_FLIGHT'));}finally{answer.resolve();}
 await until(()=>f.worker.status().inFlight===0);assert.equal(f.read().acceptedThrough,1);assert.equal(peer.requests.length,1);
});
test('original DNS callback remains owned after deadline socket destruction and close observation cancellation',enabled,async t=>{
 const gate=gatedLookup(),peer=await receiver(t),f=await fixture(t,peer,{workerOptions:{url:peer.localhostUrl,lookup:gate.fn,timeoutMs:50,maxConcurrent:1}}),pending=f.deliver();
 try{await gate.entered;await delay(90);assert.equal(f.worker.status().inFlight,1);assert.equal(f.read().deliveries[0].lastOutcome,'requested');assert.throws(()=>f.store.releaseAgentController(f.owner),code('STATE_WEBHOOK_IN_FLIGHT'));await assert.rejects(f.worker.close({signal:AbortSignal.timeout(20)}),code('AGENT_WEBHOOK_ABORTED'));assert.equal(f.worker.status().inFlight,1);assert.equal(peer.requests.length,0);}finally{gate.release();}
 assert.equal((await pending).status,'interrupted');await f.worker.close();assert.equal(f.worker.status().inFlight,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');assert.equal(f.read().deliveries[0].attempts,1);assert.equal(peer.requests.length,0);
});
test('a throwing lower-level resolver cannot declare its already started callback work settled',enabled,async t=>{
 const gate=gatedLookup(),peer=await receiver(t),f=await fixture(t,peer,{workerOptions:{url:peer.localhostUrl,lookup(host,opts,callback){gate.fn(host,opts,callback);throw Error('private resolver failure');},timeoutMs:50}}),pending=f.deliver();
 try{await gate.entered;await delay(70);assert.equal(f.worker.status().inFlight,1);await assert.rejects(f.worker.close({signal:AbortSignal.timeout(20)}),code('AGENT_WEBHOOK_ABORTED'));assert.equal(f.read().deliveries[0].lastOutcome,'requested');}finally{gate.release();}
 assert.equal((await pending).status,'interrupted');await f.worker.close();assert.equal(peer.requests.length,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');
});
test('a mistaken returned rejected native lookup Promise is observed without retiring original callback ownership',enabled,async t=>{
 const gate=gatedLookup(),unhandled=[],listener=e=>unhandled.push(e),peer=await receiver(t),f=await fixture(t,peer,{workerOptions:{url:peer.localhostUrl,lookup(host,opts,callback){gate.fn(host,opts,callback);return Promise.reject(Error('private returned lookup Promise'));},timeoutMs:50}}),pending=f.deliver();process.on('unhandledRejection',listener);
 try{await gate.entered;await delay(70);assert.deepEqual(unhandled,[]);assert.equal(f.worker.status().inFlight,1);await assert.rejects(f.worker.close({signal:AbortSignal.timeout(20)}),code('AGENT_WEBHOOK_ABORTED'));}finally{process.off('unhandledRejection',listener);gate.release();}
 await pending;await f.worker.close();assert.equal(peer.requests.length,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');
});
test('finite real HTTPS retries preserve one original event body and delivery identity until its third accepted attempt',enabled,async t=>{
 let calls=0;const peer=await receiver(t,row=>{if(++calls<3){row.res.writeHead(503);row.res.end();}else acknowledge(row.res,row.eventId,row.bodySha256);}),f=await fixture(t,peer),before=f.read().deliveries[0],agent=f.store.agentHead({owner:f.owner}),result=await f.deliver();assert.equal(result.status,'accepted');assert.equal(result.attempts,3);assert.equal(result.deliveryId,before.deliveryId);assert.equal(peer.requests.length,3);assert.deepEqual(new Set(peer.requests.map(r=>r.eventId)),new Set([before.eventId]));assert.ok(peer.requests.every(r=>r.body.toString('utf8')===before.body&&r.bodySha256===before.bodySha256));assert.deepEqual(f.store.agentHead({owner:f.owner}),agent);assert.equal(f.read().acceptedThrough,1);
});
test('redirect responses never send the signed body to another actual HTTPS server and exhaust only the original head',enabled,async t=>{
 const target=await receiver(t),peer=await receiver(t,({res})=>{res.writeHead(302,{location:target.url});res.end();}),f=await fixture(t,peer),result=await f.deliver();assert.equal(result.status,'exhausted');assert.equal(result.attempts,8);assert.equal(peer.requests.length,8);assert.equal(target.requests.length,0);assert.equal(f.read().acceptedThrough,0);assert.equal(f.read().deliveries[0].lastOutcome,'not-accepted');await f.deliver();assert.equal(peer.requests.length,8);
});
test('wrong identity invalid UTF8 oversized or truncated complete-response claims never become receiver acceptance',enabled,async t=>{
 for(const mode of ['wrong-id','utf8','oversized','truncated']){
  const peer=await receiver(t,row=>{row.res.writeHead(202,{'content-type':'application/json',...(mode==='truncated'?{'content-length':'500'}:{})});if(mode==='wrong-id')row.res.end(JSON.stringify({schema:'agent-webhook-ack-v1',eventId:'aevt_'+uuid(999),bodySha256:row.bodySha256}));if(mode==='utf8')row.res.end(Buffer.from([0xff]));if(mode==='oversized')row.res.end('x'.repeat(1025));if(mode==='truncated')row.res.end('{}');}),f=await fixture(t,peer),result=await f.deliver();assert.equal(result.status,'exhausted',mode);assert.equal(result.attempts,8);assert.equal(peer.requests.length,8);assert.equal(f.read().acceptedThrough,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');assert.equal(f.store.findAgentWriter(f.run.sessionId,{owner:f.owner}).reserved,true);
 }
});
test('actual response header byte count sentinel header count and duplicate fields are bounded before ACK acceptance',enabled,async t=>{
 for(const mode of ['bytes','count','duplicate']){
  const peer=await receiver(t,row=>{if(mode==='bytes')row.res.setHeader('x-padding','x'.repeat(9000));if(mode==='count')for(let n=0;n<40;n++)row.res.setHeader('x-header-'+n,'ok');if(mode==='duplicate'){row.res.writeHead(202,{'content-type':['application/json','application/json']});row.res.end(JSON.stringify({schema:'agent-webhook-ack-v1',eventId:row.eventId,bodySha256:row.bodySha256}));}else acknowledge(row.res,row.eventId,row.bodySha256);}),f=await fixture(t,peer);assert.equal((await f.deliver()).status,'exhausted',mode);assert.equal(f.read().acceptedThrough,0);assert.equal(peer.requests.length,8);await until(()=>peer.counts().connections===0);
 }
});
test('informational response floods close the original connection instead of keeping unbounded response state',enabled,async t=>{
 const peer=await receiver(t,row=>{for(let n=0;n<5;n++)row.res.writeProcessing();acknowledge(row.res,row.eventId,row.bodySha256);}),f=await fixture(t,peer);assert.equal((await f.deliver()).status,'exhausted');assert.equal(peer.requests.length,8);assert.equal(f.read().acceptedThrough,0);assert.equal(f.worker.status().inFlight,0);await until(()=>peer.counts().connections===0);
});
test('TLS certificate trust stays enabled even when the surrounding process requests disabled default verification',enabled,async t=>{
 const previous=process.env.NODE_TLS_REJECT_UNAUTHORIZED,peer=await receiver(t);process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
 try{const f=await fixture(t,peer);await f.worker.close();const {ca,...withoutCA}=f.options;const untrusted=createAgentWebhookDispatcher({...withoutCA,store:f.store,owner:f.owner});try{assert.equal((await untrusted.deliver(f.sub.subscriptionId)).status,'exhausted');assert.equal(peer.requests.length,0);assert.equal(f.read().acceptedThrough,0);await until(()=>peer.counts().tlsErrors>0);}finally{await untrusted.close();}}finally{if(previous===undefined)delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;else process.env.NODE_TLS_REJECT_UNAUTHORIZED=previous;}
});
test('TLS hostname identity is verified against the configured URL despite a trusted custom localhost resolver',enabled,async t=>{
 const peer=await receiver(t),url=new URL(peer.url);url.hostname='mismatch.invalid';const f=await fixture(t,peer,{workerOptions:{url:url.href,lookup(_host,opts,callback){return lookup('localhost',{...opts,family:4},callback);}}});assert.equal((await f.deliver()).status,'exhausted');assert.equal(peer.requests.length,0);assert.equal(f.read().acceptedThrough,0);await until(()=>peer.counts().tlsErrors>0);
});
test('absolute per-attempt deadline destroys stalled actual responses and settles all original TCP resources before capacity returns',enabled,async t=>{
 const peer=await receiver(t,({res})=>{res.writeHead(202,{'content-type':'application/json'});res.write('{');}),f=await fixture(t,peer,{workerOptions:{timeoutMs:75}}),result=await f.deliver();assert.equal(result.status,'exhausted');assert.equal(result.attempts,8);assert.equal(peer.requests.length,8);assert.equal(f.worker.status().inFlight,0);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');assert.equal(f.read().acceptedThrough,0);await until(()=>peer.counts().connections===0);
 const latePeer=await receiver(t),late=await fixture(t,latePeer,{workerOptions:{timeoutMs:50}}),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);if(sql.startsWith('UPDATE agent_webhook_deliveries SET attempts='))return {run(...args){const result=statement.run(...args);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,70);return result;}};return statement;};
 try{assert.equal((await late.deliver()).status,'exhausted');assert.equal(latePeer.requests.length,0);assert.equal(latePeer.counts().connected,0);assert.equal(late.read().deliveries[0].attempts,8);}finally{DatabaseSync.prototype.prepare=prepare;}
});
test('failed ACK persistence after actual acceptance retains its exact settled attempt and close waits for explicit reconciliation',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer),prepare=DatabaseSync.prototype.prepare;let failed=false;
 DatabaseSync.prototype.prepare=function(sql){if(!failed&&sql.startsWith('UPDATE agent_webhooks SET accepted_through')){failed=true;return {run(){throw Error('controlled real ACK write failure');}};}return prepare.call(this,sql);};
 try{await assert.rejects(f.deliver(),code('AGENT_WEBHOOK_STATE_UNCONFIRMED'));assert.equal(f.worker.status().inFlight,1);assert.equal(f.worker.status().faulted,true);assert.equal(f.read().deliveries[0].lastOutcome,'requested');assert.equal(peer.requests.length,1);await until(()=>peer.counts().connections===0);await assert.rejects(f.worker.close({signal:AbortSignal.timeout(20)}),code('AGENT_WEBHOOK_ABORTED'));assert.throws(()=>f.store.releaseAgentController(f.owner),code('STATE_WEBHOOK_IN_FLIGHT'));}finally{DatabaseSync.prototype.prepare=prepare;}
 assert.equal(f.worker.reconcile(f.sub.subscriptionId).reconciled,true);await f.worker.close();assert.equal(f.read().acceptedThrough,1);assert.equal(f.worker.status().inFlight,0);assert.equal(peer.requests.length,1);
});
test('a commit-success then thrown ACK result reconciles through the bounded duplicate receipt without another HTTPS send',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let armed=false,failed=false;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE agent_webhooks SET accepted_through'))armed=true;return prepare.call(this,sql);};DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'&&armed&&!failed){failed=true;throw Error('controlled post-COMMIT ACK observer failure');}return result;};
 try{await assert.rejects(f.deliver(),code('AGENT_WEBHOOK_STATE_UNCONFIRMED'));assert.equal(f.read().acceptedThrough,1);assert.equal(f.worker.status().inFlight,1);assert.equal(peer.requests.length,1);}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
 assert.equal(f.worker.reconcile(f.sub.subscriptionId).capture.acceptedThrough,1);assert.equal(f.worker.status().inFlight,0);assert.equal(peer.requests.length,1);
});
test('an uncertain committed begin cannot send blindly or refund an attempt and is reconciled as unknown before retry',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer),prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec;let armed=false,failed=false;
 DatabaseSync.prototype.prepare=function(sql){if(sql.startsWith('UPDATE agent_webhook_deliveries SET attempts='))armed=true;return prepare.call(this,sql);};DatabaseSync.prototype.exec=function(sql){const result=exec.call(this,sql);if(sql==='COMMIT'&&armed&&!failed){failed=true;throw Error('controlled post-COMMIT begin observer failure');}return result;};
 try{await assert.rejects(f.deliver(),code('AGENT_WEBHOOK_STATE_UNCONFIRMED'));assert.equal(peer.requests.length,0);assert.equal(f.read().deliveries[0].attempts,1);assert.equal(f.read().deliveries[0].lastOutcome,'requested');await assert.rejects(f.deliver(),code('AGENT_WEBHOOK_STATE_UNCONFIRMED'));}finally{DatabaseSync.prototype.prepare=prepare;DatabaseSync.prototype.exec=exec;}
 f.worker.reconcile(f.sub.subscriptionId);assert.equal(f.read().deliveries[0].lastOutcome,'unknown');const result=await f.deliver();assert.equal(result.attempts,2);assert.equal(result.status,'accepted');assert.equal(peer.requests.length,1);
});
test('executor Source end runs independently while its original webhook DNS work still holds the shared ledger owner',enabled,async t=>{
 const gate=gatedLookup(),peer=await receiver(t),h=await executorFixture(t,{storeOptions:{enableAgentWebhooks:true}}),a=await h.active(),worker=h.executor.createWebhookDispatcher({...config(peer),tenantId:h.runRef(a.run).tenantId,url:peer.localhostUrl,lookup:gate.fn}),sub=worker.subscribe({agentRunId:a.run.agentRunId,after:0}),pending=worker.deliver(sub.subscriptionId);
 try{await gate.entered;const observation=await h.executor.shutdown({timeoutMs:50});assert.equal(observation.status,'unconfirmed');assert.equal(observation.pending,true);assert.ok(h.calls.some(c=>c.command.op==='end'));assert.equal(h.executor.getRun(h.runRef(a.run)).state,'closed');assert.equal(h.executor.status().ending,0);assert.equal(h.executor.status().ownerHeld,true);assert.equal(worker.read(sub.subscriptionId).deliveries[0].lastOutcome,'requested');assert.equal(worker.status().inFlight,1);assert.equal(peer.requests.length,0);}finally{gate.release();}
 assert.equal((await pending).status,'interrupted');assert.equal((await h.executor.shutdown({timeoutMs:200})).status,'closed');assert.equal(h.executor.status().ownerHeld,false);assert.equal(worker.status().inFlight,0);
});
test('executor endpoint factories reject duplicates and bound owned workers while allowing a fully closed configuration to be replaced',enabled,async t=>{
 const peer=await receiver(t),h=await executorFixture(t,{storeOptions:{enableAgentWebhooks:true}}),base={...config(peer),tenantId:'tenant-executor'},workers=[];for(let n=1;n<=4;n++)workers.push(h.executor.createWebhookDispatcher({...base,endpointId:'awh_'+uuid(n)}));assert.throws(()=>h.executor.createWebhookDispatcher(base),code('AGENT_EXECUTOR_BUSY'));assert.throws(()=>h.executor.createWebhookDispatcher({...base,endpointId:'awh_'+uuid(5)}),code('AGENT_EXECUTOR_CAPACITY'));await workers[0].close();workers.push(h.executor.createWebhookDispatcher({...base,endpointId:'awh_'+uuid(5)}));assert.equal((await h.executor.shutdown({timeoutMs:200})).status,'closed');assert.ok(workers.every(w=>w.status().closed&&w.status().inFlight===0));assert.throws(()=>h.executor.createWebhookDispatcher(base),code('AGENT_EXECUTOR_CLOSED'));assert.equal(peer.requests.length,0);
});
test('private endpoint configuration rejects accessors proxies insecure URLs null limits and caller-controlled TLS bypass options',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer);let getters=0;const base={...f.options,store:f.store,owner:f.owner},accessor=Object.defineProperty({...base},'url',{get(){getters++;return peer.url;},enumerable:true});for(const value of [accessor,new Proxy(base,{}),{...base,url:'http://private.invalid/secret'},{...base,url:'https://user:private@localhost/'},{...base,url:peer.url+'#private'},{...base,maxConcurrent:null},{...base,timeoutMs:1},{...base,retryBaseMs:0},{...base,rejectUnauthorized:false},{...base,lookup:async()=>{}}]){assert.throws(()=>createAgentWebhookDispatcher(value),e=>e.code==='AGENT_WEBHOOK_INVALID'&&!String(e).includes('private'));}assert.equal(getters,0);assert.equal(peer.requests.length,0);assert.equal(f.read().deliveries[0].attempts,0);
});
test('captured endpoint URL and key bytes cannot be changed through caller mutation or per-delivery redirect options',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer);await assert.rejects(f.deliver({url:'https://private.invalid/'}),code('AGENT_WEBHOOK_INVALID'));f.options.url='https://127.0.0.1:1/private';f.options.keys[0].secret.fill(0);assert.equal((await f.deliver()).status,'accepted');assert.equal(peer.requests.length,1);assert.equal(f.read().acceptedThrough,1);
});
test('fixed endpoint and tenant binding reject another captured subscription before any actual attempt or HTTPS request',enabled,async t=>{
 const peer=await receiver(t),f=await fixture(t,peer),other=f.store.subscribeAgentWebhook(f.run.agentRunId,f.run.tenant,{endpointId:'awh_'+uuid(2),after:0},{owner:f.owner});await assert.rejects(f.worker.deliver(other.subscriptionId),code('AGENT_WEBHOOK_REFERENCE'));assert.equal(f.store.readAgentWebhookCapture(other.subscriptionId,f.run.tenant,{}, {owner:f.owner}).deliveries[0].attempts,0);const foreign=createAgentWebhookDispatcher({...f.options,tenantId:'other',store:f.store,owner:f.owner});try{await assert.rejects(foreign.deliver(f.sub.subscriptionId),code('AGENT_WEBHOOK_STATE_UNAVAILABLE'));}finally{await foreign.close();}assert.equal(peer.requests.length,0);
});
test('close during actual retry backoff cancels only that owned schedule and cannot dispatch a later attempt',enabled,async t=>{
 const entered=deferred(),peer=await receiver(t,({res})=>{res.writeHead(503);res.end();entered.resolve();}),f=await fixture(t,peer,{workerOptions:{retryBaseMs:100}}),pending=f.deliver();await entered.promise;await until(()=>f.read().deliveries[0].lastOutcome==='not-accepted');await f.worker.close();assert.equal((await pending).status,'interrupted');await delay(150);assert.equal(peer.requests.length,1);assert.equal(f.read().deliveries[0].attempts,1);assert.equal(f.worker.status().inFlight,0);
});
test('default private asynchronous resolver joins real A and AAAA DNS callbacks before the authenticated localhost TLS request',enabled,async t=>{
 const dns=await dnsReceiver(t),peer=await receiver(t),f=await fixture(t,peer,{workerOptions:{url:peer.localhostUrl,dnsServers:[dns.server]}});assert.equal((await f.deliver()).status,'accepted');assert.equal(peer.requests.length,1);assert.equal(dns.queries.length,2);assert.equal(f.read().acceptedThrough,1);assert.equal(f.worker.status().inFlight,0);
});
test('actual private DNS queries do not block Source end and native resolver cancellation must retire before ledger ownership returns',enabled,async t=>{
 const dns=await dnsReceiver(t,{hold:true}),peer=await receiver(t),h=await executorFixture(t,{storeOptions:{enableAgentWebhooks:true}}),a=await h.active(),worker=h.executor.createWebhookDispatcher({...config(peer),tenantId:'tenant-executor',url:peer.localhostUrl,dnsServers:[dns.server]}),sub=worker.subscribe({agentRunId:a.run.agentRunId,after:0}),pending=worker.deliver(sub.subscriptionId);await until(()=>dns.queries.length===2);h.executor.end(h.runRef(a.run));await until(()=>h.executor.getRun(h.runRef(a.run)).state==='closed');assert.ok(h.calls.some(c=>c.command.op==='end'));assert.equal(worker.status().inFlight,1);assert.equal(worker.read(sub.subscriptionId).deliveries[0].lastOutcome,'requested');await worker.close();assert.equal((await pending).status,'interrupted');assert.equal(worker.status().inFlight,0);assert.equal(worker.read(sub.subscriptionId).deliveries[0].lastOutcome,'unknown');dns.respond();await delay(30);assert.equal(peer.requests.length,0);assert.equal((await h.executor.shutdown({timeoutMs:200})).status,'closed');
});
