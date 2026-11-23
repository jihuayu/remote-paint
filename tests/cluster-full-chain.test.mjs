import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {DockerSessionProvider} from '../service/docker-session-provider.mjs';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../service/docker-attach-client.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../service/runtime-retirement-store.mjs';
import {RuntimeDeploymentBindingStore} from '../service/runtime-deployment-binding.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {deriveNativeTransportKey} from '../service/native-transport-key.mjs';
import {ClusterRpcClient,ClusterRpcError} from '../service/cluster-rpc.mjs';
import {assembleClusterDockerWorker,assembleClusterGateway,verifyClusterArchive} from '../service/cluster-ops.mjs';
import {createApiKeyAuthenticator} from '../service/session-http.mjs';
import {fixture as sourceFixture,renderer,KEY,OTHER} from './fixtures/viewer-access-harness.mjs';
import {snapshot} from './live-helpers.mjs';
import {agentHttpClient,agentPaths} from './fixtures/agent-http-client.mjs';
import {createClusterTestPki,readClusterTestTls} from './fixtures/cluster-test-pki.mjs';
import {witness} from './fixtures/runtime-witness-records.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const VERSION='native-abi-structural-fixture-v1';
const SCOPES=['sessions:create','sessions:read','sessions:release','viewers:read','viewers:control','agents:read','agents:write','agents:end'];

async function until(callback,timeoutMs=6000){
 const end=performance.now()+timeoutMs;
 for(;;){
  const value=await callback();
  if(value)return value;
  assert.ok(performance.now()<end,'Full-chain cluster observation deadline');
  await delay(10);
 }
}

async function createDockerNodeEnv(t,{baseDir,nodeId,index,pki,pins,leaseMs=1500}={}){
 const nodeDir=join(baseDir,nodeId);
 await mkdir(nodeDir,{recursive:true,mode:0o700});
 const source=await sourceFixture(t,{ttlSeconds:120});
 source.source.latest=snapshot({translation:index});
 source.source.viewport=source.source.latest.viewport;

 const docs=new Map(),proxies=new Map(),starts=[],agentCalls=[],hooks={};
 const networkId=(index+1).toString(16).repeat(64).slice(0,64);
 const endpointId=(index+2).toString(16).repeat(64).slice(0,64);
 const sandboxId=(index+3).toString(16).repeat(64).slice(0,64);
 const bridgeIp='198.19.192.'+(index*10+5);
 let nextCid=1;

 function document(plan,cid){
  const c=structuredClone(plan.create);
  return {
   Id:cid,Name:'/'+plan.containerName,Image:plan.imageId,Config:c,HostConfig:c.HostConfig,
   Mounts:c.HostConfig.Mounts.map(m=>({Type:'bind',Source:m.Source,Destination:m.Target,RW:false,Propagation:'rprivate'})),
   State:{Status:'running',Running:true,Pid:100+index,StartedAt:'2026-10-18T00:00:00.123456789Z',Paused:false,Restarting:false,Dead:false,OOMKilled:false},
   NetworkSettings:{Ports:{},SandboxID:sandboxId,Networks:{bridge:{NetworkID:networkId,EndpointID:endpointId,IPAddress:bridgeIp,IPPrefixLen:23,Gateway:'198.19.192.1'}}}
  };
 }

 class Metadata extends DockerMetadataClient {
  async inspectImage(){return {daemon:{id:'daemon-'+nodeId},document:{Config:{Env:['PATH=/usr/local/bin']}}};}
  async listRuntimeCandidates(){return {daemon:{id:'daemon-'+nodeId},containerIds:[...docs.keys()]};}
  async inspectContainer(selector){
   await hooks.container?.({selector});
   const doc=docs.get(selector)??[...docs.values()].find(x=>x.Name==='/'+selector);
   return doc?{found:true,daemon:{id:'daemon-'+nodeId},document:structuredClone(doc)}:{found:false,daemon:{id:'daemon-'+nodeId},selector};
  }
  async inspectNetwork(){
   await hooks.network?.();
   return {found:true,daemon:{id:'daemon-'+nodeId},document:{Id:networkId,Name:'bridge',Driver:'bridge',Scope:'local',IPAM:{Config:[{Subnet:'198.19.192.0/23',Gateway:'198.19.192.1'}]},Containers:Object.fromEntries([...docs].map(([cid,doc])=>[cid,{Name:doc.Name.slice(1),EndpointID:endpointId,IPv4Address:doc.NetworkSettings.Networks.bridge.IPAddress+'/23'}]))}};
  }
 }

 class Effects extends DockerEffectClient {
  async open({kind,plan,containerId}){
   const before=docs.get(containerId);
   return {
    inspect:()=>({inspection:before?{found:true,daemon:{id:'daemon-'+nodeId},document:structuredClone(before)}:null,absent:!before}),
    perform:async authorize=>{
     const receipt=authorize();
     if(kind==='create'){
      await hooks.createEffect?.({plan});
      const cid=(index*1000+(nextCid++)).toString(16).padStart(64,'0');
      docs.set(cid,document(plan,cid));
      return {containerId:cid};
     }
     if(kind==='start'){
      await hooks.startEffect?.({plan,containerId});
      return {};
     }
     await hooks.removeEffect?.({plan,containerId});
     docs.delete(containerId);
     return {kind:'remove',containerId,daemonId:'daemon-'+nodeId,connectionId:randomUUID(),httpStatus:before?204:404,authorizationRevision:receipt.revision,effectAttempted:!!before,alreadyAbsent:!before};
    },
    close:async()=>({status:'closed'})
   };
  }
 }

 class Attach extends DockerAttachClient {
  open({plan,containerId}){
   const output=new PassThrough(),done=(()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};})();
   let ended=false,bytes='',activeContext=null;
   const send=v=>output.write(JSON.stringify({protocol:'session-worker-v1',sessionId:plan.sessionId,...v})+'\n');
   const finish=()=>{if(ended)return;ended=true;output.end();done.resolve({code:0,signal:null});};
   const input=new Writable({
    write(chunk,_encoding,callback){
     try{
      bytes+=chunk;
      for(let n;(n=bytes.indexOf('\n'))>=0;){
       const msg=JSON.parse(bytes.slice(0,n));
       bytes=bytes.slice(n+1);
       if(msg.type==='Start'){
        const derivedKey=deriveNativeTransportKey({ownerKey:msg.ownerKey,sessionId:plan.sessionId,tenantId:plan.tenantId,region:plan.region});
        starts.push({sessionId:plan.sessionId,ownerKey:msg.ownerKey,expectedKey:derivedKey});
        void Promise.resolve().then(()=>hooks.startChannel?.({sessionId:plan.sessionId})).then(()=>{
         if(!ended)send({type:'Ready',version:VERSION,capabilities:['agent-rpc-v1']});
        });
       }
       if(msg.type==='AgentCall'){
        const req=msg.request;
        void Promise.resolve().then(async()=>{
         if(req.op==='begin'){
          activeContext={binding:{tenantId:plan.tenantId,sessionId:plan.sessionId,targetId:'target_'+randomUUID(),runId:'run_'+randomUUID()},fence:{controlSessionId:randomUUID(),controlVersion:0,pageEpoch:1,viewportVersion:1}};
          return {ok:true,result:activeContext};
         }
         if(req.op==='context')return {ok:true,result:activeContext};
         if(req.op==='end'){
          const binding=activeContext.binding;
          activeContext=null;
          return {ok:true,result:{stage:'run-closed',binding}};
         }
         agentCalls.push({sessionId:plan.sessionId,tool:req.tool,params:req.params});
         if(hooks.agentPerform)await hooks.agentPerform({sessionId:plan.sessionId,req});
         return {ok:true,result:{stage:'input-injected',binding:activeContext.binding,fence:req.context.fence,inputs:1}};
        }).then(answer=>{if(!ended)send({type:'AgentResult',requestId:msg.requestId,...answer});},()=>{if(!ended)send({type:'AgentResult',requestId:msg.requestId,ok:false,error:{code:'AGENT_INPUT_FAILED',outcome:'unknown'}});});
       }
       if(msg.type==='Close'){send({type:'Closed',reason:'released',code:null});finish();}
      }
      callback();
     }catch(error){callback(error);}
    }
   });
   const proxy={input,output,clientDone:done.promise,attached:Promise.resolve({containerId}),status:()=>({pid:null,transportExited:ended}),stop:async()=>{finish();return {status:'closed'};},lose:()=>{output.emit('end');finish();}};
   proxies.set(plan.sessionId,proxy);
   queueMicrotask(()=>send({type:'WorkerHello',runtimeWitness:witness()}));
   return proxy;
  }
 }

 const projectPath=join(nodeDir,'project'),browserPath=join(nodeDir,'browser');
 await mkdir(projectPath);await mkdir(browserPath);
 const files={},required=['service/native-session-worker.mjs','service/session-worker.mjs','service/native-transport-key.mjs','service/native-session-resource.mjs','service/linux-runtime-witness.mjs','live.mjs','live/transport.mjs','native/bin/aarch64-unknown-linux-gnu/remote-paint-broker'];
 for(const n of required){
  const p=join(projectPath,n),b=Buffer.from('Explicit structural source placeholder; never executed\n');
  await mkdir(dirname(p),{recursive:true});await writeFile(p,b);files[n]=sha(b);
 }
 await writeFile(join(browserPath,'headless_shell'),'Explicit structural browser placeholder; never executed\n');
 const projectManifest=join(nodeDir,'project-manifest.json'),browserManifest=join(nodeDir,'browser-manifest.json');
 const pb=JSON.stringify({schema:'runtime-source-files-v1',files}),bb=JSON.stringify({schema:'runtime-source-files-v1',files:{headless_shell:sha('Explicit structural browser placeholder; never executed\n')}});
 await writeFile(projectManifest,pb);await writeFile(browserManifest,bb);
 const configuration={region:'test',deploymentId:'deploy-'+nodeId,daemonId:'daemon-'+nodeId,imageId:'sha256:'+'b'.repeat(64),projectPath,browserPath,projectManifestSha256:sha(pb),browserManifestSha256:sha(bb),imageEnvironment:['PATH=/usr/local/bin']};
 const statePath=join(nodeDir,'state.sqlite'),bindingDir=join(nodeDir,'binding'),witnessDir=join(nodeDir,'witness'),retirementDir=join(nodeDir,'retirement');

 let booted=null;
 async function boot(incarnation='boot-'+nodeId+'-1'){
  const store=new SqliteSessionStore({path:statePath});
  const metadata=new Metadata({socketPath:join(nodeDir,'unused.sock'),daemonId:'daemon-'+nodeId});
  const effects=new Effects({socketPath:join(nodeDir,'unused.sock'),daemonId:'daemon-'+nodeId});
  const attach=new Attach({socketPath:join(nodeDir,'unused.sock'),daemonId:'daemon-'+nodeId,maxConcurrent:4});
  const witnessStore=new RuntimeWitnessStore({directory:witnessDir});
  const retirementStore=new RuntimeRetirementStore({directory:retirementDir,witnessStore});
  if(!booted){
   await RuntimeDeploymentBindingStore.bootstrap({directory:bindingDir,store,metadata,configuration});
  }
  const provider=new DockerSessionProvider({store,deploymentBinding:new RuntimeDeploymentBindingStore({directory:bindingDir}),configuration,metadata,effects,attach,witnessStore,retirementStore,projectManifest,browserManifest,maxSessions:4});
  await provider.initialize();
  const assembled=assembleClusterDockerWorker({provider,store,nodeId,incarnation,region:'test',version:VERSION,leaseMs,maxSessions:16,tls:readClusterTestTls(pki,nodeId),clientSha256:[pins.controller]});
  await assembled.initialize();
  assembled.server.listen(0,'127.0.0.1');
  await once(assembled.server,'listening');
  const endpoint='https://127.0.0.1:'+assembled.server.address().port;
  booted={
   store,metadata,effects,attach,witnessStore,retirementStore,provider,assembled,endpoint,incarnation,
   async stop(){
    const closed=await assembled.close();
    await attach.close();await effects.close();await metadata.close();
    try{store.close();}catch{}
    return closed;
   }
  };
  return booted;
 }

 await boot('boot-'+nodeId+'-1');
 return {
  nodeId,bridgeIp,source,docs,proxies,starts,agentCalls,hooks,statePath,retirementDir,
  get current(){return booted;},
  boot,
  spec(){
   return {
    nodeId,incarnation:booted.incarnation,endpoint:booted.endpoint,
    serverName:nodeId+'.test',serverSha256:pins[nodeId],capacity:2,
    validateSource:(target,request)=>target.tenantId===request.tenantId&&target.sessionId===request.sessionId&&target.version===VERSION&&target.origin==='http://127.0.0.1:4175'&&target.streamOrigin==='http://'+bridgeIp+':4176'&&/^[a-f0-9]{64}$/.test(target.key)
   };
  }
 };
}

async function createFullStack(t,{leaseMs=1500,heartbeatMs=180}={}){
 const directory=await mkdtemp(join(tmpdir(),'cluster-full-chain-'));
 const pki=join(directory,'pki'),archiveDir=join(directory,'archives');
 await mkdir(archiveDir,{mode:0o700});
 const pins=createClusterTestPki(pki);
 const nodes=[];
 let gateway=null,base=null,api=null;
 t.after(async()=>{
  if(gateway)await gateway.shutdown().catch(()=>{});
  for(const node of nodes)await node.current?.stop().catch(()=>{});
  await rm(directory,{recursive:true,force:true});
 });

 for(const [index,nodeId]of ['worker-a','worker-b'].entries()){
  nodes.push(await createDockerNodeEnv(t,{baseDir:directory,nodeId,index,pki,pins,leaseMs}));
 }
 const placementPath=join(directory,'placement.sqlite'),registryPath=join(directory,'registry.sqlite');
 const fd1=await open(placementPath,'wx',0o600);await fd1.close();

 async function startGateway(workerSpecs=nodes.map(n=>n.spec())){
  gateway=assembleClusterGateway({
   placementPath,registryPath,region:'test',arch:'arm64',version:VERSION,
   leaseMs,heartbeatMs,globalQuota:4,tenantQuota:4,actionKey:'c'.repeat(64),
   authenticate:createApiKeyAuthenticator([{apiKey:KEY,tenantId:'a',scopes:SCOPES},{apiKey:OTHER,tenantId:'b',scopes:SCOPES}]),
   controllerTls:readClusterTestTls(pki,'controller'),
   workers:workerSpecs,
   resolveSource:async(req,provider)=>{
    const resolved=await provider.resolveSource(req);
    const node=nodes.find(n=>'http://'+n.bridgeIp+':4176'===resolved.streamOrigin);
    assert.ok(node,'Resolved Source must match an authenticated Docker Worker bridge IP');
    const started=node.starts.find(s=>s.sessionId===req.sessionId);
    assert.equal(resolved.key,started?.expectedKey,'Resolved Source key must match the DockerSessionProvider derived transport key');
    return Object.freeze({...resolved,origin:node.source.transport.origin,streamOrigin:node.source.transport.streamOrigin,key:node.source.transport.key});
   }
  });
  await gateway.initialize();
  gateway.http.listen(0,'127.0.0.1');
  await once(gateway.http,'listening');
  base='http://127.0.0.1:'+gateway.http.address().port;
  api=agentHttpClient(base,KEY);
  return gateway;
 }

 await startGateway();

 async function createSession(idempotencyKey){
  const res=await api('POST','/v1/sessions',{data:{region:'test',ttlSeconds:60},idempotencyKey});
  assert.equal(res.status,202);
  await until(()=>gateway.registry.getOperation('a',res.body.data.operationId).status!=='pending');
  return gateway.registry.requireReady('a',res.body.data.sessionId);
 }

 return {
  directory,pki,pins,archiveDir,placementPath,registryPath,nodes,
  get gateway(){return gateway;},
  get base(){return base;},
  get api(){return api;},
  startGateway,createSession
 };
}

test('full-chain public Gateway -> authenticated mTLS Workers -> original DockerSessionProvider executes Session, Viewer, Agent, retirement and archival',async t=>{
 const h=await createFullStack(t);
 const first=await h.createSession('full-first');
 const second=await h.createSession('full-second');
 assert.equal(h.nodes[0].starts.length,1);
 assert.equal(h.nodes[1].starts.length,1);
 assert.equal(h.nodes[0].starts[0].sessionId,first.sessionId);
 assert.equal(h.nodes[1].starts[0].sessionId,second.sessionId);

 // Cross-tenant isolation holds at the public Gateway.
 assert.equal((await agentHttpClient(h.base,OTHER)('GET','/v1/sessions/'+first.sessionId)).status,404);

 // Verify direct ClusterSessionProvider.resolveSource returns the exact DockerSessionProvider bridge endpoint and derived key.
 const rawTarget=await h.gateway.provider.resolveSource({tenantId:'a',sessionId:first.sessionId,region:'test',version:VERSION});
 assert.equal(rawTarget.streamOrigin,'http://'+h.nodes[0].bridgeIp+':4176');
 assert.equal(rawTarget.key,h.nodes[0].starts[0].expectedKey);

 // Public Viewer ticket upgrades through ViewerAccess -> ClusterSessionProvider -> ClusterWorkerService -> DockerSessionProvider.resolveSource.
 const audience='https://full-chain-viewer.example';
 const ticket=await h.api('POST','/v1/sessions/'+first.sessionId+'/viewer-tickets',{data:{role:'readonly',audience,ttlSeconds:30}});
 assert.equal(ticket.status,200);
 assert.ok(!JSON.stringify(ticket.body).includes(h.nodes[0].starts[0].expectedKey));
 const ws=new WebSocket(h.base.replace('http:','ws:')+ticket.body.data.streamPath,{origin:audience});
 t.after(()=>ws.terminate());
 const messages=[];let binaries=0;
 ws.on('message',(bytes,binary)=>{
  if(binary)binaries++;
  else{
   const m=JSON.parse(bytes.toString());
   messages.push(m);
   if(m.type==='FrameCommit')ws.send(JSON.stringify({type:'FrameAck',frameId:m.frameId,pageEpoch:m.pageEpoch}));
  }
 });
 await once(ws,'open');
 ws.send(JSON.stringify({type:'Hello',protocol:4,renderer}));
 await until(()=>messages.some(m=>m.type==='FrameCommit'));
 assert.equal(messages.find(m=>m.type==='Welcome').viewerSessionId,first.sessionId);
 assert.ok(binaries>0);
 ws.terminate();

 // Public durable Agent Run executes through mTLS Worker to DockerSessionProvider attach channel.
 const createdRun=await h.api('POST',agentPaths.create(second.sessionId),{data:{region:'test',version:VERSION},idempotencyKey:'full-agent-run'});
 assert.equal(createdRun.status,202);
 const runId=createdRun.body.data.agentRunId;
 await until(async()=>((await h.api('GET',agentPaths.run(runId))).body.data.state==='active'));
 const context=(await h.api('GET',agentPaths.context(runId))).body.data;
 const action=await h.api('POST',agentPaths.invocations(runId),{data:{tool:'insertText',params:{text:'full-chain-docker-action'},context},idempotencyKey:'full-agent-action'});
 assert.equal(action.status,202);
 await until(async()=>((await h.api('GET',agentPaths.invocation(action.body.data.invocationId))).body.data.state==='injected'));
 assert.equal(h.nodes[1].agentCalls.length,1);
 assert.equal(h.nodes[1].agentCalls[0].sessionId,second.sessionId);
 await h.api('POST',agentPaths.end(runId));
 await until(async()=>((await h.api('GET',agentPaths.run(runId))).body.data.state==='closed'));

 // Public release retires containers in DockerSessionProvider, verifies immutable .retirement.json receipts, and frees all slots.
 for(const session of [first,second]){
  const del=await h.api('DELETE','/v1/sessions/'+session.sessionId);
  assert.equal(del.status,202);
  await until(()=>h.gateway.registry.getSession('a',session.sessionId).state==='closed');
 }
 assert.equal(h.gateway.placement.status().heldSlots,0);
 assert.equal(h.gateway.registry.stats().reservedSessions,0);
 assert.equal(h.nodes[0].docs.size,0);
 assert.equal(h.nodes[1].docs.size,0);

 // Verified NDJSON archival prunes closed sessions and validates manifest + file digests.
 const archived=h.gateway.operations.archiveClosedSessions({archiveDir:h.archiveDir});
 assert.equal(archived.archived,2);
 const verified=verifyClusterArchive({manifestPath:archived.manifestFile});
 assert.equal(verified.valid,true);
 assert.equal(verified.records.length,2);
 assert.equal(h.gateway.placement.status().retainedSessions,0);
});

test('late create receipt after cancellation and dropped create RPC before Worker receipt both retire cleanly without ghost containers',async t=>{
 const h=await createFullStack(t);
 // Drain worker-b so allocations deterministically target worker-a.
 h.gateway.operations.drainNode('worker-b');

 // Case 1: In-flight create on worker-a is cancelled/released before startChannel completes.
 let releaseStart,enteredStart;
 const gate=new Promise(r=>releaseStart=r),entered=new Promise(r=>enteredStart=r);
 h.nodes[0].hooks.startChannel=async()=>{enteredStart();await gate;};

 const created=await h.api('POST','/v1/sessions',{data:{region:'test',ttlSeconds:60},idempotencyKey:'late-create-cancel'});
 assert.equal(created.status,202);
 const sessionId=created.body.data.sessionId;
 await entered;
 delete h.nodes[0].hooks.startChannel;

 // Caller releases the session while create is still in flight, then the late worker startup finishes.
 const released=await h.api('DELETE','/v1/sessions/'+sessionId);
 assert.equal(released.status,202);
 releaseStart();

 await until(()=>h.gateway.registry.getSession('a',sessionId).state==='closed');
 assert.equal(h.gateway.registry.getSession('a',sessionId).holdsQuota,false);
 assert.equal(h.gateway.placement.status().heldSlots,0);
 assert.equal(h.nodes[0].docs.size,0);

 // Case 2: Dropped create RPC never reaches worker-a; close arrives at worker-a first, and late create packet arrives afterwards.
 const clientEntry=h.gateway.placement;
 const realCall=h.nodes[0].current.assembled.worker.handle.bind(h.nodes[0].current.assembled.worker);
 let dropNextCreate=true,droppedPayload=null;
 h.nodes[0].current.assembled.worker.handle=async(method,payload,options)=>{
  if(method==='create'&&dropNextCreate){
   dropNextCreate=false;
   droppedPayload=structuredClone(payload);
   throw new ClusterRpcError('CLUSTER_RPC_UNAVAILABLE','unknown');
  }
  return realCall(method,payload,options);
 };

 const droppedRes=await h.api('POST','/v1/sessions',{data:{region:'test',ttlSeconds:60},idempotencyKey:'dropped-create-rpc'});
 assert.equal(droppedRes.status,202);
 const droppedSessionId=droppedRes.body.data.sessionId;
 await until(()=>h.gateway.registry.getOperation('a',droppedRes.body.data.operationId).status==='failed');
 await until(()=>h.gateway.registry.getSession('a',droppedSessionId).holdsQuota===false);
 assert.equal(clientEntry.status().heldSlots,0);
 assert.ok(droppedPayload);

 // When the delayed create packet arrives at worker-a after close, it is rejected with CLUSTER_WORKER_CONFLICT before any container effect.
 const docsBefore=h.nodes[0].docs.size;
 await assert.rejects(realCall('create',droppedPayload,{}),e=>e.code==='CLUSTER_WORKER_CONFLICT'&&e.outcome==='not-dispatched');
 assert.equal(h.nodes[0].docs.size,docsBefore);
});

test('mid-flight Agent partition and Worker lease expiry record unknown outcome without automatic replay while surviving Worker continues',async t=>{
 const h=await createFullStack(t,{leaseMs:600,heartbeatMs:120});
 const sesA=await h.createSession('agent-part-a');
 const sesB=await h.createSession('agent-part-b');

 const runARes=await h.api('POST',agentPaths.create(sesA.sessionId),{data:{region:'test',version:VERSION},idempotencyKey:'run-part-a'});
 const runBRes=await h.api('POST',agentPaths.create(sesB.sessionId),{data:{region:'test',version:VERSION},idempotencyKey:'run-part-b'});
 const runAId=runARes.body.data.agentRunId,runBId=runBRes.body.data.agentRunId;
 await until(async()=>((await h.api('GET',agentPaths.run(runAId))).body.data.state==='active'));
 await until(async()=>((await h.api('GET',agentPaths.run(runBId))).body.data.state==='active'));
 const ctxA=(await h.api('GET',agentPaths.context(runAId))).body.data;
 const ctxB=(await h.api('GET',agentPaths.context(runBId))).body.data;

 // Hold agentPerform on worker-a and sever worker-a's RPC heartbeats until its lease expires.
 let enteredPerform,releasePerform;
 const entered=new Promise(r=>enteredPerform=r),gate=new Promise(r=>releasePerform=r);
 const realHandle=h.nodes[0].current.assembled.worker.handle.bind(h.nodes[0].current.assembled.worker);
 let partitioned=false;
 h.nodes[0].hooks.agentPerform=async()=>{
  enteredPerform();
  partitioned=true;
  await gate;
 };
 h.nodes[0].current.assembled.worker.handle=async(method,payload,options)=>{
  if(partitioned&&['lease-begin','lease-accept','status'].includes(method)){
   throw new ClusterRpcError('CLUSTER_RPC_UNAVAILABLE','unknown');
  }
  return realHandle(method,payload,options);
 };

 const invARes=await h.api('POST',agentPaths.invocations(runAId),{data:{tool:'insertText',params:{text:'in-flight-partition'},context:ctxA},idempotencyKey:'inv-part-a'});
 assert.equal(invARes.status,202);
 const invAId=invARes.body.data.invocationId;
 await entered;

 // Wait for worker-a lease to expire on both worker-a and controller, then release the held perform handler.
 await delay(750);
 releasePerform();

 await until(async()=>((await h.api('GET',agentPaths.invocation(invAId))).body.data.state==='unknown'));
 const invA=(await h.api('GET',agentPaths.invocation(invAId))).body.data;
 assert.equal(invA.state,'unknown');
 assert.equal(invA.dispatchStarted,true);
 assert.equal(invA.error.outcome,'unknown');
 // Effect ran only once and was never replayed.
 assert.equal(h.nodes[0].agentCalls.length,1);

 // Meanwhile worker-b continues executing public Agent invocations normally.
 const invBRes=await h.api('POST',agentPaths.invocations(runBId),{data:{tool:'insertText',params:{text:'surviving-worker-b'},context:ctxB},idempotencyKey:'inv-part-b'});
 assert.equal(invBRes.status,202);
 await until(async()=>((await h.api('GET',agentPaths.invocation(invBRes.body.data.invocationId))).body.data.state==='injected'));
 assert.equal(h.nodes[1].agentCalls.length,1);
});

test('Worker partition, lease expiry, reincarnation (boot-2) and quarantine reconciliation verify immutable Docker retirement receipts and restore capacity',async t=>{
 const h=await createFullStack(t,{leaseMs:600,heartbeatMs:120});
 const sesA=await h.createSession('reincarnate-a');
 const sesB=await h.createSession('reincarnate-b');
 assert.equal(h.gateway.placement.status().heldSlots,2);

 // Partition worker-a by stopping its server and waiting for the lease to expire.
 await h.nodes[0].current.stop();
 await until(()=>h.gateway.registry.getSession('a',sesA.sessionId).state==='cleanup-failed');
 await delay(650);
 assert.equal(h.gateway.placement.status().quarantined,1);
 assert.equal(h.gateway.placement.status().heldSlots,2);
 assert.equal(h.gateway.registry.getSession('a',sesA.sessionId).holdsQuota,true);

 // Reincarnate worker-a as boot-worker-a-2 over the same node SQLite and retirement stores.
 const rebooted=await h.nodes[0].boot('boot-worker-a-2');
 const newClient=new ClusterRpcClient({endpoint:rebooted.endpoint,serverName:'worker-a.test',serverSha256:h.pins['worker-a'],tls:readClusterTestTls(h.pki,'controller')});
 const reconnected=await h.gateway.operations.reconnectWorker('worker-a',{incarnation:'boot-worker-a-2',client:newClient});
 assert.equal(reconnected.available,true);
 assert.equal(reconnected.lease.generation,2);

 // Before reconciling quarantined generation-1 sessions, worker-a is in 'recovering' mode in ClusterPlacementStore.
 const nodeSnapBefore=h.gateway.operations.snapshot().placement.nodes.find(n=>n.nodeId==='worker-a');
 assert.equal(nodeSnapBefore.mode,'recovering');
 assert.equal(nodeSnapBefore.sessions.quarantined,1);

 // Reconcile quarantined sessions across Gateway Registry and ClusterPlacementStore.
 const reconciled=await h.gateway.reconcile({nodeId:'worker-a'});
 assert.equal(reconciled.clusterRecovery.closed,1);
 assert.equal(reconciled.clusterRecovery.unconfirmed,0);
 assert.equal(h.gateway.registry.getSession('a',sesA.sessionId).state,'closed');
 assert.equal(h.gateway.registry.getSession('a',sesA.sessionId).holdsQuota,false);

 // worker-a is now automatically promoted from 'recovering' to 'active' and accepts new generation-2 sessions.
 const nodeSnapAfter=h.gateway.operations.snapshot().placement.nodes.find(n=>n.nodeId==='worker-a');
 assert.equal(nodeSnapAfter.mode,'active');
 assert.equal(nodeSnapAfter.heldSlots,0);

 h.gateway.operations.drainNode('worker-b');
 const sesA2=await h.createSession('reincarnate-a-gen2');
 const routeA2=h.gateway.placement.route({tenantId:'a',sessionId:sesA2.sessionId,version:VERSION});
 assert.equal(routeA2.nodeId,'worker-a');
 assert.equal(routeA2.generation,2);

 for(const s of [sesB,sesA2]){
  await h.api('DELETE','/v1/sessions/'+s.sessionId);
  await until(()=>h.gateway.registry.getSession('a',s.sessionId).state==='closed');
 }
 assert.equal(h.gateway.placement.status().heldSlots,0);
});

test('controller restart quarantines all prior active placements and gateway.reconcile() retires them across reincarnated Docker Workers',async t=>{
 const h=await createFullStack(t,{leaseMs:800,heartbeatMs:150});
 const sesA=await h.createSession('restart-ctrl-a');
 const sesB=await h.createSession('restart-ctrl-b');
 assert.equal(h.gateway.placement.status().heldSlots,2);

 // Stop both workers first so controller shutdown leaves sesA and sesB unconfirmed/reserved on disk.
 for(const node of h.nodes)await node.current.stop();
 const oldShutdown=await h.gateway.shutdown();
 assert.equal(oldShutdown.status,'unconfirmed');

 // Re-assemble the public Gateway while workers are still unreachable: prior active sessions are quarantined and hold quota.
 await h.startGateway(h.nodes.map(n=>n.spec()));
 assert.equal(h.gateway.placement.status().quarantined,2);
 assert.equal(h.gateway.placement.status().heldSlots,2);
 assert.equal(h.gateway.registry.stats().reservedSessions,2);
 assert.equal(h.gateway.registry.getSession('a',sesA.sessionId).holdsQuota,true);
 assert.equal(h.gateway.registry.getSession('a',sesB.sessionId).holdsQuota,true);

 // Boot new worker incarnations (their local startup recovery retires the orphaned containers and persists .retirement.json receipts).
 for(const node of h.nodes){
  const rebooted=await node.boot('boot-'+node.nodeId+'-after-ctrl-restart');
  const client=new ClusterRpcClient({endpoint:rebooted.endpoint,serverName:node.nodeId+'.test',serverSha256:h.pins[node.nodeId],tls:readClusterTestTls(h.pki,'controller')});
  const rec=await h.gateway.operations.reconnectWorker(node.nodeId,{incarnation:rebooted.incarnation,client});
  assert.equal(rec.available,true);
  assert.equal(rec.lease.generation,2);
 }

 // Prior sessions are never replayed; full reconciliation verifies retirement receipts and frees all slots.
 assert.equal(h.nodes[0].starts.length,1);
 assert.equal(h.nodes[1].starts.length,1);
 const reconciled=await h.gateway.reconcile();
 assert.equal(reconciled.registryRecovery.status,'closed');
 assert.equal(reconciled.clusterRecovery.closed,2);
 assert.equal(reconciled.clusterRecovery.unconfirmed,0);
 assert.equal(h.gateway.registry.getSession('a',sesA.sessionId).state,'closed');
 assert.equal(h.gateway.registry.getSession('a',sesB.sessionId).state,'closed');
 assert.equal(h.gateway.placement.status().heldSlots,0);
 assert.equal(h.gateway.placement.status().quarantined,0);
 assert.equal(h.gateway.registry.stats().reservedSessions,0);

 // Both nodes are active at generation 2 and can serve fresh sessions.
 const fresh=await h.createSession('fresh-after-ctrl-restart');
 assert.equal(fresh.state,'ready');
 await h.api('DELETE','/v1/sessions/'+fresh.sessionId);
 await until(()=>h.gateway.registry.getSession('a',fresh.sessionId).state==='closed');
 assert.equal(h.gateway.operations.archiveClosedSessions({archiveDir:h.archiveDir}).archived,3);
});
