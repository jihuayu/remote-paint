import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {WebSocket} from 'ws';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';
import {ClusterSessionProvider} from '../service/cluster-session-provider.mjs';
import {ClusterWorkerService} from '../service/cluster-worker-service.mjs';
import {ClusterRpcClient,createClusterRpcServer} from '../service/cluster-rpc.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {DurableAgentExecutor} from '../service/agent-executor.mjs';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {fixture as sourceFixture,renderer,KEY,OTHER} from './fixtures/viewer-access-harness.mjs';
import {snapshot} from './live-helpers.mjs';
import {agentHttpClient,agentPaths} from './fixtures/agent-http-client.mjs';
import {createClusterTestPki,readClusterTestTls} from './fixtures/cluster-test-pki.mjs';

async function until(callback){const end=performance.now()+5000;for(;;){const value=await callback();if(value)return value;assert.ok(performance.now()<end,'Cluster Gateway observation deadline');await new Promise(r=>setTimeout(r,5));}}
async function stack(t){
 const directory=await mkdtemp(join(tmpdir(),'cluster-gateway-')),pki=process.env.REMOTE_PAINT_CLUSTER_TEST_PKI??join(directory,'pki');
 const pins=process.env.REMOTE_PAINT_CLUSTER_TEST_PKI?JSON.parse(await readFile(join(pki,'pins.json'),'utf8')):createClusterTestPki(pki);
 const clients=new Map(),services=[],servers=[],backends=[];let provider,registry,executor,access,http,ledger,placement;
 t.after(async()=>{http?.closeAllConnections();await executor?.shutdown();await registry?.shutdown();await provider?.shutdown();access?.close();if(http?.listening)await new Promise(r=>http.close(r));for(const service of services)await service.close();for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}placement?.close();ledger?.close();await rm(directory,{recursive:true,force:true});});
 const version='cluster-virtual-source-v1';
 for(const [index,nodeId]of ['worker-a','worker-b'].entries()){
  const source=await sourceFixture(t,{ttlSeconds:120});source.source.latest=snapshot({translation:index});source.source.viewport=source.source.latest.viewport;
  const entries=new Map(),contexts=new Map(),listeners=new Set(),backend={created:0,effects:0,proofAvailable:true,fail(sessionId){for(const fn of listeners)fn({sessionId,tenantId:'a',region:'test'});}};
  const implementation={create(request){backend.created++;entries.set(request.sessionId,{request,closed:false});return {version};},close({sessionId}){const entry=entries.get(sessionId);if(entry)entry.closed=true;return {status:'closed'};},resolveSource(request){assert.equal(entries.get(request.sessionId)?.closed,false);return {...request,signal:undefined,origin:source.transport.origin,streamOrigin:source.transport.streamOrigin,key:source.transport.key};},
   agent({tenantId,sessionId,command}){if(command.op==='begin'){const context={binding:{tenantId,sessionId,targetId:'target_'+randomUUID(),runId:'run_'+randomUUID()},fence:{controlSessionId:randomUUID(),controlVersion:0,pageEpoch:1,viewportVersion:1}};contexts.set(sessionId,context);return context;}const context=contexts.get(sessionId);assert.equal(command.runId,context.binding.runId);if(command.op==='context')return context;if(command.op==='end'){contexts.delete(sessionId);return {stage:'run-closed',binding:context.binding};}backend.effects++;return {stage:'input-injected',binding:context.binding,fence:command.context.fence,inputs:1};},subscribeUnavailable(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const service=new ClusterWorkerService({nodeId,incarnation:'boot-'+nodeId,region:'test',version,provider:implementation,leaseMs:2000,maxSessions:16,verifyRetirement:()=>backend.proofAvailable?{sha256:'a'.repeat(64)}:null});services.push(service);backends.push(backend);
  const server=createClusterRpcServer({tls:readClusterTestTls(pki,nodeId),clientSha256:[pins.controller],handle:service.handle.bind(service)});servers.push(server);server.listen(0,'127.0.0.1');await once(server,'listening');
  const client=new ClusterRpcClient({endpoint:'https://127.0.0.1:'+server.address().port,serverName:nodeId+'.test',serverSha256:pins[nodeId],tls:readClusterTestTls(pki,'controller')});
  clients.set(nodeId,{client,descriptor:{nodeId,incarnation:'boot-'+nodeId,region:'test',arch:'arm64',version,capacity:4},validateSource:(target,request)=>target.tenantId===request.tenantId&&target.sessionId===request.sessionId&&target.version===version&&target.origin===source.transport.origin&&target.streamOrigin===source.transport.streamOrigin});
 }
 const path=join(directory,'placement.sqlite'),fd=await open(path,'wx',0o600);await fd.close();placement=new ClusterPlacementStore({database:new DatabaseSync(path),leaseMs:2000,verifyRetirement:(...args)=>provider.verifyRetirement(...args)});
 provider=new ClusterSessionProvider({store:placement,region:'test',arch:'arm64',version,workers:clients,leaseMs:2000,heartbeatMs:200});assert.equal((await provider.initialize()).availableWorkers,2);
 ledger=new SqliteSessionStore({path:join(directory,'registry.sqlite')});registry=new SessionRegistry({store:ledger,providers:new Map([['test',provider]]),defaultRegion:'test'});
 executor=new DurableAgentExecutor({store:ledger,registry,providers:new Map([['test',provider]]),actionKey:'a'.repeat(64)});access=new ViewerAccess({registry,resolveSource:request=>provider.resolveSource(request)});
 const scopes=['sessions:create','sessions:read','sessions:release','viewers:read','viewers:control','agents:read','agents:write','agents:end'];
 http=createSessionControlServer({registry,agentExecutor:executor,viewerAccess:access,authenticate:createApiKeyAuthenticator([{apiKey:KEY,tenantId:'a',scopes},{apiKey:OTHER,tenantId:'b',scopes}])});http.listen(0,'127.0.0.1');await once(http,'listening');const base='http://127.0.0.1:'+http.address().port,api=agentHttpClient(base,KEY);
 const create=async key=>{const response=await api('POST','/v1/sessions',{data:{region:'test',ttlSeconds:60},idempotencyKey:key});assert.equal(response.status,202);await until(()=>registry.getOperation('a',response.body.data.operationId).status!=='pending');return registry.requireReady('a',response.body.data.sessionId);};
 return {base,api,create,provider,placement,registry,backends,version,clients};
}

test('existing HTTP Registry, Viewer proxy and durable Agent executor route through authenticated cluster providers',async t=>{
 const h=await stack(t),first=await h.create('first'),second=await h.create('second');assert.deepEqual(h.backends.map(b=>b.created),[1,1]);
 assert.equal((await agentHttpClient(h.base,OTHER)('GET','/v1/sessions/'+first.sessionId)).status,404);
 const audience='https://cluster-fixture.example',ticket=await h.api('POST','/v1/sessions/'+first.sessionId+'/viewer-tickets',{data:{role:'readonly',audience,ttlSeconds:30}});assert.equal(ticket.status,200);
 const ws=new WebSocket(h.base.replace('http:','ws:')+ticket.body.data.streamPath,{origin:audience});t.after(()=>ws.terminate());const messages=[];let binaries=0;ws.on('message',(bytes,binary)=>{if(binary)binaries++;else{const m=JSON.parse(bytes.toString());messages.push(m);if(m.type==='FrameCommit')ws.send(JSON.stringify({type:'FrameAck',frameId:m.frameId,pageEpoch:m.pageEpoch}));}});await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer}));await until(()=>messages.some(m=>m.type==='FrameCommit'));assert.equal(messages.find(m=>m.type==='Welcome').viewerSessionId,first.sessionId);assert.ok(binaries>0);ws.terminate();
 const created=await h.api('POST',agentPaths.create(second.sessionId),{data:{region:'test',version:h.version},idempotencyKey:'cluster-agent'});assert.equal(created.status,202);const run=created.body.data;
 await until(async()=>((await h.api('GET',agentPaths.run(run.agentRunId))).body.data.state==='active'));const context=(await h.api('GET',agentPaths.context(run.agentRunId))).body.data;
 const action=await h.api('POST',agentPaths.invocations(run.agentRunId),{data:{tool:'insertText',params:{text:'synthetic-cluster-action'},context},idempotencyKey:'cluster-action'});assert.equal(action.status,202);await until(async()=>((await h.api('GET',agentPaths.invocation(action.body.data.invocationId))).body.data.state==='injected'));assert.deepEqual(h.backends.map(b=>b.effects),[0,1]);
 await h.api('POST',agentPaths.end(run.agentRunId));await until(async()=>((await h.api('GET',agentPaths.run(run.agentRunId))).body.data.state==='closed'));
 for(const session of [first,second]){await h.api('DELETE','/v1/sessions/'+session.sessionId);await until(()=>h.registry.getSession('a',session.sessionId).state==='closed');}assert.equal(h.placement.status().heldSlots,0);
});

test('unconfirmed retirement retains Registry and cluster quota until an explicit verified retry',async t=>{
 const h=await stack(t),session=await h.create('proof');h.backends[0].proofAvailable=false;await h.api('DELETE','/v1/sessions/'+session.sessionId);await until(()=>h.registry.getSession('a',session.sessionId).state==='cleanup-failed');assert.equal(h.placement.status().heldSlots,1);assert.equal(h.registry.stats().reservedSessions,1);
 h.backends[0].proofAvailable=true;await h.api('DELETE','/v1/sessions/'+session.sessionId);await until(()=>h.registry.getSession('a',session.sessionId).state==='closed');assert.equal(h.placement.status().heldSlots,0);assert.equal(h.backends[0].created,1);
});

test('cancelling before RPC dispatch closes only the known unstarted reservation',async t=>{
 const h=await stack(t),operation=h.registry.create('a',{region:'test',ttlSeconds:60},{idempotencyKey:'cancel-before-dispatch'});h.registry.release('a',operation.sessionId);
 await until(()=>h.registry.getSession('a',operation.sessionId).state==='closed');assert.equal(h.placement.status().heldSlots,0);assert.deepEqual(h.backends.map(b=>b.created),[0,0]);
});

test('Worker health events reach the original Registry while the other node stays usable',async t=>{
 const h=await stack(t),a=await h.create('health-a'),b=await h.create('health-b');h.backends[0].fail(a.sessionId);await until(()=>h.registry.getSession('a',a.sessionId).state==='closed');assert.equal(h.registry.requireReady('a',b.sessionId).state,'ready');assert.equal((await h.provider.resolveSource({tenantId:'a',sessionId:b.sessionId,region:'test',version:h.version})).sessionId,b.sessionId);
});

test('controller and Worker both reject a foreign Agent context before the underlying provider receives an action',async t=>{
 const h=await stack(t),a=await h.create('context-a'),b=await h.create('context-b'),request=session=>({tenantId:'a',sessionId:session.sessionId,region:'test',version:h.version});
 const context=await h.provider.agent({...request(a),command:{op:'begin'}}),command={op:'perform',runId:context.binding.runId,tool:'insertText',params:{text:'must-not-inject'},context};
 await assert.rejects(h.provider.agent({...request(b),command}),e=>e.code==='AGENT_INVALID_CONTEXT'&&e.outcome==='not-dispatched');
 const route=h.placement.route(request(b)),placement=Object.fromEntries(['tenantId','sessionId','nodeId','generation','epoch'].map(k=>[k,route[k]]));
 await assert.rejects(h.clients.get(route.nodeId).client.call('agent',{placement,request:request(b),command,timeoutMs:5000}),e=>e.code==='AGENT_INVALID_CONTEXT'&&e.outcome==='not-dispatched');assert.deepEqual(h.backends.map(backend=>backend.effects),[0,0]);
});
