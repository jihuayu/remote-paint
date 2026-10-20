import {captureOwnedNativeEndpoint} from './native-endpoint.mjs';
import {deriveNativeTransportKey} from './native-transport-key.mjs';
import {copyRuntimeWitnessBinding,isRuntimeWitnessBinding} from './runtime-witness-binding.mjs';
import {randomBytes,createHash} from 'node:crypto';
import {SqliteSessionStore} from './session-store.mjs';
import {RuntimeDeploymentBindingStore} from './runtime-deployment-binding.mjs';
import {DockerMetadataClient} from './docker-metadata-client.mjs';
import {DockerEffectClient} from './docker-effect-session.mjs';
import {DockerAttachClient} from './docker-attach-client.mjs';
import {SessionWorkerChannel} from './session-worker-channel.mjs';
import {AgentRpcError,captureAgentRequest,agentReplyExpectation,captureAgentResult} from './agent-rpc.mjs';
import {RuntimeWitnessStore} from './runtime-witness-store.mjs';
import {RuntimeRetirementStore} from './runtime-retirement-store.mjs';
import {planDockerRuntime,verifyDockerRuntime,verifyDockerRuntimeOwnership} from './docker-runtime-spec.mjs';
import {verifyRuntimeSourceManifest} from './runtime-source-manifest.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),sink=()=>{};
const id=v=>typeof v==='string'&&/^ses_[A-Za-z0-9_-]{1,124}$/.test(v),tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','startup-failed','startup-cancelled','worker-unavailable']);
export class DockerSessionProviderError extends Error {constructor(code){super('Owned Session runtime is unavailable');this.name='DockerSessionProviderError';this.code=code;}}
const fail=code=>new DockerSessionProviderError(code);
// This provider owns control/lifetime only; drawing data never enters it.
// Native/Registry/recovery qualification is separate from its Node fixtures.
export class DockerSessionProvider {
 #store;#binding;#config;#metadata;#effects;#attach;#witness;#retirement;#manifests;#max;#maxCloseAttempts;#event;#owner=Symbol('docker-session-provider');#claimed=false;
 #sourceLimit;#sourceMs;#resolving=0;
 #phase='new';#fault=null;#initializing;#entries=new Map();#queue=Promise.resolve();#orphans=[];#shutdownPromise;#listeners=new Set();
 constructor({store,deploymentBinding,configuration,metadata,effects,attach,witnessStore,retirementStore,projectManifest,browserManifest,maxSessions=attach?.status().maxConcurrent,maxCloseAttempts=4,maxSourceLookups=metadata?.status().maxConcurrent,sourceLookupTimeoutMs=5000,onEvent=sink}={}){
  if(!(store instanceof SqliteSessionStore)||!(deploymentBinding instanceof RuntimeDeploymentBindingStore)||!(metadata instanceof DockerMetadataClient)||!(effects instanceof DockerEffectClient)||!(attach instanceof DockerAttachClient)||!(witnessStore instanceof RuntimeWitnessStore)||!(retirementStore instanceof RuntimeRetirementStore)||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>attach.status().maxConcurrent||!Number.isSafeInteger(maxCloseAttempts)||maxCloseAttempts<1||maxCloseAttempts>16||!Number.isSafeInteger(maxSourceLookups)||maxSourceLookups<1||maxSourceLookups>metadata.status().maxConcurrent||!Number.isSafeInteger(sourceLookupTimeoutMs)||sourceLookupTimeoutMs<20||sourceLookupTimeoutMs>30000||typeof onEvent!=='function')throw new TypeError('Configure explicit owned runtime dependencies and finite capacity');
  deploymentBinding.open({store,configuration});this.#store=store;this.#binding=deploymentBinding;this.#config=Object.freeze(structuredClone(configuration));this.#metadata=metadata;this.#effects=effects;this.#attach=attach;this.#witness=witnessStore;this.#retirement=retirementStore;this.#manifests={project:projectManifest,browser:browserManifest};this.#max=maxSessions;this.#maxCloseAttempts=maxCloseAttempts;this.#sourceLimit=maxSourceLookups;this.#sourceMs=sourceLookupTimeoutMs;this.#event=onEvent;Object.freeze(this);
 }
 #emit(type,entry=null,extra={}){const value=Object.freeze({type,...(entry?{sessionId:entry.row?.sessionId??entry.sessionId,tenantId:entry.row?.tenant??entry.tenantId,containerId:entry.row?.containerId??null}:{}),...extra});try{const result=this.#event(value);if(result?.then)void Promise.resolve(result).catch(sink);}catch{}}
 #storageFault(error){if(['STATE_IDENTITY','STATE_CLOSED','STATE_CORRUPT','STATE_WRITE','STATE_RUNTIME_WRITE'].includes(error?.code)&&!this.#fault){this.#fault='PROVIDER_STORAGE';this.#phase='unavailable';for(const entry of this.#entries.values())entry.streamKey=null;queueMicrotask(()=>{for(const entry of this.#entries.values())if(entry.row?.state!=='retired')this.#unavailable(entry);});}return error;}
 #snapshot(){try{return this.#store.loadRuntime({owner:this.#owner});}catch(e){throw this.#storageFault(e);}}
 #find(sessionId){return this.#snapshot().allocations.find(x=>x.sessionId===sessionId)??null;}
 #write(entry,update){try{const current=entry.row,next={...current,...update,updatedAt:new Date(Math.max(Date.now(),Date.parse(current.updatedAt))).toISOString()},receipt=this.#store.commitRuntime(next,{owner:this.#owner});entry.row=receipt.allocation;return receipt;}catch(e){throw this.#storageFault(e);}}
 #authorization(entry){const snapshot=this.#snapshot(),allocation=snapshot.allocations.find(x=>x.sessionId===entry.row.sessionId);if(!allocation)throw fail('PROVIDER_OWNERSHIP');return {revision:snapshot.revision,allocation};}
 #check(entry){if(entry.closing||entry.controller.signal.aborted||this.#phase==='stopping'||this.#phase==='closed'||this.#fault)throw fail('PROVIDER_CANCELLED');}
 async #sources(){this.#binding.open({store:this.#store,configuration:this.#config});const worker=this.#config.workerEntry??'service/native-session-worker.mjs',native=worker==='service/native-session-worker.mjs';const [project,browser]=await Promise.all([verifyRuntimeSourceManifest({root:this.#config.projectPath,manifest:this.#manifests.project,expectedSha256:this.#config.projectManifestSha256,requiredFiles:native?[worker,'service/session-worker.mjs','service/native-transport-key.mjs','service/native-session-resource.mjs','service/linux-runtime-witness.mjs','live.mjs','live/transport.mjs','native/bin/aarch64-unknown-linux-gnu/remote-paint-broker']:[worker]}),verifyRuntimeSourceManifest({root:this.#config.browserPath,manifest:this.#manifests.browser,expectedSha256:this.#config.browserManifestSha256,requiredFiles:native?['headless_shell']:[]})]);return {project,browser};}
 async #preflight(){await this.#sources();const image=await this.#metadata.inspectImage(this.#config.imageId);if(!same(image.document.Config?.Env??[],this.#config.imageEnvironment))throw fail('PROVIDER_IMAGE_ENVIRONMENT');}
 async #inventory(){const snapshot=this.#snapshot(),known=new Set(snapshot.allocations.filter(x=>x.containerId).map(x=>x.containerId)),inventory=await this.#metadata.listRuntimeCandidates({deploymentId:this.#config.deploymentId,region:this.#config.region});this.#orphans=inventory.containerIds.filter(x=>!known.has(x));return snapshot;}
 initialize(){
  if(['stopping','closed'].includes(this.#phase))return Promise.reject(fail('PROVIDER_CLOSED'));if(this.#initializing)return this.#initializing.then(()=>this.status());if(this.#phase!=='new')return Promise.reject(fail('PROVIDER_CLOSED'));this.#phase='initializing';
  this.#initializing=(async()=>{try{this.#binding.open({store:this.#store,configuration:this.#config});this.#store.claimRuntimeProvider(this.#owner,{region:this.#config.region,deploymentId:this.#config.deploymentId,daemonId:this.#config.daemonId,createdAt:new Date().toISOString()});this.#claimed=true;await this.#preflight();if(this.#phase!=='initializing')throw fail('PROVIDER_CLOSED');const snapshot=await this.#inventory();if(this.#phase!=='initializing')throw fail('PROVIDER_CLOSED');for(const row of snapshot.allocations)if(row.state!=='retired')this.#entries.set(row.sessionId,{row,sessionId:row.sessionId,tenantId:row.tenant,recovered:true,streamKey:null,closing:false,controller:new AbortController(),channel:null,proxy:null,flow:null,closePromise:null,closeAttempts:0,closeSettled:null});this.#phase=this.#entries.size||this.#orphans.length?'recovery-required':'available';this.#emit('initialized',null,{phase:this.#phase,orphans:this.#orphans.length});return this.status();}catch{if(!['stopping','closed'].includes(this.#phase)){this.#fault='PROVIDER_INITIALIZATION';this.#phase='unavailable';}throw fail(this.#fault??'PROVIDER_CLOSED');}})();void this.#initializing.catch(sink);return this.#initializing;
 }
 status(){return Object.freeze({phase:this.#phase,available:this.#phase==='available'&&!this.#fault,activeRuntimes:[...this.#entries.values()].filter(x=>x.row?.state!=='retired').length,ownedOrphanCandidates:this.#orphans.length,activeSourceLookups:this.#resolving,maxSourceLookups:this.#sourceLimit,sourceLookupDeadlineMs:this.#sourceMs,failure:this.#fault});}
 subscribeUnavailable(callback){if(typeof callback!=='function')throw new TypeError('Expected trusted availability callback');this.#listeners.add(callback);return()=>this.#listeners.delete(callback);}
 sessionStatus({sessionId,tenantId}={}){const entry=this.#entries.get(sessionId);if(!entry||entry.tenantId!==tenantId)throw fail('PROVIDER_SESSION_UNKNOWN');return Object.freeze({available:!this.#fault&&!['stopping','closed'].includes(this.#phase)&&!entry.closing&&entry.row?.state==='ready'&&entry.channel?.status().available===true,runtimeState:entry.row?.state??'not-dispatched',channel:entry.channel?.status()??null,retirementConfirmed:entry.row?.state==='retired',cleanupAttempts:entry.closeAttempts,cleanupLimit:this.#maxCloseAttempts,cleanupInFlight:entry.closePromise!==null&&entry.closeSettled===null});}
 #unavailable(entry){entry.streamKey=null;if(entry.closing)return;entry.closing=true;entry.controller.abort();this.#emit('unavailable',entry);for(const listener of this.#listeners){try{const result=listener(Object.freeze({sessionId:entry.sessionId,tenantId:entry.tenantId,region:this.#config.region}));if(result?.then)void Promise.resolve(result).catch(sink);}catch{}}void this.close({sessionId:entry.sessionId,tenantId:entry.tenantId,region:this.#config.region,reason:'worker-unavailable'});}
 async #observeAbsence(entry,reconcile=false){
  const signal=AbortSignal.timeout(5000);
  for(let n=0;n<32;n++){
   const value=await this.#metadata.inspectContainer(entry.row.containerId,{signal});if(!value.found)return value;
   verifyDockerRuntimeOwnership(entry.plan,value,{containerId:entry.row.containerId});
   if(!reconcile||n===31)throw fail('PROVIDER_RETIREMENT_UNCONFIRMED');
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw fail('PROVIDER_RETIREMENT_UNCONFIRMED');
 }
 #closingFence(entry,signal=null){
  if(!this.#claimed||this.#fault||!entry.closing||entry.row?.state!=='closing'||signal?.aborted)throw fail('PROVIDER_CLOSING_WITNESS_FENCE');
  const receipt=this.#authorization(entry);if(receipt.allocation.state!=='closing'||receipt.allocation.containerId!==entry.row.containerId)throw fail('PROVIDER_CLOSING_WITNESS_FENCE');return receipt;
 }
 #bindClosingWitness(entry,inspection,saved,signal=null){
  this.#closingFence(entry,signal);const binding=copyRuntimeWitnessBinding({schema:'runtime-start-witness-v1',engineStartedAt:inspection.document.State.StartedAt,witnessSha256:saved.receipt.witnessSha256,evidenceSha256:saved.receipt.evidenceSha256});
  try{const result=this.#store.bindRuntimeClosingWitness(entry.sessionId,binding,{owner:this.#owner});entry.row=result.allocation;}catch(error){throw this.#storageFault(error);}
  this.#emit('closing-witness-bound',entry);return saved.receipt;
 }
 async #prepareClosingWitness(entry){
  if(isRuntimeWitnessBinding(entry.row.startDispatch)||!['requested','legacy-unknown'].includes(entry.row.startDispatch))return;
  this.#closingFence(entry);const inspection=await this.#metadata.inspectContainer(entry.row.containerId);if(!inspection.found)return;
  const profile=verifyDockerRuntime(entry.plan,inspection,{containerId:entry.row.containerId});if(profile.state==='created')return;
  try{const saved=this.#witness.read({plan:entry.plan,inspection});this.#bindClosingWitness(entry,inspection,saved);this.#emit('closing-witness-adopted',entry);return;}catch(error){if(error.code!=='WITNESS_MISSING')throw error;}
  if(!profile.running||profile.pid<=0)return;
  await this.#preflight();this.#closingFence(entry);if(entry.channel)await entry.channel.close();if(entry.proxy&&(await entry.proxy.stop()).status!=='closed')throw fail('PROVIDER_PROXY_UNCONFIRMED');
  entry.proxy=this.#attach.open({plan:entry.plan,containerId:entry.row.containerId});
  entry.channel=new SessionWorkerChannel({sessionId:entry.sessionId,region:this.#config.region,ownerKey:null,closeOnly:true,input:entry.proxy.input,output:entry.proxy.output,clientDone:entry.proxy.clientDone,requireRuntimeWitness:true,runtimeBinding:{containerId:entry.row.containerId,daemonId:this.#config.daemonId,specDigest:entry.plan.specDigest},onRuntimeWitness:async(witness,{signal})=>{
   this.#closingFence(entry,signal);const current=await this.#metadata.inspectContainer(entry.row.containerId,{signal});this.#closingFence(entry,signal);
   this.#witness.persist({plan:entry.plan,inspection:current,witness});const saved=this.#witness.read({plan:entry.plan,inspection:current});return this.#bindClosingWitness(entry,current,saved,signal);
  }});
  this.#emit('closing-witness-attached',entry,{proxyPid:entry.proxy.status().pid});
  try{await entry.proxy.attached;await entry.channel.waitForRuntimeWitness();const status=entry.channel.status();if(!status.closeOnly||status.startSent||status.available)throw fail('PROVIDER_CLOSING_WITNESS_FENCE');this.#emit('closing-witness-collected',entry);}finally{await entry.channel.close();if((await entry.proxy.stop()).status!=='closed')throw fail('PROVIDER_PROXY_UNCONFIRMED');}
 }
 create({sessionId,tenantId,region,url,ttlSeconds,signal}={}){
  if(!id(sessionId)||!tenant(tenantId)||region!==this.#config.region||typeof url!=='string'||url.length>8192||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>86400||signal!==undefined&&!(signal instanceof AbortSignal))return Promise.reject(fail('PROVIDER_REQUEST'));
  try{const parsed=new URL(url);if(url!=='about:blank'&&(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password))throw Error();}catch{return Promise.reject(fail('PROVIDER_REQUEST'));}
  if(!this.#claimed||['new','initializing','closed','stopping'].includes(this.#phase))return Promise.reject(fail('PROVIDER_ADMISSION'));try{if(this.#entries.has(sessionId)||this.#find(sessionId))return Promise.reject(fail('PROVIDER_DUPLICATE'));}catch{return Promise.reject(fail('PROVIDER_STORAGE'));}const entry={sessionId,tenantId,row:null,recovered:false,streamKey:null,closing:false,controller:new AbortController(),channel:null,proxy:null,flow:null,closePromise:null,closeAttempts:0,closeSettled:null,abort:null};this.#entries.set(sessionId,entry);
  entry.flow=(async()=>{let key='';try{
   if(this.#phase==='recovery-required')await this.#refreshAdmission();
   if(this.#phase!=='available'||this.#fault||[...this.#entries.values()].filter(x=>x.row?.state!=='retired').length>this.#max)throw fail('PROVIDER_ADMISSION');if(signal){entry.abort=()=>{entry.controller.abort();};signal.addEventListener('abort',entry.abort,{once:true});if(signal.aborted)entry.controller.abort();}this.#check(entry);
   key=randomBytes(32).toString('hex');entry.plan=planDockerRuntime({sessionId,tenantId,region,ownerKeyHash:sha(key)},this.#config);const at=new Date().toISOString();entry.row=this.#store.commitRuntime({sessionId,tenant:tenantId,region,deploymentId:this.#config.deploymentId,daemonId:this.#config.daemonId,ownerKeyHash:entry.plan.ownerKeyHash,specDigest:entry.plan.specDigest,imageId:this.#config.imageId,containerName:entry.plan.containerName,containerId:null,state:'intent',requestStarted:false,startDispatch:'not-requested',version:null,closeReason:null,retirement:null,createdAt:at,updatedAt:at},{owner:this.#owner}).allocation;this.#emit('intent',entry);
   const allocation=this.#queue.then(async()=>{this.#check(entry);await this.#preflight();this.#check(entry);const snapshot=await this.#inventory();if(this.#orphans.length||snapshot.allocations.some(x=>x.state!=='retired'&&this.#entries.get(x.sessionId)?.recovered))throw fail('PROVIDER_RECOVERY_REQUIRED');const operation=await this.#effects.open({kind:'create',plan:entry.plan,signal:entry.controller.signal});try{this.#check(entry);const result=await operation.perform(()=>{this.#check(entry);return this.#write(entry,{state:'requested',requestStarted:true});});this.#emit('allocation-observed',entry,{containerId:result.containerId});const state=entry.closing?'closing':'created';this.#write(entry,{state,containerId:result.containerId});this.#emit('created',entry);}finally{if((await operation.close()).status!=='closed')throw fail('PROVIDER_EFFECT_TRANSPORT');}});this.#queue=allocation.catch(sink);await allocation;this.#check(entry);
   await this.#preflight();this.#check(entry);const start=await this.#effects.open({kind:'start',plan:entry.plan,containerId:entry.row.containerId,signal:entry.controller.signal});try{const result=await start.perform(()=>{this.#check(entry);if(this.#snapshot().recoveryRequired.includes(sessionId))throw fail('PROVIDER_RECOVERY_REQUIRED');const receipt=this.#write(entry,{startDispatch:'requested'});this.#emit('engine-start-dispatch',entry);this.#check(entry);return receipt;});this.#emit('engine-started',entry);}finally{if((await start.close()).status!=='closed')throw fail('PROVIDER_EFFECT_TRANSPORT');}this.#check(entry);
   entry.streamKey=(this.#config.workerEntry??'service/native-session-worker.mjs')==='service/native-session-worker.mjs'?deriveNativeTransportKey({ownerKey:key,sessionId,tenantId,region}):null;
   entry.proxy=this.#attach.open({plan:entry.plan,containerId:entry.row.containerId});entry.channel=new SessionWorkerChannel({sessionId,region,tenantId,ownerKey:key,maxFrameBytes:8192,input:entry.proxy.input,output:entry.proxy.output,clientDone:entry.proxy.clientDone,onUnavailable:()=>this.#unavailable(entry),requireRuntimeWitness:true,runtimeBinding:{containerId:entry.row.containerId,daemonId:this.#config.daemonId,specDigest:entry.plan.specDigest},onRuntimeWitness:async(witness,{signal:gateSignal})=>{this.#check(entry);const inspection=await this.#metadata.inspectContainer(entry.row.containerId,{signal:gateSignal});this.#check(entry);const receipt=this.#witness.persist({plan:entry.plan,inspection,witness});this.#witness.read({plan:entry.plan,inspection});this.#emit('witness-file-published',entry);this.#check(entry);this.#write(entry,{startDispatch:copyRuntimeWitnessBinding({schema:'runtime-start-witness-v1',engineStartedAt:inspection.document.State.StartedAt,witnessSha256:receipt.witnessSha256,evidenceSha256:receipt.evidenceSha256})});this.#emit('witness-persisted',entry);this.#check(entry);return receipt;}});key='';this.#emit('attached',entry,{proxyPid:entry.proxy.status().pid});await entry.proxy.attached;this.#check(entry);const result=await entry.channel.start({url,region,ttlSeconds},{signal:entry.controller.signal});this.#check(entry);if(!entry.channel.status().available)throw fail('PROVIDER_WORKER_UNAVAILABLE');this.#write(entry,{state:'ready',version:result.version});this.#emit('ready',entry);this.#check(entry);return Object.freeze({version:result.version});
  }catch(e){entry.streamKey=null;throw e instanceof DockerSessionProviderError?e:fail('PROVIDER_START_FAILED');}finally{key='';if(entry.abort)signal.removeEventListener('abort',entry.abort);entry.abort=null;}})();void entry.flow.catch(sink);return entry.flow;
 }
 // A current backend capability only. Recovered Ready rows never regain a
 // stream key. Metadata is a time-separated observation, not a health proof.
 #sourceFence(entry,request,row,signal){
  if(!this.#claimed||this.#fault||['new','initializing','stopping','closed'].includes(this.#phase)||!entry||this.#entries.get(request.sessionId)!==entry||entry.recovered||entry.closing||entry.controller.signal.aborted||signal?.aborted||typeof entry.streamKey!=='string'||entry.streamKey.length!==64||entry.tenantId!==request.tenantId||entry.row?.region!==request.region||entry.row?.state!=='ready'||entry.row.version!==request.version||row&&entry.row!==row||entry.channel?.status().available!==true)throw fail('PROVIDER_SOURCE_UNAVAILABLE');
  const current=this.#authorization(entry).allocation;
  if(!same(current,entry.row))throw fail('PROVIDER_SOURCE_UNAVAILABLE');return entry.row;
 }
 async resolveSource(value){
  let admitted=false,timer,operationController;
  try{
   const keys=['tenantId','sessionId','region','version'];
   if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw fail('PROVIDER_SOURCE_REQUEST');
   if(Object.hasOwn(value,'signal'))keys.push('signal');
   if(Reflect.ownKeys(value).length!==keys.length)throw fail('PROVIDER_SOURCE_REQUEST');
   const request={};for(const key of keys){const field=Object.getOwnPropertyDescriptor(value,key);if(!field||!Object.hasOwn(field,'value'))throw fail('PROVIDER_SOURCE_REQUEST');request[key]=field.value;}
   if(!id(request.sessionId)||!tenant(request.tenantId)||request.region!==this.#config.region||typeof request.version!=='string'||request.version.length<1||request.version.length>256||request.signal!==undefined&&!(request.signal instanceof AbortSignal))throw fail('PROVIDER_SOURCE_REQUEST');
   const entry=this.#entries.get(request.sessionId),row=this.#sourceFence(entry,request,null,request.signal);
   if(this.#resolving>=this.#sourceLimit)throw fail('PROVIDER_SOURCE_BUSY');
   this.#resolving++;admitted=true;
   operationController=new AbortController();timer=setTimeout(()=>operationController.abort(),this.#sourceMs);timer.unref();
   const end=performance.now()+this.#sourceMs,signal=AbortSignal.any([entry.controller.signal,operationController.signal,...(request.signal?[request.signal]:[])]),fence=()=>{if(performance.now()>=end)throw fail('PROVIDER_SOURCE_UNAVAILABLE');return this.#sourceFence(entry,request,row,signal);};
   const first=await this.#metadata.inspectContainer(row.containerId,{signal});fence();
   verifyDockerRuntime(entry.plan,first,{containerId:row.containerId});
   const networkId=first.document.NetworkSettings?.Networks?.bridge?.NetworkID;
   const networkInspection=await this.#metadata.inspectNetwork(networkId,{signal});fence();
   // Reobserve the container after the independent network inspection, then
   // read the witness bytes after every asynchronous operation has completed.
   const inspection=await this.#metadata.inspectContainer(row.containerId,{signal});fence();
   const saved=this.#witness.read({plan:entry.plan,inspection});fence();
   const endpoint=captureOwnedNativeEndpoint({plan:entry.plan,inspection,allocation:fence(),networkInspection,witnessReceipt:saved.receipt});fence();
   return Object.freeze({tenantId:request.tenantId,sessionId:request.sessionId,region:request.region,version:request.version,origin:endpoint.origin,streamOrigin:endpoint.streamOrigin,key:entry.streamKey});
  }catch(error){throw error instanceof DockerSessionProviderError&&error.code.startsWith('PROVIDER_SOURCE_')?error:fail('PROVIDER_SOURCE_UNAVAILABLE');}
  finally{clearTimeout(timer);operationController?.abort();if(admitted)this.#resolving--;}
 }
 // Trusted backend entry. Public callers still need independent tenant/Agent
 // authorization; the owner credential and Source URL/key never leave here.
 async agent(value){
  let submitted=false;
  try{
   const keys=['tenantId','sessionId','region','version','command'];if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new AgentRpcError('AGENT_INVALID_REQUEST','not-dispatched');
   for(const optional of ['signal','timeoutMs'])if(Object.hasOwn(value,optional))keys.push(optional);if(Reflect.ownKeys(value).length!==keys.length)throw new AgentRpcError('AGENT_INVALID_REQUEST','not-dispatched');
   const request={};for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))throw new AgentRpcError('AGENT_INVALID_REQUEST','not-dispatched');request[key]=descriptor.value;}
   if(!id(request.sessionId)||!tenant(request.tenantId)||request.region!==this.#config.region||typeof request.version!=='string'||!request.version.length||request.version.length>256||request.signal!==undefined&&!(request.signal instanceof AbortSignal))throw new AgentRpcError('AGENT_INVALID_REQUEST','not-dispatched');
   if(request.signal?.aborted)throw new AgentRpcError('AGENT_RPC_CANCELLED','not-dispatched');
   const entry=this.#entries.get(request.sessionId),row=this.#sourceFence(entry,request,null,request.signal),command=captureAgentRequest(request.command);
   if(command.context&&(command.context.binding.tenantId!==request.tenantId||command.context.binding.sessionId!==request.sessionId))throw new AgentRpcError('AGENT_INVALID_CONTEXT','not-dispatched');
   this.#sourceFence(entry,request,row,request.signal);const signal=AbortSignal.any([entry.controller.signal,...(request.signal?[request.signal]:[])]);submitted=true;
   const result=await entry.channel.agent(command,{signal,...(request.timeoutMs===undefined?{}:{timeoutMs:request.timeoutMs})});this.#sourceFence(entry,request,row,signal);
   return captureAgentResult(result,agentReplyExpectation(command),request);
  }catch(error){throw error instanceof AgentRpcError?error:new AgentRpcError('AGENT_UNAVAILABLE',submitted?'unknown':'not-dispatched');}
 }
 retryClose({sessionId,tenantId,region,reason='released'}={}){
  if(!id(sessionId)||!tenant(tenantId)||region!==this.#config.region||!reasons.has(reason))return Promise.resolve(Object.freeze({status:'unconfirmed'}));
  const entry=this.#entries.get(sessionId),request={sessionId,tenantId,region,reason};if(!entry)return this.close(request);if(entry.tenantId!==tenantId)return Promise.resolve(Object.freeze({status:'unconfirmed'}));
  if(!entry.closePromise||entry.closeSettled===null||entry.closeSettled==='closed')return this.close(request);
  if(!this.#claimed||this.#fault||['stopping','closed'].includes(this.#phase))return entry.closePromise;
  if(entry.closeAttempts>=this.#maxCloseAttempts)return Promise.resolve(Object.freeze({status:'unconfirmed',code:'PROVIDER_CLEANUP_LIMIT'}));
  entry.closePromise=null;entry.closeSettled=null;this.#emit('cleanup-retry',entry,{attempt:entry.closeAttempts+1});return this.close(request);
 }
 async #refreshAdmission(){
  if(this.#fault||['stopping','closed'].includes(this.#phase)||this.#phase!=='recovery-required'&&!this.#orphans.length)return;
  try{await this.#inventory();if(this.#fault||['stopping','closed'].includes(this.#phase))return;if(!this.#orphans.length&&[...this.#entries.values()].every(x=>!x.row||x.row.state==='retired'))this.#phase='available';}
  catch{if(!['stopping','closed'].includes(this.#phase))this.#phase='recovery-required';this.#emit('admission-recheck-unconfirmed');}
 }
 close({sessionId,tenantId,region,reason='released'}={}){
  if(!id(sessionId)||!tenant(tenantId)||region!==this.#config.region||!reasons.has(reason))return Promise.resolve({status:'unconfirmed'});let entry=this.#entries.get(sessionId);
  if(!entry){try{const row=this.#find(sessionId);if(!row){return Promise.resolve({status:this.#claimed&&!this.#fault&&this.#orphans.length===0?'closed':'unconfirmed'});}entry={row,sessionId,tenantId:row.tenant,recovered:true,streamKey:null,closing:false,controller:new AbortController(),flow:null,channel:null,proxy:null,closePromise:null,closeAttempts:0,closeSettled:null};this.#entries.set(sessionId,entry);}catch{return Promise.resolve({status:'unconfirmed'});}}
  if(entry.tenantId!==tenantId)return Promise.resolve({status:'unconfirmed'});entry.streamKey=null;if(entry.closePromise)return entry.closePromise;if(!this.#claimed||this.#fault||['stopping','closed'].includes(this.#phase)&&!entry.closing)return Promise.resolve(Object.freeze({status:'unconfirmed'}));if(entry.closeAttempts>=this.#maxCloseAttempts)return Promise.resolve(Object.freeze({status:'unconfirmed',code:'PROVIDER_CLEANUP_LIMIT'}));entry.closeAttempts++;entry.closeSettled=null;entry.closing=true;entry.controller.abort();
  entry.closePromise=Promise.resolve().then(async()=>{try{
   if(entry.row&&entry.row.state!=='retired'&&entry.row.state!=='closing')this.#write(entry,{state:'closing',closeReason:reason});try{await entry.flow;}catch{}if(!entry.row){this.#entries.delete(sessionId);return Object.freeze({status:'closed',notDispatched:true});}
   if(entry.row.state==='retired'){this.#retirement.read({plan:entry.plan??planDockerRuntime({sessionId,tenantId,region,ownerKeyHash:entry.row.ownerKeyHash},this.#config),containerId:entry.row.containerId,expectedSha256:entry.row.retirement.evidenceSha256});return Object.freeze({status:'closed',retirementConfirmed:true});}
   entry.plan??=planDockerRuntime({sessionId,tenantId,region,ownerKeyHash:entry.row.ownerKeyHash},this.#config);for(const k of ['specDigest','imageId','containerName'])if(entry.plan[k]!==entry.row[k])throw fail('PROVIDER_OWNERSHIP');if(entry.row.state!=='closing')this.#write(entry,{state:'closing',closeReason:reason});if(entry.row.requestStarted&&entry.row.containerId){try{await this.#prepareClosingWitness(entry);}catch(error){const failure=typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'PROVIDER_CLOSING_WITNESS';this.#emit('closing-witness-unconfirmed',entry,{failure});}}if(entry.channel)await entry.channel.close();
   let receipt;if(!entry.row.requestStarted){receipt=this.#retirement.persistNotDispatched({plan:entry.plan,closing:this.#authorization(entry)});}else{
    if(!entry.row.containerId){const found=await this.#metadata.inspectContainer(entry.plan.containerName);if(!found.found)throw fail('PROVIDER_UNKNOWN_ALLOCATION');const owned=verifyDockerRuntimeOwnership(entry.plan,found);this.#write(entry,{containerId:owned.containerId});}
    try{const saved=this.#retirement.read({plan:entry.plan,containerId:entry.row.containerId});receipt=saved.receipt;}catch(e){if(e.code!=='RETIREMENT_MISSING')throw e;}
    if(!receipt){
     const operation=await this.#effects.open({kind:'remove',plan:entry.plan,containerId:entry.row.containerId});let authorization,result,inspection,effectFailure=null;
     try{inspection=operation.inspect().inspection;try{result=await operation.perform(()=>authorization=this.#authorization(entry));}catch(error){effectFailure=error;}}finally{if((await operation.close()).status!=='closed')throw fail('PROVIDER_EFFECT_TRANSPORT');}
     const reconcile=!!effectFailure&&isRuntimeWitnessBinding(entry.row.startDispatch)&&(effectFailure.uncertain===true||[404,409].includes(effectFailure.status));
     if(effectFailure&&!reconcile)throw effectFailure;if(reconcile)this.#emit('absence-reconciling',entry,{effectStatus:Number.isInteger(effectFailure.status)?effectFailure.status:null});
     let absent=await this.#observeAbsence(entry,reconcile);if(entry.proxy&&(await entry.proxy.stop()).status!=='closed')throw fail('PROVIDER_PROXY_UNCONFIRMED');
     if(inspection&&result?.httpStatus===204){verifyDockerRuntime(entry.plan,inspection,{containerId:entry.row.containerId});receipt=this.#retirement.persistRemoved({plan:entry.plan,closing:authorization,inspection,removal:result,absence:absent});}
     else{
      if(!result||inspection||result.httpStatus!==404){
       if(!isRuntimeWitnessBinding(entry.row.startDispatch))throw fail('PROVIDER_RETIREMENT_UNCONFIRMED');
       const probe=await this.#effects.open({kind:'remove',plan:entry.plan,containerId:entry.row.containerId});try{if(!probe.inspect().absent)throw fail('PROVIDER_RETIREMENT_UNCONFIRMED');result=await probe.perform(()=>authorization=this.#authorization(entry));}finally{if((await probe.close()).status!=='closed')throw fail('PROVIDER_EFFECT_TRANSPORT');}absent=await this.#observeAbsence(entry);
      }
      if(result.httpStatus!==404||!result.alreadyAbsent||result.effectAttempted)throw fail('PROVIDER_RETIREMENT_UNCONFIRMED');this.#emit('absence-probed',entry);receipt=this.#retirement.persistAbsent({plan:entry.plan,closing:authorization,absenceProbe:result,absence:absent});
     }
    }
   }
   this.#retirement.read({plan:entry.plan,containerId:entry.row.containerId,expectedSha256:receipt.evidenceSha256});this.#write(entry,{state:'retired',retirement:{kind:receipt.kind,evidenceSha256:receipt.evidenceSha256}});this.#emit('retired',entry);await this.#refreshAdmission();return Object.freeze({status:'closed',retirementConfirmed:true});
  }catch(error){this.#phase=this.#phase==='stopping'?'stopping':'recovery-required';const failure=typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'PROVIDER_CLEANUP';this.#emit('cleanup-unconfirmed',entry,{failure});return Object.freeze({status:'unconfirmed'});}finally{if(entry.proxy)await entry.proxy.stop();}}).then(result=>{entry.closeSettled=result.status;return result;},()=>{entry.closeSettled='unconfirmed';if(!['stopping','closed'].includes(this.#phase))this.#phase='recovery-required';this.#emit('cleanup-unconfirmed',entry,{failure:'PROVIDER_PROXY_UNCONFIRMED'});return Object.freeze({status:'unconfirmed'});});this.#emit('closing',entry,{attempt:entry.closeAttempts});return entry.closePromise;
 }
 shutdown(){if(this.#shutdownPromise)return this.#shutdownPromise;this.#phase='stopping';for(const entry of this.#entries.values()){entry.streamKey=null;entry.closing=true;entry.controller.abort();}this.#shutdownPromise=(async()=>{const rows=await Promise.all([...this.#entries.values()].map(x=>this.close({sessionId:x.sessionId,tenantId:x.tenantId,region:this.#config.region,reason:'registry-shutdown'})));if(this.#claimed){this.#store.releaseRuntimeProvider(this.#owner);this.#claimed=false;}this.#phase='closed';this.#listeners.clear();return Object.freeze({status:rows.every(x=>x.status==='closed')?'closed':'unconfirmed'});})();return this.#shutdownPromise;}
}
