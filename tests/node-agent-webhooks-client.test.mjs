import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentClient,AgentClientError} from '../sdk/agent.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {uuid,agentRunId,sessionId} from './fixtures/node-agent-sdk-records.mjs';
import {until,deferred} from './fixtures/agent-executor-fixture.mjs';
import {webhookSdkFixture,key} from './fixtures/agent-webhook-sdk-http.mjs';
const endpointId='awh_'+uuid(1),subscriptionId='awsub_'+uuid(2),cursor=(n,run=agentRunId)=>'aec1.'+run+'.'+n;
const input={endpointId,after:cursor(0)};
const value=(extra={})=>({schema:'agent-webhook-subscription-v1',subscriptionId,agentRunId,sessionId,endpointId,after:cursor(0),acceptedThrough:cursor(1),queuedThrough:cursor(3),observedLatest:cursor(3),pending:2,reconciliationRequired:false,missingFrom:null,missingThrough:null,head:{eventId:'aevt_'+uuid(4),sequence:2,attempts:0,lastOutcome:null,cursor:cursor(2)},...extra});
const endpoints=(rows=[{endpointId,available:true}])=>({schema:'agent-webhook-endpoints-v1',agentRunId,endpoints:rows});
const response=(data,{status=200,location,headers={}}={})=>new Response(JSON.stringify({data,requestId:'req_webhook_sdk'}),{status,headers:{'content-type':'application/json','x-request-id':'req_webhook_sdk',...(location?{location}:{}),...headers}});
const client=(fetch,extra={})=>new AgentClient({baseUrl:'https://fixture.test',apiKey:key,fetch,...extra});
const expected=code=>e=>e instanceof AgentClientError&&e.code===code;
const subResponse=v=>response(v,{location:'/v1/agent-runs/'+agentRunId+'/webhook-subscriptions/'+v.subscriptionId});

test('Webhook SDK endpoint discovery returns frozen fixed profiles without secrets',async()=>{
 const calls=[],c=client(async(url,options)=>{calls.push({url,options});return response(endpoints());}),r=await c.runs.webhookEndpoints(agentRunId);
 assert.equal(r.data.endpoints[0].available,true);assert.ok(Object.isFrozen(r.data.endpoints[0]));assert.ok(Object.isFrozen(r.data.endpoints));assert.equal(calls[0].url,'https://fixture.test/v1/agent-runs/'+agentRunId+'/webhook-endpoints');assert.equal(calls[0].options.body,undefined);
 assert.deepEqual((await client(async()=>response(endpoints([]))).runs.webhookEndpoints(agentRunId)).data.endpoints,[]);
});
test('Webhook SDK captures exact endpoint and original cursor before dispatch without getters or proxy traps',()=>{
 let calls=0;const c=client(()=>{calls++;throw Error('unexpected');});
 for(const after of [cursor('1'.repeat(100000)),cursor(0)+'\n',cursor('00'),cursor('-1'),cursor('9007199254740992'),cursor(0,'arun_'+uuid(99)),null,0])assert.throws(()=>c.runs.subscribeWebhook(agentRunId,{endpointId,after}),expected('CLIENT_INVALID_REQUEST'));
 for(const v of [{...input,url:'https://private'}, {...input,endpointId:endpointId+'\n'},Object.defineProperty({after:cursor(0)},'endpointId',{get(){throw Error('getter');}}),new Proxy(input,{getPrototypeOf(){throw Error('trap');}})])assert.throws(()=>c.runs.subscribeWebhook(agentRunId,v),expected('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>c.runs.webhookEndpoints(agentRunId+'\n'),expected('CLIENT_INVALID_REQUEST'));assert.throws(()=>c.runs.webhookSubscription(agentRunId,subscriptionId+'\n'),expected('CLIENT_INVALID_REQUEST'));assert.throws(()=>c.runs.subscribeWebhook(agentRunId,input,{idempotencyKey:'unused'}),expected('CLIENT_INVALID_REQUEST'));assert.equal(calls,0);
});
test('Webhook SDK subscribe retries identical captured body with no separate idempotency key',async()=>{
 const calls=[],mutable={...input};let first=true;
 const c=client(async(url,options)=>{calls.push({url,body:options.body,headers:options.headers});if(first){first=false;mutable.after=cursor(9);throw Error('lost reply');}return subResponse(value());},{retries:1});
 const r=await c.runs.subscribeWebhook(agentRunId,mutable);assert.equal(r.data.subscriptionId,subscriptionId);assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.deepEqual(JSON.parse(calls[0].body),input);assert.equal(calls[0].headers['idempotency-key'],undefined);assert.ok(Object.isFrozen(r.data.head));
});
test('Webhook SDK preserves accepted ranges, exhausted heads and explicit gaps after the prefix drains',async()=>{
 for(const v of [value(),value({head:{...value().head,attempts:8,lastOutcome:'unknown'}}),value({observedLatest:cursor(8),reconciliationRequired:true,missingFrom:cursor(4),missingThrough:cursor(8)}),value({after:cursor(3),acceptedThrough:cursor(3),queuedThrough:cursor(3),pending:0,head:null}),value({acceptedThrough:cursor(3),pending:0,head:null,observedLatest:cursor(8),reconciliationRequired:true,missingFrom:cursor(4),missingThrough:cursor(8)})]){
  const r=await client(async()=>response(v)).runs.webhookSubscription(agentRunId,subscriptionId);assert.deepEqual(r.data,v);
 }
});
test('Webhook SDK rejects corrupt cursor ranges, head attempts and invented delivery evidence',async()=>{
 const patches=[v=>v.pending++,v=>v.after=cursor(2),v=>v.acceptedThrough=cursor(4),v=>v.observedLatest=cursor(2),v=>v.queuedThrough=cursor(4),v=>v.pending=true,v=>v.reconciliationRequired=1,v=>v.head=null,v=>v.head.sequence++,v=>v.head.cursor=cursor(3),v=>v.head.attempts=9,v=>v.head.lastOutcome='accepted',v=>v.head.attempts=1,v=>v.head.eventId+='\n',v=>v.missingFrom=cursor(4),v=>v.after+='\n',v=>v.acceptedThrough=cursor(1,'arun_'+uuid(99)),v=>v.privateSignature='secret',v=>v.head.privateBody='secret',v=>v.sessionId+='\n'];
 for(const patch of patches){const v=value();patch(v);await assert.rejects(client(async()=>response(v)).runs.webhookSubscription(agentRunId,subscriptionId),expected('CLIENT_INVALID_RESPONSE'));}
 for(const patch of [v=>v.missingFrom=cursor(3),v=>v.missingThrough=cursor(7),v=>v.reconciliationRequired=false]){const v=value({observedLatest:cursor(8),reconciliationRequired:true,missingFrom:cursor(4),missingThrough:cursor(8)});patch(v);await assert.rejects(client(async()=>response(v)).runs.webhookSubscription(agentRunId,subscriptionId),expected('CLIENT_INVALID_RESPONSE'));}
});
test('Webhook SDK rejects duplicate, unordered, oversized or secret-bearing endpoint lists',async()=>{
 for(const v of [endpoints([{endpointId,available:1}]),endpoints([{endpointId,available:true,secret:'private'}]),endpoints([{endpointId,available:true},{endpointId,available:false}]),endpoints([{endpointId:'awh_'+uuid(9),available:true},{endpointId,available:true}]),endpoints(Array.from({length:5},(_,i)=>({endpointId:'awh_'+uuid(i),available:true}))),{...endpoints(),agentRunId:'arun_'+uuid(99)}])await assert.rejects(client(async()=>response(v)).runs.webhookEndpoints(agentRunId),expected('CLIENT_INVALID_RESPONSE'));
});
test('Webhook SDK response identity, status, Location and request ID are bound to the original request',async()=>{
 for(const v of [value({after:cursor(1)}),value({endpointId:'awh_'+uuid(99)}),value({agentRunId:'arun_'+uuid(99)})])await assert.rejects(client(async()=>subResponse(v)).runs.subscribeWebhook(agentRunId,input),expected('CLIENT_INVALID_RESPONSE'));
 for(const opts of [{},{location:'/wrong'},{status:202,location:'/v1/agent-runs/'+agentRunId+'/webhook-subscriptions/'+subscriptionId},{headers:{'x-request-id':'req_wrong'}}])await assert.rejects(client(async()=>response(value(),opts)).runs.subscribeWebhook(agentRunId,input),expected('CLIENT_INVALID_RESPONSE'));
 await assert.rejects(client(async()=>response(value({subscriptionId:'awsub_'+uuid(99)}))).runs.webhookSubscription(agentRunId,subscriptionId),expected('CLIENT_INVALID_RESPONSE'));
});
test('Webhook SDK exposes stable service errors and preserves uncertain write outcomes',async()=>{
 for(const [status,code,outcome] of [[404,'AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND','not-dispatched'],[409,'AGENT_WEBHOOK_HISTORY_UNAVAILABLE','not-dispatched'],[429,'AGENT_WEBHOOK_CAPACITY','not-dispatched'],[503,'AGENT_STORAGE_UNAVAILABLE','unknown']]){
  const c=client(async()=>new Response(JSON.stringify({error:{code,message:'failure',outcome},requestId:'req_webhook_sdk'}),{status,headers:{'content-type':'application/json','x-request-id':'req_webhook_sdk'}}));await assert.rejects(c.runs.subscribeWebhook(agentRunId,input),e=>expected(code)(e)&&e.outcome===outcome&&e.status===status);
 }
});
test('Webhook SDK ordinary capacity remains reserved until an aborted original request actually settles',async()=>{
 const entered=deferred(),gate=deferred(),controller=new AbortController();let calls=0;
 const c=client(async()=>{calls++;entered.resolve();await gate.promise;return response(endpoints());},{maxConcurrentRequests:1});
 const pending=c.runs.webhookEndpoints(agentRunId,{signal:controller.signal});await entered.promise;controller.abort();await assert.rejects(pending,expected('CLIENT_ABORTED'));
 try{await assert.rejects(c.runs.subscribeWebhook(agentRunId,input),expected('CLIENT_CAPACITY'));assert.equal(calls,1);}finally{gate.resolve();await until(()=>c.transportStatus().ordinary===0);}
});
test('Webhook SDK actual HTTP and SQLite delivery reaches the durable TLS inbox and resumes after Source end',{skip:!sessionStoreSupported},async t=>{
 const h=await webhookSdkFixture(t),c=new AgentClient({baseUrl:h.baseUrl,apiKey:h.key}),run=h.run.agentRunId,after=cursor(0,run);
 assert.equal((await c.runs.webhookEndpoints(run)).data.endpoints[0].endpointId,h.endpointId);
 const s=(await c.runs.subscribeWebhook(run,{endpointId:h.endpointId,after})).data;assert.equal((await c.runs.subscribeWebhook(run,{endpointId:h.endpointId,after})).data.subscriptionId,s.subscriptionId);
 await until(async()=>(await c.runs.webhookSubscription(run,s.subscriptionId)).data.acceptedThrough===cursor(3,run));await h.invocation(h.perform(h.run,h.context,'node-webhook-sdk-action'));
 await until(async()=>(await c.runs.webhookSubscription(run,s.subscriptionId)).data.acceptedThrough===cursor(6,run));await c.runs.end(run);
 await until(async()=>(await c.runs.get(run)).data.state==='closed');const latest=(await c.runs.eventPage(run)).data.latestCursor;await until(async()=>(await c.runs.webhookSubscription(run,s.subscriptionId)).data.acceptedThrough===latest);assert.equal(h.effects.length,1);assert.equal(h.worker.list().subscriptions.length,1);assert.equal(h.receiver.read().events[0].envelope.event.sequence,1);
});
test('Webhook SDK actual lost committed reply retries the original subscription without duplicate receiver entries',{skip:!sessionStoreSupported},async t=>{
 const h=await webhookSdkFixture(t);let first=true;const c=new AgentClient({baseUrl:h.baseUrl,apiKey:h.key,retries:1,fetch:async(...args)=>{const r=await fetch(...args);if(first){first=false;await r.arrayBuffer();throw Error('owned lost committed reply');}return r;}}),run=h.run.agentRunId;
 const s=(await c.runs.subscribeWebhook(run,{endpointId:h.endpointId,after:cursor(0,run)})).data;await until(async()=>(await c.runs.webhookSubscription(run,s.subscriptionId)).data.acceptedThrough===cursor(3,run));assert.equal(h.worker.list().subscriptions.length,1);assert.deepEqual(h.receiver.read().events.map(x=>x.envelope.event.sequence),[1,2,3]);
});
test('Webhook SDK actual distinct scopes, tenant isolation and immutable start cursor remain typed errors',{skip:!sessionStoreSupported},async t=>{
 const h=await webhookSdkFixture(t),make=apiKey=>new AgentClient({baseUrl:h.baseUrl,apiKey}),run=h.run.agentRunId,body={endpointId:h.endpointId,after:cursor(0,run)},reader=make(h.readKey),other=make(h.otherKey),c=make(h.key);
 assert.equal((await reader.runs.webhookEndpoints(run)).data.endpoints.length,1);await assert.rejects(reader.runs.subscribeWebhook(run,body),expected('FORBIDDEN'));await assert.rejects(other.runs.webhookEndpoints(run),expected('AGENT_RUN_NOT_FOUND'));
 const s=(await c.runs.subscribeWebhook(run,body)).data;await assert.rejects(c.runs.subscribeWebhook(run,{...body,after:cursor(1,run)}),expected('AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT'));assert.equal((await reader.runs.webhookSubscription(run,s.subscriptionId)).data.after,body.after);
});
