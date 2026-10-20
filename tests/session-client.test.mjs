import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionClient,SessionClientError} from '../sdk/backend.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
const apiKey='fixture_backend_client_key_0000000000',at='2026-10-18T00:00:00.000Z',requestId='req_fixture';
const op=(patch={})=>({operationId:'op_fixture',sessionId:'ses_fixture',kind:'create-session',status:'pending',createdAt:at,updatedAt:at,error:null,...patch});
const reply=(data=op(),status=202,extra={})=>new Response(JSON.stringify({data,requestId}),{status,headers:{'content-type':'application/json','x-request-id':requestId,...extra}});
const errorReply=(code,status=503,message='private-proxy-token')=>new Response(JSON.stringify({error:{code,message},requestId}),{status,headers:{'content-type':'application/json','x-request-id':requestId}});
const config=(fetch,extra={})=>({baseUrl:'https://api.fixture.test',apiKey,fetch,...extra});
const expectError=code=>error=>error instanceof SessionClientError&&error.code===code;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('backend client validates configuration and requests before any dispatch',()=>{
 let calls=0;const fetch=async()=>{calls++;return reply();};
 for(const extra of [{baseUrl:'http://api.fixture.test'},{baseUrl:'https://user:pass@api.fixture.test'},{baseUrl:'https://api.fixture.test/?key=private'},{baseUrl:'https://api.fixture.test/#private'},{baseUrl:'https://api.fixture.test/prefix'},{apiKey:'short'},{retries:4},{timeoutMs:0},{maxResponseBytes:1}])assert.throws(()=>new SessionClient(config(fetch,extra)),expectError('CLIENT_INVALID_REQUEST'));
 const client=new SessionClient(config(fetch));
 for(const input of [{tenantId:'b'},{url:'file:///private'},{url:' about:blank'},{url:'https://user:pass@fixture.test'},{ttlSeconds:0},{region:''},{get url(){throw new Error('must not call accessor');}}])assert.throws(()=>client.sessions.prepareCreate(input,{idempotencyKey:'a'}),expectError('CLIENT_INVALID_REQUEST'));
 for(const key of ['', 'has space','x'.repeat(129)])assert.throws(()=>client.sessions.prepareCreate({},{idempotencyKey:key}),expectError('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>client.sessions.get('op_other'),expectError('CLIENT_INVALID_REQUEST'));assert.throws(()=>client.operations.get('ses_other'),expectError('CLIENT_INVALID_REQUEST'));assert.equal(calls,0);assert.doesNotMatch(JSON.stringify(client),new RegExp(apiKey));
});

test('prepared creation captures original body and key across caller mutation and manual retry',async()=>{
 const calls=[];let fail=true;const client=new SessionClient(config(async(url,init)=>{calls.push({url,init});if(fail){fail=false;throw new Error('private transport '+apiKey);}return reply();}));
 const input={url:'https://example.test/',ttlSeconds:60},options={idempotencyKey:'original-key'},prepared=client.sessions.prepareCreate(input,options);input.url='https://changed.test/';options.idempotencyKey='changed-key';
 await assert.rejects(prepared.send(),error=>{assert.equal(error.code,'CLIENT_TRANSPORT_ERROR');assert.equal(error.outcome,'unknown');assert.doesNotMatch(String(error)+JSON.stringify(error),new RegExp(apiKey));return true;});assert.equal(calls.length,1);
 const result=await prepared.send();assert.equal(result.data.operationId,'op_fixture');assert.equal(calls.length,2);assert.equal(calls[0].init.body,calls[1].init.body);assert.equal(calls[1].init.body,'{"url":"https://example.test/","ttlSeconds":60}');assert.equal(calls[1].init.headers['idempotency-key'],'original-key');assert.equal(calls[1].init.redirect,'error');assert.equal(calls[1].init.credentials,'omit');assert.equal(Object.isFrozen(prepared),true);assert.equal(Object.isFrozen(result.data),true);
});

test('explicit transient retry preserves the same body/key and permission/conflict errors never retry',async()=>{
 const calls=[];const client=new SessionClient(config(async(url,init)=>{calls.push(init);return calls.length===1?errorReply('REGISTRY_STORAGE_UNAVAILABLE'):reply();},{retries:1}));
 await client.sessions.create({},{idempotencyKey:'key'});assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.equal(calls[0].headers['idempotency-key'],calls[1].headers['idempotency-key']);
 let rejected=0;const conflict=new SessionClient(config(async()=>{rejected++;return errorReply('IDEMPOTENCY_CONFLICT',409);},{retries:3}));
 await assert.rejects(conflict.sessions.create({},{idempotencyKey:'key'}),error=>{assert.equal(error.code,'IDEMPOTENCY_CONFLICT');assert.equal(error.outcome,'rejected');assert.equal(error.retryable,false);assert.equal(error.status,409);assert.doesNotMatch(String(error)+JSON.stringify(error),/private-proxy-token/);return true;});assert.equal(rejected,1);
});

test('successful response requires exact metadata, request ID, operation kind, target and status consistency',async()=>{
 const cases=[()=>reply({...op(),secret:'private'}),()=>reply(op(),200),()=>reply(op({kind:'release-session'})),()=>reply(op({status:'failed'})),()=>reply(op({operationId:'ses_wrong'})),()=>reply(op(),202,{'x-request-id':'req_other'}),()=>reply(op(),202,{'content-type':'text/plain'}),()=>errorReply('CLIENT_ABORTED',409)];
 for(const fetch of cases){const client=new SessionClient(config(fetch));await assert.rejects(client.sessions.create({},{idempotencyKey:'key'}),expectError('CLIENT_INVALID_RESPONSE'));}
 const client=new SessionClient(config(()=>reply(op(),200)));await assert.rejects(client.operations.get('op_other'),expectError('CLIENT_INVALID_RESPONSE'));
 const release=new SessionClient(config(()=>reply(op({kind:'release-session'}))));await assert.rejects(release.sessions.release('ses_other'),expectError('CLIENT_INVALID_RESPONSE'));
});

test('response size, invalid UTF8/JSON and non-JSON proxy errors are bounded and redacted',async()=>{
 let cancelled=false;const large=new SessionClient(config(()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;}}),{status:202,headers:{'content-type':'application/json'}}),{maxResponseBytes:1024}));
 await assert.rejects(large.sessions.create({},{idempotencyKey:'key'}),expectError('CLIENT_INVALID_RESPONSE'));assert.equal(cancelled,true);
 for(const body of ['{',new Uint8Array([255])]){const client=new SessionClient(config(()=>new Response(body,{headers:{'content-type':'application/json'}})));await assert.rejects(client.sessions.get('ses_fixture'),expectError('CLIENT_INVALID_RESPONSE'));}
 const proxy=new SessionClient(config(()=>new Response('private gateway '+apiKey,{status:503})));await assert.rejects(proxy.sessions.get('ses_fixture'),error=>{assert.equal(error.code,'CLIENT_HTTP_ERROR');assert.equal(error.status,503);assert.equal(error.outcome,'unknown');assert.doesNotMatch(String(error)+JSON.stringify(error),new RegExp(apiKey));return true;});
});

test('aborting before dispatch sends nothing; aborting in flight reports an unknown result without automatic replay',async()=>{
 let calls=0;const called=deferred(),hang=deferred(),client=new SessionClient(config(async()=>{calls++;called.resolve();return hang.promise;},{retries:3}));
 const before=new AbortController();before.abort();await assert.rejects(client.sessions.create({},{idempotencyKey:'key',signal:before.signal}),error=>error.code==='CLIENT_ABORTED'&&error.outcome==='not-dispatched');assert.equal(calls,0);
 const during=new AbortController(),pending=client.sessions.create({},{idempotencyKey:'key',signal:during.signal});await called.promise;during.abort();await assert.rejects(pending,error=>error.code==='CLIENT_ABORTED'&&error.outcome==='unknown');assert.equal(calls,1);hang.resolve(reply());
});

test('timeout bounds fetch and response streaming; late results do not become accepted successes',async()=>{
 const late=deferred(),client=new SessionClient(config(()=>late.promise,{timeoutMs:50}));
 await assert.rejects(client.sessions.create({},{idempotencyKey:'key'}),error=>error.code==='CLIENT_TIMEOUT'&&error.outcome==='unknown'&&error.retryable);late.resolve(reply());
 let cancelled=false;const stream=new SessionClient(config(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}),{timeoutMs:50}));
 await assert.rejects(stream.sessions.get('ses_fixture'),expectError('CLIENT_TIMEOUT'));assert.equal(cancelled,true);
});

test('real fetch refuses redirects without forwarding management credentials to the redirect target',async t=>{
 let targetCalls=0;const target=createServer((req,res)=>{targetCalls++;res.end('must not reach');}),redirect=createServer((req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:'+target.address().port});res.end();});
 for(const server of [target,redirect]){t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});server.listen(0,'127.0.0.1');await once(server,'listening');}
 const client=new SessionClient({baseUrl:'http://127.0.0.1:'+redirect.address().port,apiKey});await assert.rejects(client.sessions.create({},{idempotencyKey:'key'}),expectError('CLIENT_TRANSPORT_ERROR'));assert.equal(targetCalls,0);
});

test('typed client actual lost HTTP response/SQLite retry creates once, queries and releases', {skip:!sessionStoreSupported},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-sdk-'));let registry,server,store;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}try{await registry?.shutdown();}finally{store?.close();await rm(directory,{recursive:true,force:true});}});
 let creates=0,closes=0,dropSocket,received=0;store=new SqliteSessionStore({path:join(directory,'ledger.sqlite')});registry=new SessionRegistry({providers:new Map([['test',{create:async()=>{creates++;dropSocket?.destroy();dropSocket=null;return {version:'fixture-v1'};},close:async()=>{closes++;return {status:'closed'};}}]]),defaultRegion:'test',store});
 server=createSessionControlServer({registry,authenticate:createApiKeyAuthenticator([{apiKey,tenantId:'a',scopes:['sessions:create','sessions:read','sessions:release']}])});server.on('request',req=>{received++;if(received===1)dropSocket=req.socket;});server.listen(0,'127.0.0.1');await once(server,'listening');
 const client=new SessionClient({baseUrl:'http://127.0.0.1:'+server.address().port,apiKey,retries:1}),prepared=client.sessions.prepareCreate({ttlSeconds:60},{idempotencyKey:'key'}),first=await prepared.send(),second=await prepared.send();assert.equal(first.data.sessionId,second.data.sessionId);assert.equal(creates,1);assert.equal(received,3);
 const current=await client.sessions.get(first.data.sessionId);assert.equal(current.data.state,'ready');assert.equal(current.data.version,'fixture-v1');assert.equal(Object.isFrozen(current.data),true);
 const status=await client.operations.get(first.data.operationId);assert.equal(status.data.status,'succeeded');
 const release=await client.sessions.release(first.data.sessionId);const released=await client.operations.get(release.data.operationId);assert.equal(released.data.kind,'release-session');assert.equal(released.data.status,'succeeded');assert.equal(closes,1);
});


test('Session responses enforce the requested identity and availability metadata',async()=>{
 const current={sessionId:'ses_fixture',region:'test',state:'ready',createdAt:at,version:'v1',ttlSeconds:60,readyAt:at,expiresAt:at,closeReason:null,holdsQuota:true};
 for(const patch of [{sessionId:'ses_other'},{state:'unknown'},{version:null},{readyAt:null},{expiresAt:null},{holdsQuota:false},{state:'expired',holdsQuota:true},{closeReason:'private'},{ttlSeconds:0},{createdAt:'invalid'},{private:'unknown field'}]){
  const client=new SessionClient(config(()=>reply({...current,...patch},200)));await assert.rejects(client.sessions.get('ses_fixture'),expectError('CLIENT_INVALID_RESPONSE'));
 }
 const client=new SessionClient(config(()=>reply({...current,state:'recovery-required',readyAt:null,expiresAt:null,version:null},200)));assert.equal((await client.sessions.get('ses_fixture')).data.state,'recovery-required');
});
