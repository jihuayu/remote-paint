import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionRegistry} from '../service/session-registry.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
const enabled={skip:!sessionStoreSupported};
const KEY_A='fixture_backend_key_tenant_a_00000000',KEY_B='fixture_backend_key_tenant_b_00000000',KEY_READ='fixture_backend_key_readonly_00000000';
const scopes=['sessions:create','sessions:read','sessions:release'];
const flush=()=>new Promise(setImmediate);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const auth=()=>createApiKeyAuthenticator([{apiKey:KEY_A,tenantId:'a',scopes},{apiKey:KEY_B,tenantId:'b',scopes},{apiKey:KEY_READ,tenantId:'a',scopes:['sessions:read']}]);
async function harness(t,{provider={},authenticate=auth(),http={},registryOptions={}}={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-http-'));let registry,server,store;
 t.after(async()=>{if(server){server.closeAllConnections();if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}try{await registry?.shutdown();}finally{store?.close();await rm(directory,{recursive:true,force:true});}});
 store=new SqliteSessionStore({path:join(directory,'state.sqlite')});const calls={create:[],close:[]};
 const source={create:async args=>{calls.create.push(args);return {version:'fixture-v1'};},close:async args=>{calls.close.push(args);return {status:'closed'};},...provider};
 registry=new SessionRegistry({providers:new Map([['test',source]]),defaultRegion:'test',store,...registryOptions});
 server=createSessionControlServer({registry,authenticate,...http});server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port;
 const raw=({method='GET',path='/v1/sessions',headers={},payload,setup}={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,method,path,headers:{authorization:'Bearer '+KEY_A,...headers},agent:false},res=>{
   const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>{try{const text=Buffer.concat(parts).toString();resolve({status:res.statusCode,headers:res.headers,text,body:JSON.parse(text)});}catch(error){reject(error);}});res.on('error',reject);
  });req.on('error',reject);if(setup)setup(req);else req.end(payload); });
 const create=(input={},key='key',headers={})=>raw({method:'POST',headers:{'content-type':'application/json','idempotency-key':key,...headers},payload:JSON.stringify(input)});
 return {store,registry,server,port,calls,source,raw,create};
}
function error(response,status,code){assert.equal(response.status,status,response.text);assert.equal(response.body.error.code,code);assert.equal(response.headers['cache-control'],'no-store');assert.match(response.body.requestId,/^req_/);assert.equal(response.body.requestId,response.headers['x-request-id']);}

test('HTTP factory requires explicit durable confirmed state and validated backend keys',async()=>{
 const registry=new SessionRegistry({providers:new Map([['test',{create:async()=>({version:'v1'}),close:async()=>({status:'closed'})}]]),defaultRegion:'test'});
 assert.throws(()=>createSessionControlServer({registry,authenticate:auth()}),e=>e.code==='REGISTRY_STORAGE_UNAVAILABLE');
 for(const credentials of [[],[{apiKey:'short',tenantId:'a',scopes}],[{apiKey:KEY_A,tenantId:'a',scopes:['all']}],[{apiKey:KEY_A,tenantId:'a',scopes},{apiKey:KEY_A,tenantId:'b',scopes}]])assert.throws(()=>createApiKeyAuthenticator(credentials),TypeError);
 const resolve=auth(),a=resolve({token:KEY_A});a.scopes.push('all');assert.deepEqual(resolve({token:KEY_A}),{tenantId:'a',scopes});assert.equal(resolve({token:'invalid'}),null);await registry.shutdown();
});

test('real HTTP create, query, tenant isolation and release retain IDs and return bounded public metadata',enabled,async t=>{
 const h=await harness(t),created=await h.create();assert.equal(created.status,202);const op=created.body.data;assert.equal(op.kind,'create-session');assert.equal(created.headers.location,'/v1/operations/'+op.operationId);await flush();
 const retried=await h.create({url:'about:blank'});assert.equal(retried.status,200);assert.equal(retried.body.data.operationId,op.operationId);assert.equal(h.calls.create.length,1);assert.equal(h.calls.create[0].url,'about:blank');
 const session=await h.raw({path:'/v1/sessions/'+op.sessionId});assert.equal(session.body.data.state,'ready');assert.equal(session.body.data.version,'fixture-v1');assert.doesNotMatch(session.text,/tenantId|about:blank|apiKey|fixture_backend/);
 const operation=await h.raw({path:'/v1/operations/'+op.operationId});assert.equal(operation.body.data.status,'succeeded');
 error(await h.raw({path:'/v1/sessions/'+op.sessionId,headers:{authorization:'Bearer '+KEY_B}}),404,'SESSION_NOT_FOUND');error(await h.raw({path:'/v1/operations/'+op.operationId,headers:{authorization:'Bearer '+KEY_B}}),404,'OPERATION_NOT_FOUND');
 error(await h.create({url:'https://different.test/'}),409,'IDEMPOTENCY_CONFLICT');assert.equal(h.calls.create.length,1);
 const released=await h.raw({method:'DELETE',path:'/v1/sessions/'+op.sessionId});assert.equal(released.status,202);await flush();
 const again=await h.raw({method:'DELETE',path:'/v1/sessions/'+op.sessionId});assert.equal(again.status,200);assert.equal(again.body.data.operationId,released.body.data.operationId);assert.equal(h.calls.close.length,1);
});

test('backend credentials, scopes and Origin checks precede allocation; tenant fields cannot impersonate another tenant',enabled,async t=>{
 const h=await harness(t);
 error(await h.create({},'key',{authorization:''}),401,'UNAUTHENTICATED');
 error(await h.create({},'key',{authorization:'Bearer '+KEY_READ}),403,'FORBIDDEN');
 error(await h.create({},'key',{origin:'https://viewer.test'}),403,'MANAGEMENT_ORIGIN_FORBIDDEN');
 error(await h.create({tenantId:'b'}),400,'INVALID_REQUEST');
 error(await h.create({},'key',{'x-tenant-id':'b',authorization:['Bearer '+KEY_A,'Bearer '+KEY_B]}),400,'INVALID_REQUEST');
 error(await h.create({},''),400,'INVALID_IDEMPOTENCY_KEY');error(await h.create({},'key',{'idempotency-key':['one','two']}),400,'INVALID_REQUEST');
 assert.equal(h.calls.create.length,0);
 const good=await h.create({},'good',{'x-tenant-id':'b'});assert.equal(good.status,202);assert.equal(h.calls.create[0].tenantId,'a');assert.equal(good.headers['access-control-allow-origin'],undefined);
});

test('malformed, compressed, over-limit and incomplete JSON cannot allocate',enabled,async t=>{
 const h=await harness(t,{http:{maxBodyBytes:128,requestTimeoutMs:100}}),headers={'content-type':'application/json','idempotency-key':'key'};
 error(await h.raw({method:'POST',headers,payload:'{'}),400,'INVALID_REQUEST');
 error(await h.raw({method:'POST',headers,payload:Buffer.from([123,34,117,114,108,34,58,34,255,34,125])}),400,'INVALID_REQUEST');
 error(await h.create({},'key',{'content-encoding':'gzip'}),415,'UNSUPPORTED_MEDIA_TYPE');
 error(await h.create({},'key',{'content-type':'text/plain'}),415,'UNSUPPORTED_MEDIA_TYPE');
 error(await h.raw({method:'POST',headers:{...headers,'content-length':'129'},payload:'x'.repeat(129)}),413,'REQUEST_TOO_LARGE');
 error(await h.raw({method:'POST',headers:{...headers,'transfer-encoding':'chunked'},payload:'x'.repeat(129)}),413,'REQUEST_TOO_LARGE');
 error(await h.raw({method:'POST',headers:{...headers,'content-length':'100'},setup:req=>{req.flushHeaders();req.write('{');}}),408,'REQUEST_TIMEOUT');assert.equal(h.calls.create.length,0);
});

test('unsupported routes, methods, URL query credentials and body-bearing reads are rejected',enabled,async t=>{
 const h=await harness(t);
 for(const path of ['/v1/sessions?apiKey=private','/v1/sessions/..','http://localhost/v1/sessions','/v1/sessions/ses_%61','/v1/not-found'])error(await h.raw({path}),404,'ROUTE_NOT_FOUND');
 const method=await h.raw();error(method,405,'METHOD_NOT_ALLOWED');assert.equal(method.headers.allow,'POST');
 error(await h.raw({path:'/v1/sessions/ses_missing',headers:{'content-length':'1'},payload:'x'}),400,'INVALID_REQUEST');
 error(await h.raw({method:'POST',headers:{expect:'100-continue','content-type':'application/json','idempotency-key':'key'},setup:req=>req.flushHeaders()}),400,'INVALID_REQUEST');assert.equal(h.calls.create.length,0);
});

test('authentication failures are redacted and cannot masquerade as bad credentials or permission grants',enabled,async t=>{
 for(const authenticate of [()=>{throw new Error('private-auth-token');},async()=>{throw new Error('private-auth-token');},()=>({tenantId:'bad/tenant',scopes}),()=>({tenantId:'a',scopes:['all']})]){
  const h=await harness(t,{authenticate}),response=await h.create();error(response,503,'AUTHENTICATION_UNAVAILABLE');assert.doesNotMatch(response.text,/private-auth-token|bad\/tenant/);assert.equal(h.calls.create.length,0);
 }
});

test('HTTP overload and deadline fence slow authentication without dispatching late creation',enabled,async t=>{
 const blocked=deferred(),started=deferred();let count=0;
 const h=await harness(t,{http:{maxConcurrentRequests:1,requestTimeoutMs:100},authenticate:async({signal})=>{count++;started.resolve(signal);await blocked.promise;return {tenantId:'a',scopes};}});
 const first=h.create();const signal=await started.promise;
 error(await h.create({},'second'),503,'SERVICE_BUSY');error(await first,408,'REQUEST_TIMEOUT');assert.equal(signal.aborted,true);error(await h.create({},'third'),503,'SERVICE_BUSY');assert.equal(count,1);blocked.resolve();await flush();assert.equal(h.calls.create.length,0);assert.equal(count,1);
});

test('losing the HTTP response after durable admission preserves the original operation and never repeats allocation',enabled,async t=>{
 const h=await harness(t);let client;const admitted=deferred();h.source.create=async args=>{h.calls.create.push(args);client.destroy(new Error('fixture response deliberately lost'));admitted.resolve(args);return {version:'fixture-v1'};};
 const lost=h.raw({method:'POST',headers:{'content-type':'application/json','idempotency-key':'lost-key'},setup:req=>{client=req;req.end('{}');}});
 await assert.rejects(lost,/fixture response deliberately lost/);await admitted.promise;await flush();
 const retry=await h.create({},'lost-key');assert.equal(retry.status,200);assert.equal(retry.body.data.sessionId,h.calls.create[0].sessionId);assert.equal(h.calls.create.length,1);assert.equal(h.registry.requireReady('a',retry.body.data.sessionId).state,'ready');assert.equal(h.calls.close.length,0);
});

test('confirmed registry state is checked again after asynchronous authentication',enabled,async t=>{
 const blocked=deferred(),started=deferred();const h=await harness(t,{authenticate:async()=>{started.resolve();await blocked.promise;return {tenantId:'a',scopes};}});
 const pending=h.create();await started.promise;await h.registry.shutdown();blocked.resolve();error(await pending,503,'REGISTRY_STORAGE_UNAVAILABLE');assert.equal(h.calls.create.length,0);
});

test('quota rejection and provider failure remain stable redacted HTTP outcomes',enabled,async t=>{
 const blocked=deferred(),h=await harness(t,{provider:{create:async args=>{h.calls.create.push(args);await blocked.promise;throw new Error('private-provider-ticket');}},registryOptions:{tenantQuota:1,globalQuota:1}});
 const first=await h.create();error(await h.create({},'second'),429,'SESSION_QUOTA');blocked.resolve();await flush();
 const result=await h.raw({path:'/v1/operations/'+first.body.data.operationId});assert.equal(result.body.data.error.code,'SESSION_START_FAILED');assert.doesNotMatch(result.text,/private-provider-ticket/);assert.equal(h.calls.create.length,1);
});


test('aborted body intake never admits a partial create and frees request capacity',enabled,async t=>{
 const started=deferred(),aborted=deferred(),h=await harness(t,{http:{maxConcurrentRequests:1,requestTimeoutMs:100},authenticate:args=>{started.resolve();return auth()(args);}});let client;
 h.server.once('request',req=>req.once('aborted',()=>aborted.resolve()));
 const disconnected=h.raw({method:'POST',headers:{'content-type':'application/json','content-length':'100','idempotency-key':'aborted'},setup:req=>{client=req;req.flushHeaders();req.write('{');}});
 const rejected=assert.rejects(disconnected,/fixture incomplete body disconnected/);await started.promise;client.destroy(new Error('fixture incomplete body disconnected'));await rejected;await aborted.promise;await flush();
 assert.equal(h.calls.create.length,0);const good=await h.create({},'after-abort');assert.equal(good.status,202);assert.equal(h.calls.create.length,1);
});
