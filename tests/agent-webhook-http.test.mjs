import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {request,ServerResponse} from 'node:http';
import {lookup} from 'node:dns';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {DurableAgentExecutor} from '../service/agent-executor.mjs';
import {agentHttpRoute} from '../service/agent-http.mjs';
import {agentEventCursor} from '../service/agent-event-http.mjs';
import {createAgentWebhookReceiver} from '../service/agent-webhook-receiver.mjs';
import {SessionStoreError,sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,until,deferred,tenantId,actionKey} from './fixtures/agent-executor-fixture.mjs';
import {agentHttpClient,agentPaths} from './fixtures/agent-http-client.mjs';
import {authConfig,cert,endpointId,receiver} from './fixtures/agent-webhook-https.mjs';
import {uuid} from './fixtures/session-agent-records.mjs';
const enabled={skip:!sessionStoreSupported},token=n=>'fixture_webhook_api_'+n+'_0000000000000000000000000000';
const ALL=token('all'),READ=token('read'),WRITE=token('write'),AGENT=token('agent'),OTHER=token('other'),END=token('end'),SLOW=token('slow');
const scopes=['agents:webhooks:read','agents:webhooks:write'];
const credentials=[{apiKey:ALL,tenantId,scopes:[...scopes,'agents:read','agents:write','agents:end']},{apiKey:READ,tenantId,scopes:[scopes[0]]},{apiKey:WRITE,tenantId,scopes:[scopes[1]]},{apiKey:AGENT,tenantId,scopes:['agents:read','agents:write','agents:observe']},{apiKey:OTHER,tenantId:'tenant-other',scopes},{apiKey:END,tenantId,scopes:['agents:end']}];
const endpoints=run=>'/v1/agent-runs/'+run.agentRunId+'/webhook-endpoints';
const subscriptions=run=>'/v1/agent-runs/'+run.agentRunId+'/webhook-subscriptions';
const detail=(run,sub)=>subscriptions(run)+'/'+sub.subscriptionId;
const cursor=(run,n)=>agentEventCursor(run.agentRunId,n);
const error=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.body.error.code,code);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-request-id'],r.body.requestId);assert.doesNotMatch(JSON.stringify(r.body),/private-signature|private-backend|stack|keyHash|ownerKey/);};
async function harness(t,{durable=false,register=true,automatic=true,driverOptions={},http={},authenticate=createApiKeyAuthenticator(credentials),storeOptions={},disabled=false}={}){
 const f=await fixture(t,{storeOptions:{enableAgentWebhooks:true,...storeOptions}});let peer,prod;
 if(durable){const key=readFileSync(new URL('./fixtures/webhook-localhost-key.pem',import.meta.url));prod=createAgentWebhookReceiver({directory:join(f.directory,'receiver'),tenantId,...authConfig,key,cert});const a=await prod.listen();peer={url:'https://127.0.0.1:'+a.port+a.path,localhostUrl:'https://localhost:'+a.port+a.path};t.after(()=>prod.close());}else peer=await receiver(t);
 const config={tenantId,...authConfig,url:peer.url,ca:cert,pollIntervalMs:10,retryBaseMs:10,timeoutMs:2000,...driverOptions};
 if(driverOptions.useLocalhost){config.url=peer.localhostUrl;delete config.useLocalhost;}
 const registerEndpoint=(extra={},auto=automatic)=>{const v={...config,...extra};if(!auto)delete v.pollIntervalMs;return f.executor[auto?'registerWebhookEndpoint':'createWebhookDispatcher'](v);};let worker=register?registerEndpoint():null;
 const sockets=new Set(),server=createSessionControlServer({registry:f.registry,agentExecutor:disabled?null:f.executor,authenticate,...http});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port,api=agentHttpClient(base,ALL),client=key=>agentHttpClient(base,key);
 const raw=({method='GET',path,headers={},payload,setup}={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,method,path,headers:{authorization:'Bearer '+ALL,...headers},agent:false},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});res.on('error',reject);});req.on('error',reject);if(setup)setup(req);else req.end(payload);});
 const subscribe=(run,after=cursor(run,0),key=ALL,extra={})=>client(key)('POST',subscriptions(run),{data:{endpointId,after,...extra}});
 const status=(run,sub,key=ALL)=>client(key)('GET',detail(run,sub));
 return {...f,peer,prod,config,worker,registerEndpoint,server,base,api,client,raw,subscribe,status};
}
// This trusted test resolver always selects loopback. AI_ADDRCONFIG inherited
// from Node would reject localhost in an isolated Linux namespace with only lo.
function gateLookup(){const ready=deferred();let releaseCallback,released=false;return {ready:ready.promise,lookup(host,options,callback){lookup('localhost',{...options,family:4,hints:0},(...args)=>{releaseCallback=()=>callback(...args);ready.resolve();if(released)releaseCallback();});},release(){released=true;releaseCallback?.();}};}
function sanitized(value,peer){const raw=JSON.stringify(value);assert.equal(raw.includes(peer.url),false);assert.doesNotMatch(raw,/"(?:body|url|keys|secret|signature|deliveryId|attemptId|binding|tenant|ownerKey)"\s*:/);}

test('public Webhook routes use distinct read/write scopes and exact run/subscription IDs',()=>{
 const run={agentRunId:'arun_'+uuid(1)},sub={subscriptionId:'awsub_'+uuid(2)};
 assert.equal(agentHttpRoute(endpoints(run)).scope,scopes[0]);assert.equal(agentHttpRoute(subscriptions(run)).scope,scopes[1]);assert.equal(agentHttpRoute(detail(run,sub)).scope,scopes[0]);assert.equal(agentHttpRoute(endpoints(run)+'/'+sub.subscriptionId),null);assert.equal(agentHttpRoute(detail(run,sub)+'/body'),null);
});
test('authenticated subscribe automatically reaches the production durable receiver and later public Agent actions append original events',enabled,async t=>{
 const h=await harness(t,{durable:true}),{run,context}=await h.active(),listed=await h.api('GET',endpoints(run));assert.deepEqual(listed.body.data.endpoints,[{endpointId,available:true}]);
 const created=await h.subscribe(run);assert.equal(created.status,200);const sub=created.body.data;assert.equal(created.headers.location,detail(run,sub));assert.equal(sub.after,cursor(run,0));assert.equal(sub.schema,'agent-webhook-subscription-v1');sanitized(sub,h.peer);
 await until(async()=>((await h.status(run,sub)).body.data?.acceptedThrough===cursor(run,3)));
 const action=await h.api('POST',agentPaths.invocations(run.agentRunId),{data:{tool:'insertText',params:{text:'private-backend-action'},context},idempotencyKey:'public-webhook-event'});assert.equal(action.status,202);await h.invocation(action.body.data);
 await until(async()=>((await h.status(run,sub)).body.data?.acceptedThrough===cursor(run,6)));const first=h.prod.read(),last=h.prod.read({after:first.nextCursor});assert.deepEqual([...first.events,...last.events].map(x=>x.envelope.event.sequence),[1,2,3,4,5,6]);assert.equal(h.effects.length,1);assert.equal((await h.status(run,sub)).body.data.head,null);
});
test('losing the committed subscription HTTP reply preserves its ID and automatic delivery; retry is immutable and idempotent',enabled,async t=>{
 const h=await harness(t,{durable:true}),{run}=await h.active(),end=ServerResponse.prototype.end;let captured,armed=true;
 ServerResponse.prototype.end=function(body,...args){if(armed&&typeof body==='string'&&body.includes('agent-webhook-subscription-v1')){armed=false;captured=JSON.parse(body).data;this.destroy();return this;}return end.call(this,body,...args);};
 try{await assert.rejects(h.subscribe(run));}finally{ServerResponse.prototype.end=end;}
 assert.ok(captured);const retry=await h.subscribe(run);assert.equal(retry.status,200);assert.equal(retry.body.data.subscriptionId,captured.subscriptionId);await until(async()=>((await h.status(run,captured)).body.data?.acceptedThrough===cursor(run,3)));assert.equal(h.worker.list().subscriptions.length,1);assert.equal(h.prod.read().events.length,3);assert.equal(h.effects.length,0);
});
test('ordinary Agent permissions do not imply Webhook permissions and Webhook read/write are independent',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();error(await h.subscribe(run,cursor(run,0),READ),403,'FORBIDDEN');error(await h.client(WRITE)('GET',endpoints(run)),403,'FORBIDDEN');error(await h.subscribe(run,cursor(run,0),AGENT),403,'FORBIDDEN');error(await h.client(AGENT)('GET',endpoints(run)),403,'FORBIDDEN');
 const sub=(await h.subscribe(run,cursor(run,0),WRITE)).body.data;assert.equal((await h.status(run,sub,READ)).status,200);error(await h.status(run,sub,WRITE),403,'FORBIDDEN');assert.equal(h.executor.status().state,'active');
});
test('authentication, backend Origin and tenant authorization precede original cursor interpretation',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();error(await h.api('POST',subscriptions(run),{data:{endpointId,after:'wrong'},headers:{authorization:''}}),401,'UNAUTHENTICATED');error(await h.api('POST',subscriptions(run),{data:{endpointId,after:'wrong'},headers:{origin:'https://browser.example'}}),403,'MANAGEMENT_ORIGIN_FORBIDDEN');
 error(await h.subscribe(run,'wrong',OTHER),404,'AGENT_RUN_NOT_FOUND');error(await h.client(OTHER)('GET',endpoints(run)),404,'AGENT_RUN_NOT_FOUND');error(await h.subscribe(run,'wrong'),400,'AGENT_EVENT_CURSOR_INVALID');assert.equal(h.executor.status().state,'active');assert.equal(h.peer.requests.length,0);
});
test('tenant and exact run ownership protect subscription metadata; failed probes do not fence original execution',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active(),sub=(await h.subscribe(run)).body.data,session=await h.createSession('second-run');const other=h.executor.create({tenantId,sessionId:session.sessionId,region:session.region,version:session.version,idempotencyKey:'second-owned-run'});await until(()=>h.executor.getRun({tenantId,agentRunId:other.agentRunId}).state==='active');
 error(await h.status(run,sub,OTHER),404,'AGENT_RUN_NOT_FOUND');error(await h.status(other,sub),404,'AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND');for(let i=10;i<14;i++)error(await h.status(run,{subscriptionId:'awsub_'+uuid(i)}),404,'AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND');
 assert.equal(h.executor.status().state,'active');assert.equal((await h.status(run,sub)).status,200);assert.equal((await h.invocation(h.perform(run,context,'after-missing-probes'))).state,'injected');
});
test('only this tenant automatic profiles are discoverable or selectable; manual and unknown destinations remain private',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),manual='awh_'+uuid(2),foreign='awh_'+uuid(3);h.registerEndpoint({endpointId:manual},false);h.registerEndpoint({tenantId:'tenant-other',endpointId:foreign});
 assert.deepEqual((await h.api('GET',endpoints(run))).body.data.endpoints,[{endpointId,available:true}]);for(const id of [manual,foreign,'awh_'+uuid(9)])error(await h.subscribe(run,cursor(run,0),ALL,{endpointId:id}),404,'AGENT_WEBHOOK_ENDPOINT_NOT_FOUND');assert.equal(h.executor.status().state,'active');assert.equal(h.peer.requests.length,0);
});
test('public subscription cannot provision URLs, HMAC material, worker bounds or arbitrary private options',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();for(const extra of [{url:'https://private-backend.invalid/'},{keys:[]},{activeKeyId:'private-signature'},{maxConcurrent:8},{lookup:'caller-code'},{tenantId:'tenant-other'},{rpcTimeoutMs:120000}])error(await h.subscribe(run,cursor(run,0),ALL,extra),400,'AGENT_INVALID_REQUEST');assert.equal(h.worker.list().subscriptions.length,0);assert.equal(h.peer.requests.length,0);
});
test('subscription natural key preserves its original cursor and never rewinds acceptance on a conflicting retry',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),sub=(await h.subscribe(run)).body.data;await until(async()=>((await h.status(run,sub)).body.data?.acceptedThrough===cursor(run,3)));error(await h.subscribe(run,cursor(run,1)),409,'AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT');const retry=await h.subscribe(run);assert.equal(retry.body.data.subscriptionId,sub.subscriptionId);assert.equal(retry.body.data.after,cursor(run,0));assert.equal(retry.body.data.acceptedThrough,cursor(run,3));assert.equal(h.worker.list().subscriptions.length,1);assert.equal(h.executor.status().state,'active');
});
test('future, cross-run and malformed cursors are rejected without changing the run or fencing healthy storage',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();error(await h.subscribe(run,cursor(run,4)),409,'AGENT_WEBHOOK_HISTORY_UNAVAILABLE');for(const after of [0,null,'aec1.'+run.agentRunId+'.00','aec1.arun_'+uuid(9)+'.0'])error(await h.subscribe(run,after),400,'AGENT_EVENT_CURSOR_INVALID');assert.equal(h.worker.list().subscriptions.length,0);assert.equal(h.executor.status().state,'active');
});
test('an expired original history cannot be silently subscribed from zero or treated as a valid ACK cursor',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active();for(let i=0;i<22;i++)await h.invocation(h.perform(run,context,'old-history-'+i));error(await h.subscribe(run),409,'AGENT_WEBHOOK_HISTORY_UNAVAILABLE');assert.equal(h.worker.list().subscriptions.length,0);assert.equal(h.executor.status().state,'active');const sub=await h.subscribe(run,cursor(run,69));assert.equal(sub.status,200);assert.equal(sub.body.data.pending,0);assert.equal(sub.body.data.acceptedThrough,cursor(run,69));assert.equal(h.effects.length,22);
});
test('closed automatic endpoint stays observable and re-registration resumes the same persisted subscription',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),sub=(await h.subscribe(run,cursor(run,3))).body.data;await h.worker.close();assert.deepEqual((await h.api('GET',endpoints(run))).body.data.endpoints,[{endpointId,available:false}]);assert.equal((await h.status(run,sub)).status,200);error(await h.subscribe(run,cursor(run,3)),503,'AGENT_WEBHOOK_ENDPOINT_UNAVAILABLE');h.registerEndpoint();assert.equal((await h.subscribe(run,cursor(run,3))).body.data.subscriptionId,sub.subscriptionId);assert.equal((await h.status(run,sub)).body.data.acceptedThrough,cursor(run,3));
});
test('metadata reads preserve original webhook revision, cursor, Source calls and run writer reservation',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),sub=(await h.subscribe(run,cursor(run,3))).body.data;await h.worker.close();const before=h.worker.list(),calls=h.calls.length,runBefore=h.executor.getRun(h.runRef(run));for(let i=0;i<3;i++){const r=await h.status(run,sub);assert.equal(r.status,200);sanitized(r.body.data,h.peer);assert.equal((await h.api('GET',endpoints(run))).status,200);}assert.deepEqual(h.worker.list(),before);assert.equal(h.calls.length,calls);assert.deepEqual(h.executor.getRun(h.runRef(run)),runBefore);assert.equal(runBefore.holdsWriter,true);
});
test('ordinary subscription capacity and configuration errors are typed and do not fence the executor',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),original=h.store.subscribeAgentWebhook;try{for(const [privateCode,publicCode,status]of [['STATE_WEBHOOK_LIMIT','AGENT_WEBHOOK_CAPACITY',429],['STATE_WEBHOOK_DISABLED','AGENT_WEBHOOK_NOT_CONFIGURED',503]]){h.store.subscribeAgentWebhook=()=>{throw new SessionStoreError(privateCode,'private-backend detail');};error(await h.subscribe(run),status,publicCode);assert.equal(h.executor.status().state,'active');}}finally{h.store.subscribeAgentWebhook=original;}assert.equal((await h.subscribe(run,cursor(run,3))).status,200);
});
test('unconfirmed subscription commit reports unknown, fences new actions and never erases the already durable original subscription',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),original=h.store.subscribeAgentWebhook;h.store.subscribeAgentWebhook=function(...args){const row=original.apply(this,args);throw new SessionStoreError('STATE_IO_UNCONFIRMED','private-backend lost commit acknowledgement');};try{const r=await h.subscribe(run);error(r,503,'AGENT_STORAGE_UNAVAILABLE');assert.equal(r.body.error.outcome,'unknown');assert.equal(h.executor.status().state,'fault');}finally{h.store.subscribeAgentWebhook=original;}
 await until(()=>h.worker.list().subscriptions[0]?.acceptedThrough===3);assert.equal(h.worker.list().subscriptions.length,1);error(await h.api('GET',agentPaths.run(run.agentRunId)),503,'AGENT_STORAGE_UNAVAILABLE');assert.equal(h.effects.length,0);
});
test('read failure after a confirmed subscription is reported as unknown and does not claim the write was rejected',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),original=h.store.readAgentWebhookCapture;h.store.readAgentWebhookCapture=()=>{throw Error('private-backend read unavailable');};try{const r=await h.subscribe(run,cursor(run,3));error(r,503,'AGENT_STORAGE_UNAVAILABLE');assert.equal(r.body.error.outcome,'unknown');}finally{h.store.readAgentWebhookCapture=original;}assert.equal(h.worker.list().subscriptions.length,1);assert.equal(h.executor.status().state,'fault');
});
test('unknown read errors cannot impersonate expected reference codes or leak private backend text',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),sub=(await h.subscribe(run,cursor(run,3))).body.data,original=h.store.readAgentWebhookCapture;h.store.readAgentWebhookCapture=()=>{throw Object.assign(Error('private-backend'),{code:'STATE_WEBHOOK_REFERENCE'});};try{error(await h.status(run,sub),503,'AGENT_STORAGE_UNAVAILABLE');assert.equal(h.executor.status().state,'fault');}finally{h.store.readAgentWebhookCapture=original;}
});
test('public Source end remains independent of an original Webhook DNS callback and requested attempt',enabled,async t=>{
 const gate=gateLookup(),h=await harness(t,{driverOptions:{useLocalhost:true,lookup:gate.lookup,maxConcurrent:1}}),{run}=await h.active();let sub;
 try{sub=(await h.subscribe(run)).body.data;await gate.ready;const before=(await h.status(run,sub)).body.data;assert.equal(before.head.lastOutcome,'requested');assert.equal(before.head.attempts,1);assert.equal(before.acceptedThrough,cursor(run,0));const closed=await h.client(END)('POST',agentPaths.end(run.agentRunId));assert.equal(closed.status,202);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');assert.equal(h.worker.status().inFlight,1);assert.equal((await h.status(run,sub)).body.data.head.lastOutcome,'requested');}finally{gate.release();}try{await until(async()=>((await h.status(run,sub)).body.data?.pending===0));}catch(error){t.diagnostic(JSON.stringify({publicSourceEndDns:{worker:h.worker.status(),subscription:(await h.status(run,sub)).body,peer:h.peer.counts(),requests:h.peer.requests.length}}));throw error;}assert.equal(h.effects.length,0);
});
test('capture saturation retains the exact original gap; public retries cannot reset it or replay Source effects',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active(),sub=(await h.subscribe(run,cursor(run,3))).body.data;await h.worker.close();assert.equal(h.peer.requests.length,0);
 for(let i=0;i<22;i++)await h.invocation(h.perform(run,context,'gap-api-'+i));const before=(await h.status(run,sub)).body.data;assert.equal(before.pending,64);assert.equal(before.reconciliationRequired,true);assert.equal(before.missingFrom,cursor(run,68));assert.equal(before.missingThrough,cursor(run,69));
h.registerEndpoint();
 await until(()=>h.peer.requests.length===64);await until(async()=>((await h.status(run,sub)).body.data?.pending===0));const after=(await h.status(run,sub)).body.data;assert.equal(after.acceptedThrough,cursor(run,67));assert.equal(after.head,null);assert.equal(after.reconciliationRequired,true);assert.equal(after.missingFrom,cursor(run,68));error(await h.subscribe(run,cursor(run,69)),409,'AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT');assert.equal(h.effects.length,22);
});
test('slow management authentication retains ordinary capacity while public Source end uses its independent lane',enabled,async t=>{
 const gate=deferred(),entered=deferred(),authenticate=createApiKeyAuthenticator(credentials),h=await harness(t,{http:{maxConcurrentRequests:1,maxAgentEndRequests:1},authenticate:request=>{if(request.token===SLOW){entered.resolve();return gate.promise;}return authenticate(request);}}),{run}=await h.active();
 const pending=h.client(SLOW)('GET',endpoints(run));try{await entered.promise;assert.equal((await h.client(END)('POST',agentPaths.end(run.agentRunId))).status,202);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');}finally{gate.resolve({tenantId,scopes:[scopes[0]]});}assert.equal((await pending).status,200);
});
test('public management rejects oversized bodies, misleading event headers, queries, methods and GET payloads',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();error(await h.raw({method:'POST',path:subscriptions(run),headers:{'content-type':'application/json','content-length':'1025'}}),413,'REQUEST_TOO_LARGE');error(await h.api('GET',endpoints(run),{headers:{'last-event-id':cursor(run,0)}}),400,'INVALID_REQUEST');error(await h.api('GET',endpoints(run)+'?after='+cursor(run,0)),404,'ROUTE_NOT_FOUND');error(await h.api('DELETE',subscriptions(run)),405,'METHOD_NOT_ALLOWED');error(await h.raw({path:endpoints(run),headers:{'content-length':'2'},payload:'{}'}),400,'INVALID_REQUEST');assert.equal(h.executor.status().state,'active');
});
test('incomplete public subscription body expires without a durable subscription and releases ordinary admission',enabled,async t=>{
 const h=await harness(t,{http:{maxConcurrentRequests:1,requestTimeoutMs:50}}),{run}=await h.active();error(await h.raw({method:'POST',path:subscriptions(run),headers:{'content-type':'application/json','content-length':'500'},setup:req=>req.write('{')}),408,'REQUEST_TIMEOUT');assert.equal(h.worker.list().subscriptions.length,0);assert.equal((await h.api('GET',endpoints(run))).status,200);assert.equal(h.peer.requests.length,0);
});
test('disabled public Agent access exposes a stable sanitized error without private endpoint provisioning',enabled,async t=>{
 const h=await harness(t,{disabled:true}),{run}=await h.active();error(await h.api('GET',endpoints(run)),503,'AGENT_NOT_CONFIGURED');error(await h.subscribe(run),503,'AGENT_NOT_CONFIGURED');assert.equal(h.worker.list().subscriptions.length,0);
});
test('public executor metadata arguments reject proxies and getters before their traps execute',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();let traps=0;const proxy=new Proxy({},{getPrototypeOf(){traps++;throw Error();},ownKeys(){traps++;throw Error();},getOwnPropertyDescriptor(){traps++;throw Error();}});for(const method of ['webhookEndpoints','subscribeWebhook','webhookSubscription'])assert.throws(()=>h.executor[method](proxy),{code:'AGENT_INVALID_REQUEST'});assert.throws(()=>h.executor.subscribeWebhook({tenantId,agentRunId:run.agentRunId,get endpointId(){traps++;return endpointId;},after:0}),{code:'AGENT_INVALID_REQUEST'});assert.equal(traps,0);assert.equal(h.executor.status().state,'active');
});

test('revoking public management credentials after commit cannot cancel durable automatic delivery',enabled,async t=>{
 let allowed=true;const auth=createApiKeyAuthenticator(credentials),h=await harness(t,{authenticate:r=>r.token===ALL&&!allowed?null:auth(r)}),{run}=await h.active(),sub=(await h.subscribe(run)).body.data;allowed=false;error(await h.status(run,sub),401,'UNAUTHENTICATED');await until(async()=>((await h.status(run,sub,READ)).body.data?.acceptedThrough===cursor(run,3)));assert.equal(h.worker.list().subscriptions.length,1);assert.equal(h.effects.length,0);
});

test('a fresh controller and public server read and resume the original closed Run subscription without repeating Source actions',enabled,async t=>{
 const h=await harness(t,{durable:true}),{run}=await h.active(),sub=(await h.subscribe(run)).body.data;await until(async()=>((await h.status(run,sub)).body.data?.acceptedThrough===cursor(run,3)));await h.worker.close();await h.client(END)('POST',agentPaths.end(run.agentRunId));await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');const retained=(await h.status(run,sub)).body.data;assert.ok(retained.pending>0);await h.executor.shutdown();
 const replacement=new DurableAgentExecutor({store:h.store,registry:h.registry,providers:new Map([['test',h.provider]]),actionKey});h.replaceExecutor(replacement);const sockets=new Set(),server=createSessionControlServer({registry:h.registry,agentExecutor:replacement,authenticate:createApiKeyAuthenticator(credentials)});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));});const api=agentHttpClient('http://127.0.0.1:'+server.address().port,ALL),calls=h.calls.length;
 assert.deepEqual((await api('GET',endpoints(run))).body.data.endpoints,[]);assert.deepEqual((await api('GET',detail(run,sub))).body.data,retained);const resumed=replacement.registerWebhookEndpoint(h.config);assert.equal((await api('POST',subscriptions(run),{data:{endpointId,after:cursor(run,0)}})).body.data.subscriptionId,sub.subscriptionId);await until(async()=>((await api('GET',detail(run,sub))).body.data?.acceptedThrough===retained.observedLatest));assert.equal(h.calls.length,calls);assert.equal(h.effects.length,0);assert.equal(resumed.list().subscriptions.length,1);const first=h.prod.read(),last=h.prod.read({after:first.nextCursor}),events=[...first.events,...last.events];assert.equal(events.length,new Set(events.map(x=>x.envelope.event.eventId)).size);
});
