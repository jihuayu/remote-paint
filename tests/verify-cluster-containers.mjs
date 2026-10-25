import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,open} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';
import {ClusterSessionProvider} from '../service/cluster-session-provider.mjs';
import {ClusterRpcClient} from '../service/cluster-rpc.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {DurableAgentExecutor} from '../service/agent-executor.mjs';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {agentHttpClient,agentPaths as paths} from './fixtures/agent-http-client.mjs';
import {readClusterTestTls} from './fixtures/cluster-test-pki.mjs';

const caseName=process.env.REMOTE_PAINT_CLUSTER_CASE??'initial';assert.match(caseName,/^[a-z-]{1,32}$/);
const output='/results/container-acceptance-'+caseName,pki='/input/pki',config=JSON.parse(await readFile('/input/containers.json','utf8')),pins=JSON.parse(await readFile(pki+'/pins.json','utf8'));
await mkdir(output,{recursive:true,mode:0o700});const clicks={a:0,b:0},scopes=['sessions:create','sessions:read','sessions:release','viewers:read','agents:read','agents:write','agents:end','agents:observe'],key='cluster_test_backend_only_00000000000000',other='cluster_test_other_tenant_00000000000000';
let store,ledger,provider,registry,executor,access,fixture,http,result,primaryError;const nativeFrames=[],clients=[];
const phase=async stage=>{await writeFile('/results/control-phase.json',JSON.stringify({stage,caseName,at:new Date().toISOString()})+'\n');console.log(JSON.stringify({stage}));};
async function until(callback,ms=15000){const deadline=performance.now()+ms;for(;;){const value=await callback();if(value)return value;assert.ok(performance.now()<deadline,'Independent-container observation deadline');await new Promise(r=>setTimeout(r,30));}}
try{
 const assets=await prepareViewerAssets(),version='chromium:155.0.8059.79;wasm:'+assets.wasmSha256,workers=new Map();
 for(const worker of config.workers){const endpoint='https://'+worker.address+':8443',options={endpoint,serverName:worker.nodeId+'.test',serverSha256:pins[worker.nodeId],tls:readClusterTestTls(pki,'controller'),timeoutMs:500};const client=new ClusterRpcClient(options);clients.push(client);
  const rogue=new ClusterRpcClient({...options,tls:readClusterTestTls(pki,'other-client')});await assert.rejects(rogue.call('lease-begin',{}));rogue.close();
  workers.set(worker.nodeId,{client,descriptor:{nodeId:worker.nodeId,incarnation:worker.incarnation,region:'local',arch:'arm64',version,capacity:1},validateSource:(target,request)=>target.tenantId===request.tenantId&&target.sessionId===request.sessionId&&target.version===version&&target.region==='local'&&target.origin==='http://127.0.0.1:4175'&&target.streamOrigin==='http://'+worker.address+':4176'&&/^[a-f0-9]{48,64}$/.test(target.key)});
 }
 const fd=await open(output+'/placement.sqlite','wx',0o600);await fd.close();store=new ClusterPlacementStore({database:new DatabaseSync(output+'/placement.sqlite'),leaseMs:3000,verifyRetirement:(...args)=>provider.verifyRetirement(...args)});
 provider=new ClusterSessionProvider({store,region:'local',arch:'arm64',version,workers,leaseMs:3000,heartbeatMs:500});assert.equal((await provider.initialize()).availableWorkers,2);
 ledger=new SqliteSessionStore({path:output+'/registry.sqlite'});registry=new SessionRegistry({store:ledger,providers:new Map([['local',provider]]),defaultRegion:'local',globalQuota:2,tenantQuota:2});executor=new DurableAgentExecutor({store:ledger,registry,providers:new Map([['local',provider]]),actionKey:'b'.repeat(64)});access=new ViewerAccess({registry,resolveSource:request=>provider.resolveSource(request)});
 fixture=createServer((req,res)=>{const match=/^\/clicked\/([ab])$/.exec(req.url);if(req.method==='POST'&&match){clicks[match[1]]++;res.end('ok');return;}const page=req.url==='/a'?'a':'b';res.setHeader('content-type','text/html');res.end('<!doctype html><title>container-'+page+'</title><style>body{background:'+(page==='a'?'#def':'#fed')+'}button{position:fixed;left:20px;top:60px;width:180px;height:70px;font-size:22px}</style><h1>Worker '+page+'</h1><button data-testid="go" onclick="fetch(\'/clicked/'+page+'\',{method:\'POST\'});this.textContent=\'clicked\'">go</button>');});fixture.listen(0,'0.0.0.0');await once(fixture,'listening');
 http=createSessionControlServer({registry,agentExecutor:executor,viewerAccess:access,authenticate:createApiKeyAuthenticator([{apiKey:key,tenantId:'container-tenant',scopes},{apiKey:other,tenantId:'other-tenant',scopes}])});http.listen(0,'127.0.0.1');await once(http,'listening');const base='http://127.0.0.1:'+http.address().port,api=agentHttpClient(base,key),sessions=[],runs=[];
 for(const page of ['a','b']){const created=await api('POST','/v1/sessions',{data:{region:'local',url:'http://'+config.gateway+':'+fixture.address().port+'/'+page,ttlSeconds:90},idempotencyKey:'container-'+page});assert.equal(created.status,202);const sessionId=created.body.data.sessionId;await until(()=>registry.getOperation('container-tenant',created.body.data.operationId).status!=='pending');const ready=registry.requireReady('container-tenant',sessionId);assert.equal(ready.version,version);sessions.push(ready);
  const run=await api('POST',paths.create(sessionId),{data:{region:'local',version},idempotencyKey:'agent-'+page});assert.equal(run.status,202);await until(async()=>((await api('GET',paths.run(run.body.data.agentRunId))).body.data.state==='active'));runs.push(run.body.data);
 }
 const click=async(index,keySuffix)=>{const run=runs[index],context=(await api('GET',paths.context(run.agentRunId))).body.data;const invoked=await api('POST',paths.invocations(run.agentRunId),{data:{tool:'click',params:{x:80,y:90},context},idempotencyKey:'click-'+keySuffix});assert.equal(invoked.status,202);await until(async()=>((await api('GET',paths.invocation(invoked.body.data.invocationId))).body.data.state==='injected'));};
 await click(0,'a');await click(1,'b');await until(()=>clicks.a===1&&clicks.b===1);assert.equal((await agentHttpClient(base,other)('GET','/v1/sessions/'+sessions[0].sessionId)).status,404);
 const observation=await api('GET',paths.run(runs[1].agentRunId)+'/observation-context');assert.equal(observation.status,200);const screenshotContext=observation.body.data;
 const shot=await api('POST',paths.run(runs[1].agentRunId)+'/screenshot-observations',{data:{context:screenshotContext}});assert.equal(shot.status,200,JSON.stringify(shot.body));
 const parts=[];let offset=0;for(let n=0;n<128;n++){
  const response=await api('POST',paths.run(runs[1].agentRunId)+'/screenshot-chunks',{data:{context:screenshotContext,screenshotId:shot.body.data.screenshotId,offset,maxBytes:3072}});assert.equal(response.status,200);const chunk=response.body.data;parts.push(Buffer.from(chunk.data,'base64'));offset+=chunk.byteLength;if(chunk.complete)break;
 }
 const png=Buffer.concat(parts);assert.equal(png.length,shot.body.data.byteLength);assert.equal(createHash('sha256').update(png).digest('hex'),shot.body.data.sha256);await writeFile(output+'/public-agent-worker-b.png',png);
 assert.equal((await api('POST',paths.run(runs[1].agentRunId)+'/screenshot-releases',{data:{context:screenshotContext,screenshotId:shot.body.data.screenshotId}})).status,200);
 for(const session of sessions){const audience='https://container-test.example',ticket=await api('POST','/v1/sessions/'+session.sessionId+'/viewer-tickets',{data:{role:'readonly',audience,ttlSeconds:30}});assert.equal(ticket.status,200);const ws=new WebSocket(base.replace('http:','ws:')+ticket.body.data.streamPath,{origin:audience});let binaries=0,commit,welcome;
  ws.on('message',(bytes,binary)=>{if(binary){binaries++;return;}const message=JSON.parse(bytes.toString());if(message.type==='Welcome')welcome=message;if(message.type==='FrameCommit'){commit=message;if(ws.readyState===1)ws.send(JSON.stringify({type:'FrameAck',frameId:message.frameId,pageEpoch:message.pageEpoch}));}});await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:{canvaskit:'0.42.0',wasmSha256:assets.wasmSha256}}));try{await until(()=>commit);assert.equal(welcome.viewerSessionId,session.sessionId);assert.ok(binaries>0);nativeFrames.push({frameId:commit.frameId,binaryPackets:binaries});}finally{const closed=once(ws,'close');ws.terminate();await closed;}
 }
 await phase('ready-for-pause');await until(async()=>{const state=JSON.parse(await readFile('/results/host-phase.json','utf8').catch(()=>'{}'));return state.caseName===caseName&&state.stage==='paused';},120000);
 await until(()=>registry.getSession('container-tenant',sessions[0].sessionId).state==='cleanup-failed');assert.equal(store.status().heldSlots,2);assert.equal(registry.getSession('container-tenant',sessions[0].sessionId).holdsQuota,true);await click(1,'b-while-a-paused');await until(()=>clicks.b===2);assert.throws(()=>registry.requireReady('container-tenant',sessions[0].sessionId));
 await phase('ready-for-unpause');await until(async()=>{const state=JSON.parse(await readFile('/results/host-phase.json','utf8'));return state.caseName===caseName&&state.stage==='unpaused';},120000);
 await until(async()=>{const runtime=JSON.parse(await readFile('/results/worker-a/runtime.json','utf8'));return runtime.closes===1&&runtime.entries.every(e=>e.closed);});
 await api('DELETE','/v1/sessions/'+sessions[0].sessionId);await until(()=>registry.getSession('container-tenant',sessions[0].sessionId).state==='closed');assert.equal(store.status().heldSlots,1);
 await api('POST',paths.end(runs[1].agentRunId));await until(async()=>((await api('GET',paths.run(runs[1].agentRunId))).body.data.state==='closed'));await api('DELETE','/v1/sessions/'+sessions[1].sessionId);await until(()=>registry.getSession('container-tenant',sessions[1].sessionId).state==='closed');assert.equal(store.status().heldSlots,0);
 const runtimeA=JSON.parse(await readFile('/results/worker-a/runtime.json','utf8')),runtimeB=JSON.parse(await readFile('/results/worker-b/runtime.json','utf8'));assert.notEqual(runtimeA.pidNamespace,runtimeB.pidNamespace);assert.equal(runtimeA.creates,1);assert.equal(runtimeB.creates,1);
 result={status:'passed',version,normalPublicAgentClicks:{a:1,b:1},publicAgentScreenshot:{sha256:shot.body.data.sha256,bytes:png.length,chunks:parts.length,checksumVerified:true,released:true},bContinuedWhileAPaused:true,nativeFrames,publicTenantIsolation:true,mtlsWrongClientDenied:true,actualWorkerContainers:2,distinctPidNamespaces:true,nodePauseFailure:true,quotaHeldDuringUnconfirmedRetirement:true,explicitRetryAfterUnpauseClosed:true,heldSlotsFinal:0,sessionNotReplayed:true,workerRuntime:[runtimeA,runtimeB],productionRpcAndProviderAdapter:true,actualSessionRegistryHttpViewerAndAgent:true,singleMachineMultipleContainers:true,crossMachineClusterQualified:false,dockerEngineProviderRuntimeQualified:false,fullContainerRetirementProofQualified:false,haQualified:false};
}catch(error){primaryError=error;await writeFile(output+'/failure.json',JSON.stringify({message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{http?.closeAllConnections();await executor?.shutdown();await registry?.shutdown();const closed=await provider?.shutdown();access?.close();if(http?.listening)await new Promise(r=>http.close(r));if(fixture){fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}store?.close();ledger?.close();for(const client of clients)client.close();await writeFile(output+'/controller-cleanup.json',JSON.stringify({status:closed?.status??'not-started',hadFailure:!!primaryError})+'\n');}
await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');await phase('complete');
