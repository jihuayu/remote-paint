// Actual provider/Registry/Sqlite/source/witness stores. Engine, effects,
// process namespace and attach exit observations are structural fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {PassThrough,Writable} from 'node:stream';
import {DockerSessionProvider} from '../../service/docker-session-provider.mjs';
import {DockerMetadataClient} from '../../service/docker-metadata-client.mjs';
import {DockerEffectClient} from '../../service/docker-effect-session.mjs';
import {DockerAttachClient} from '../../service/docker-attach-client.mjs';
import {RuntimeWitnessStore} from '../../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../../service/runtime-retirement-store.mjs';
import {RuntimeDeploymentBindingStore} from '../../service/runtime-deployment-binding.mjs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {planDockerRuntime} from '../../service/docker-runtime-spec.mjs';
import {deriveNativeTransportKey} from '../../service/native-transport-key.mjs';
import {witness} from './runtime-witness-records.mjs';
import {records} from './session-store-records.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
export const pending=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
export const turn=()=>new Promise(setImmediate);
export async function wait(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Structural fixture observation deadline')),2000);})]);}finally{clearTimeout(timer);}}
export async function fixture(t,{generic=false,maxSourceLookups=2,sourceLookupTimeoutMs=5000,recovered=false}={}){
 const directory=await mkdtemp(join(tmpdir(),'rp-resolver-')),docs=new Map(),proxies=new Map(),calls=[],events=[],starts=[],hooks={},cleanup=[],networkId='f'.repeat(64),endpointId='1'.repeat(64),sandboxId='2'.repeat(64);
 const state={directory,docs,proxies,calls,events,starts,hooks,cleanup,durablePatch:null,provider:null,registry:null};let nextCid=1;
 class Metadata extends DockerMetadataClient {
  async inspectImage(){return {daemon:{id:'daemon-fixture'},document:{Config:{Env:['PATH=/usr/local/bin']}}};}
  async listRuntimeCandidates(){return {daemon:{id:'daemon-fixture'},containerIds:[...docs.keys()]};}
  async inspectContainer(selector,{signal}={}){const call={kind:'container',selector,signal};calls.push(call);await hooks.container?.(call);const document=docs.get(selector)??[...docs.values()].find(x=>x.Name==='/'+selector);return document?{found:true,daemon:{id:'daemon-fixture'},document:structuredClone(document)}:{found:false,daemon:{id:'daemon-fixture'},selector};}
  async inspectNetwork(id,{signal}={}){const call={kind:'network',networkId:id,signal};calls.push(call);await hooks.network?.(call);return {found:true,daemon:{id:'daemon-fixture'},document:{Id:networkId,Name:'bridge',Driver:'bridge',Scope:'local',IPAM:{Config:[{Subnet:'198.19.192.0/23',Gateway:'198.19.192.1'}]},Containers:Object.fromEntries([...docs].map(([cid,doc])=>[cid,{Name:doc.Name.slice(1),EndpointID:endpointId,IPv4Address:doc.NetworkSettings.Networks.bridge.IPAddress+'/23'}]))}};}
 }
 class Store extends SqliteSessionStore {loadRuntime(options){const value=super.loadRuntime(options);return state.durablePatch?state.durablePatch(structuredClone(value)):value;}}
 class Witness extends RuntimeWitnessStore {read(value){const result=super.read(value);hooks.witness?.();return result;}}
 function document(plan,cid){const c=structuredClone(plan.create);return {Id:cid,Name:'/'+plan.containerName,Image:plan.imageId,Config:c,HostConfig:c.HostConfig,Mounts:c.HostConfig.Mounts.map(m=>({Type:'bind',Source:m.Source,Destination:m.Target,RW:false,Propagation:'rprivate'})),State:{Status:'running',Running:true,Pid:123,StartedAt:'2026-10-18T00:00:00.123456789Z',Paused:false,Restarting:false,Dead:false,OOMKilled:false},NetworkSettings:{Ports:{},SandboxID:sandboxId,Networks:{bridge:{NetworkID:networkId,EndpointID:endpointId,IPAddress:'198.19.192.'+(nextCid+3),IPPrefixLen:23,Gateway:'198.19.192.1'}}}};}
 class Effects extends DockerEffectClient {
  async open({kind,plan,containerId}){const before=docs.get(containerId);return {inspect:()=>({inspection:before?{found:true,daemon:{id:'daemon-fixture'},document:structuredClone(before)}:null,absent:!before}),perform:async authorize=>{const receipt=authorize();if(kind==='create'){const cid=(nextCid++).toString(16).padStart(64,'0');docs.set(cid,document(plan,cid));return {containerId:cid};}if(kind==='start')return {};docs.delete(containerId);return {kind:'remove',containerId,daemonId:'daemon-fixture',connectionId:randomUUID(),httpStatus:before?204:404,authorizationRevision:receipt.revision,effectAttempted:!!before,alreadyAbsent:!before};},close:async()=>({status:'closed'})};}
 }
 class Attach extends DockerAttachClient {
  open({plan,containerId}){const output=new PassThrough(),done=pending();let ended=false,bytes='';const send=v=>output.write(JSON.stringify({protocol:'session-worker-v1',sessionId:plan.sessionId,...v})+'\n');
   const finish=()=>{if(ended)return;ended=true;output.end();done.resolve({code:0,signal:null});};
   const input=new Writable({write(chunk,_encoding,callback){try{bytes+=chunk;for(let n;(n=bytes.indexOf('\n'))>=0;){const msg=JSON.parse(bytes.slice(0,n));bytes=bytes.slice(n+1);if(msg.type==='Start'){starts.push({sessionId:plan.sessionId,ownerKey:msg.ownerKey,expectedKey:deriveNativeTransportKey({ownerKey:msg.ownerKey,sessionId:plan.sessionId,tenantId:plan.tenantId,region:plan.region})});send({type:'Ready',version:'native-abi-structural-fixture-v1'});}if(msg.type==='Close'){send({type:'Closed',reason:'released',code:null});finish();}}callback();}catch(error){callback(error);}}});
   const proxy={input,output,clientDone:done.promise,attached:Promise.resolve({containerId}),status:()=>({pid:null,transportExited:ended}),stop:async()=>{finish();return {status:'closed'};},lose:()=>{output.emit('end');finish();}};proxies.set(plan.sessionId,proxy);queueMicrotask(()=>send({type:'WorkerHello',runtimeWitness:witness()}));return proxy;
  }
 }
 const store=new Store({path:join(directory,'state.sqlite')}),metadata=new Metadata({socketPath:join(directory,'unused-engine.sock'),daemonId:'daemon-fixture'}),effects=new Effects({socketPath:join(directory,'unused-engine.sock'),daemonId:'daemon-fixture'}),attach=new Attach({socketPath:join(directory,'unused-engine.sock'),daemonId:'daemon-fixture',maxConcurrent:4}),witnessStore=new Witness({directory:join(directory,'witness')}),retirementStore=new RuntimeRetirementStore({directory:join(directory,'retirement'),witnessStore});
 Object.assign(state,{store,metadata,effects,attach,witnessStore,retirementStore});
 t.after(async()=>{for(const release of cleanup)release();state.durablePatch=null;delete hooks.container;delete hooks.network;delete hooks.witness;try{await state.registry?.shutdown();await state.provider?.shutdown();}finally{for(const proxy of proxies.values())await proxy.stop();await attach.close();await effects.close();await metadata.close();store.close();await rm(directory,{recursive:true,force:true});}});
 const projectPath=join(directory,'project'),browserPath=join(directory,'browser');await mkdir(projectPath);await mkdir(browserPath);
 const files={},required=generic?['worker.mjs']:['service/native-session-worker.mjs','service/session-worker.mjs','service/native-transport-key.mjs','service/native-session-resource.mjs','service/linux-runtime-witness.mjs','live.mjs','live/transport.mjs','native/bin/aarch64-unknown-linux-gnu/remote-paint-broker'];
 for(const n of required){const p=join(projectPath,n),bytes=Buffer.from('Explicit structural source placeholder; never executed\n');await mkdir(dirname(p),{recursive:true});await writeFile(p,bytes);files[n]=sha(bytes);}await writeFile(join(browserPath,'headless_shell'),'Explicit structural browser placeholder; never executed\n');
 const projectManifest=join(directory,'project-manifest.json'),browserManifest=join(directory,'browser-manifest.json'),pb=JSON.stringify({schema:'runtime-source-files-v1',files}),bb=JSON.stringify({schema:'runtime-source-files-v1',files:generic?{}:{headless_shell:sha('Explicit structural browser placeholder; never executed\n')}});await writeFile(projectManifest,pb);await writeFile(browserManifest,bb);
 const configuration={region:'test',deploymentId:'deployment-fixture',daemonId:'daemon-fixture',imageId:'sha256:'+'b'.repeat(64),projectPath,browserPath,projectManifestSha256:sha(pb),browserManifestSha256:sha(bb),imageEnvironment:['PATH=/usr/local/bin'],...(generic?{workerEntry:'worker.mjs'}:{})};
 const bindingDirectory=join(directory,'binding');await RuntimeDeploymentBindingStore.bootstrap({directory:bindingDirectory,store,metadata,configuration});
 let recoveredArgs;
 if(recovered){const batch=records('recovered'),owner=Symbol('structural-old-owner'),sessionId=batch.sessions[0].sessionId,tenantId=batch.sessions[0].tenant;store.commit(batch);store.claimRuntimeProvider(owner,{region:'test',deploymentId:configuration.deploymentId,daemonId:configuration.daemonId,createdAt:new Date().toISOString()});const plan=planDockerRuntime({sessionId,tenantId,region:'test',ownerKeyHash:'a'.repeat(64)},configuration),cid='e'.repeat(64),at=new Date().toISOString();let row={sessionId,tenant:tenantId,region:'test',deploymentId:plan.deploymentId,daemonId:plan.daemonId,ownerKeyHash:plan.ownerKeyHash,specDigest:plan.specDigest,imageId:plan.imageId,containerName:plan.containerName,containerId:null,state:'intent',requestStarted:false,startDispatch:'not-requested',version:null,closeReason:null,retirement:null,createdAt:at,updatedAt:at};store.commitRuntime(row,{owner});for(const patch of [{state:'requested',requestStarted:true},{state:'created',containerId:cid},{startDispatch:'requested'}]){row={...row,...patch};store.commitRuntime(row,{owner});}docs.set(cid,document(plan,cid));const receipt=witnessStore.persist({plan,inspection:{found:true,daemon:{id:plan.daemonId},document:docs.get(cid)},witness:witness()});row={...row,startDispatch:{schema:'runtime-start-witness-v1',engineStartedAt:docs.get(cid).State.StartedAt,witnessSha256:receipt.witnessSha256,evidenceSha256:receipt.evidenceSha256}};store.commitRuntime(row,{owner});store.commitRuntime({...row,state:'ready',version:'native-abi-structural-fixture-v1'},{owner});store.releaseRuntimeProvider(owner);recoveredArgs={sessionId,tenantId,region:'test',version:'native-abi-structural-fixture-v1'};}
 const provider=state.provider=new DockerSessionProvider({store,deploymentBinding:new RuntimeDeploymentBindingStore({directory:bindingDirectory}),configuration,metadata,effects,attach,witnessStore,retirementStore,projectManifest,browserManifest,maxSessions:4,maxSourceLookups,sourceLookupTimeoutMs,onEvent:e=>events.push(e)});await provider.initialize();
 if(!recovered)state.registry=new SessionRegistry({providers:new Map([['test',provider]]),defaultRegion:'test',store,globalQuota:4,tenantQuota:4});
 state.ready=async()=>{const op=state.registry.create('tenant-a',{ttlSeconds:60},{idempotencyKey:randomUUID()}),end=performance.now()+5000;while(state.registry.getOperation('tenant-a',op.operationId).status==='pending'){assert.ok(performance.now()<end,'Structural provider fixture start deadline');await turn();}const row=state.registry.requireReady('tenant-a',op.sessionId);return {sessionId:row.sessionId,tenantId:'tenant-a',region:'test',version:row.version};};
 state.resolve=args=>{assert.equal(typeof provider.resolveSource,'function','Provider must expose the owned private resolver');return provider.resolveSource(args);};
 state.hold=kind=>{const gate=pending(),entered=pending();let count=0;hooks[kind]=async()=>{if(count++===0){entered.resolve();await gate.promise;}};cleanup.push(gate.resolve);return {gate,entered};};
 state.recoveredArgs=recoveredArgs;return state;
}
