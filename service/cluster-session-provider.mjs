import {ClusterPlacementStore} from './cluster-placement.mjs';
import {createHash} from 'node:crypto';
import {ClusterRpcClient,ClusterRpcError} from './cluster-rpc.mjs';
import {captureAgentRequest,captureAgentResult,agentReplyExpectation,AgentRpcError} from './agent-rpc.mjs';
const owners=new WeakSet(),bindingKeys=['tenantId','sessionId','nodeId','generation','epoch'];
const binding=v=>Object.fromEntries(bindingKeys.map(k=>[k,v[k]]));
const same=(a,b)=>bindingKeys.every(k=>a[k]===b[k]);
const fail=code=>{throw new ClusterRpcError(code,'not-dispatched');};
const identity=v=>({tenantId:v.tenantId,sessionId:v.sessionId,region:v.region,version:v.version});
const fingerprint=v=>JSON.stringify([v.tenantId,v.sessionId,v.region,v.url,v.ttlSeconds]);
export class ClusterSessionProvider {
 #store;#region;#arch;#version;#workers;#entries=new Map();#listeners=new Set();#proofs=new Map();#leaseMs;#interval;#phase='new';#starting;#shutdown;
 constructor({store,region,arch,version,workers,leaseMs=15000,heartbeatMs=4000}={}){
  if(!(store instanceof ClusterPlacementStore)||owners.has(store)||typeof region!=='string'||!['arm64','x64'].includes(arch)||typeof version!=='string'||!(workers instanceof Map)||workers.size<1||workers.size>64||!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>60000||!Number.isSafeInteger(heartbeatMs)||heartbeatMs<20||heartbeatMs>=leaseMs/2)throw new TypeError('Configure one placement owner and fixed trusted Worker clients');
  this.#store=store;this.#region=region;this.#arch=arch;this.#version=version;this.#leaseMs=leaseMs;this.#interval=heartbeatMs;this.#workers=new Map();
  for(const [nodeId,value]of workers){const {client,descriptor,validateSource}=value;if(!(client instanceof ClusterRpcClient)||descriptor?.nodeId!==nodeId||descriptor.region!==region||descriptor.arch!==arch||descriptor.version!==version||typeof validateSource!=='function')throw new TypeError('Configure matching Worker descriptors and explicit Source endpoint policy');this.#workers.set(nodeId,{client,descriptor:structuredClone(descriptor),validateSource,lease:null,timer:null,heartbeat:null,available:false,draining:false,operatorDrained:false});}
  owners.add(store);
 }
 initialize(){
  if(['stopping','closed'].includes(this.#phase))return Promise.reject(new ClusterRpcError('CLUSTER_PROVIDER_CLOSED','not-dispatched'));if(this.#phase==='available')return Promise.resolve(this.status());if(this.#starting)return this.#starting;if(this.#phase!=='new')return Promise.reject(new ClusterRpcError('CLUSTER_PROVIDER_CLOSED','not-dispatched'));
  this.#phase='starting';this.#starting=(async()=>{for(const worker of this.#workers.values()){
   try{const begin=await worker.client.call('lease-begin',{});worker.lease=this.#store.registerNode(worker.descriptor);await worker.client.call('lease-accept',{challenge:begin.challenge,lease:worker.lease,leaseMs:this.#leaseMs});worker.available=true;this.#schedule(worker);}catch{this.#lose(worker);}
  }if(this.#phase==='starting')this.#phase='available';return this.status();})();return this.#starting;
 }
 #schedule(worker){if(!worker.available||['stopping','closed'].includes(this.#phase))return;worker.timer=setTimeout(()=>{worker.timer=null;worker.heartbeat=this.#heartbeat(worker).finally(()=>{worker.heartbeat=null;this.#schedule(worker);});},this.#interval);worker.timer.unref();}
 async #heartbeat(worker){try{
  const begin=await worker.client.call('lease-begin',{}),lease=this.#store.heartbeat(worker.lease);await worker.client.call('lease-accept',{challenge:begin.challenge,lease,leaseMs:this.#leaseMs});
  const status=await worker.client.call('status',{});if(status.lease?.state!=='active'||!Array.isArray(status.unavailable)||status.unavailable.length>10000)throw new Error('Worker status');
  if(status.admissionAvailable===false){worker.draining=true;this.#store.drain(worker.lease);}
  for(const item of status.unavailable){const entry=this.#entries.get(item.sessionId);if(entry&&entry.placement.nodeId===worker.descriptor.nodeId&&entry.request.tenantId===item.tenantId&&item.region===this.#region)this.#notify(entry);}
 }catch{this.#lose(worker);}}
 #notify(entry){if(entry.unavailable)return;entry.unavailable=true;for(const callback of this.#listeners){try{const result=callback(Object.freeze({sessionId:entry.request.sessionId,tenantId:entry.request.tenantId,region:this.#region}));if(result?.then)void Promise.resolve(result).catch(()=>{});}catch{}}}
 #lose(worker){worker.available=false;clearTimeout(worker.timer);worker.timer=null;if(worker.lease)try{this.#store.drain(worker.lease);}catch{}for(const entry of this.#entries.values())if(entry.placement.nodeId===worker.descriptor.nodeId)this.#notify(entry);}
 subscribeUnavailable(callback){if(typeof callback!=='function')throw new TypeError('Expected provider callback');this.#listeners.add(callback);return()=>this.#listeners.delete(callback);}
 drainWorker(nodeId,enabled=true){
  if(typeof nodeId!=='string'||typeof enabled!=='boolean')throw new TypeError('Expected a configured worker nodeId and drain boolean');
  const worker=this.#workers.get(nodeId);if(!worker)fail('CLUSTER_NODE_NOT_FOUND');
  const result=this.#store.drainNode(nodeId,enabled);worker.operatorDrained=enabled;worker.draining=result.draining;return result;
 }
 async reconnectWorker(nodeId,{incarnation,client}={}){
  if(this.#phase!=='available')fail('CLUSTER_PROVIDER_CLOSED');
  if(typeof nodeId!=='string'||(incarnation!==undefined&&(typeof incarnation!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(incarnation)))||(client!==undefined&&!(client instanceof ClusterRpcClient)))throw new TypeError('Expected a configured worker nodeId and optional valid incarnation or ClusterRpcClient');
  const worker=this.#workers.get(nodeId);if(!worker)fail('CLUSTER_NODE_NOT_FOUND');
  clearTimeout(worker.timer);worker.timer=null;await worker.heartbeat;
  if(client!==undefined&&client!==worker.client){try{worker.client.close();}catch{}worker.client=client;}
  const incarnationChanged=incarnation!==undefined&&incarnation!==worker.descriptor.incarnation;
  if(incarnation!==undefined)worker.descriptor={...worker.descriptor,incarnation};
  try{
   const begin=await worker.client.call('lease-begin',{});
   let lease=null;
   if(!incarnationChanged&&worker.lease){try{lease=this.#store.heartbeat(worker.lease);}catch{lease=null;}}
   if(!lease)lease=this.#store.registerNode(worker.descriptor);
   await worker.client.call('lease-accept',{challenge:begin.challenge,lease,leaseMs:this.#leaseMs});
   const status=await worker.client.call('status',{});
   if(status.lease?.state!=='active'||!Array.isArray(status.unavailable)||status.unavailable.length>10000)throw new Error('Worker status');
   worker.lease=lease;worker.available=true;
   if(status.admissionAvailable===false||worker.operatorDrained){
    worker.draining=true;try{this.#store.drain(worker.lease,true);}catch{}
   }else{
    try{this.#store.drain(worker.lease,false);worker.draining=false;}catch{worker.draining=false;}
   }
   this.#schedule(worker);
   return Object.freeze({nodeId,available:true,draining:worker.draining,lease});
  }catch(error){
   this.#lose(worker);
   throw error instanceof ClusterRpcError?error:new ClusterRpcError(error?.code??'CLUSTER_PROVIDER_UNAVAILABLE','not-dispatched');
  }
 }
 async rotateWorkerTls(nodeId,{tls,serverSha256,endpoint,serverName,incarnation}={}){
  if(this.#phase!=='available')fail('CLUSTER_PROVIDER_CLOSED');
  const worker=this.#workers.get(nodeId);if(!worker)fail('CLUSTER_NODE_NOT_FOUND');
  const client=new ClusterRpcClient({
   endpoint:endpoint??worker.client.endpoint,
   serverName:serverName??worker.client.serverName,
   serverSha256:serverSha256??worker.client.serverSha256,
   tls
  });
  try{
   return await this.reconnectWorker(nodeId,{client,...(incarnation!==undefined?{incarnation}:{})});
  }catch(error){
   try{client.close();}catch{}
   throw error;
  }
 }
 metrics(){
  const placement=this.#store.metrics();
  const workers=Object.freeze([...this.#workers.entries()].map(([nodeId,worker])=>{
   let activeEntries=0,closingEntries=0,unconfirmedCloses=0,unavailableEntries=0;
   for(const entry of this.#entries.values()){
    if(entry.placement.nodeId!==nodeId)continue;
    if(entry.closeState==='closed')continue;
    if(entry.closeState==='unconfirmed')unconfirmedCloses++;
    if(entry.closing)closingEntries++;else activeEntries++;
    if(entry.unavailable)unavailableEntries++;
   }
   return Object.freeze({nodeId,available:worker.available,draining:worker.draining,leaseGeneration:worker.lease?.generation??null,activeEntries,closingEntries,unconfirmedCloses,unavailableEntries});
  }));
  return Object.freeze({phase:this.#phase,region:this.#region,arch:this.#arch,version:this.#version,available:this.#phase==='available'&&workers.some(w=>w.available),availableWorkers:workers.filter(w=>w.available).length,drainingWorkers:workers.filter(w=>w.draining).length,workers,placement});
 }
 status(){return Object.freeze({phase:this.#phase,available:this.#phase==='available'&&[...this.#workers.values()].some(w=>w.available),availableWorkers:[...this.#workers.values()].filter(w=>w.available).length});}
 create(request){
  if(this.#phase!=='available')return Promise.reject(new ClusterRpcError('CLUSTER_PROVIDER_CLOSED','not-dispatched'));
  const captured={tenantId:request.tenantId,sessionId:request.sessionId,region:request.region,url:request.url,ttlSeconds:request.ttlSeconds};
  if(captured.region!==this.#region||request.signal?.aborted)return Promise.reject(new ClusterRpcError('CLUSTER_PROVIDER_REQUEST','not-dispatched'));
  const previous=this.#entries.get(captured.sessionId);if(previous){if(fingerprint(previous.request)!==fingerprint(captured)||previous.closing)return Promise.reject(new ClusterRpcError('CLUSTER_PROVIDER_CONFLICT','not-dispatched'));return previous.start;}
  let placed;try{placed=this.#store.reserve({...identity({...captured,version:this.#version}),arch:this.#arch});if(placed.state!=='reserved')fail('CLUSTER_PROVIDER_RECOVERY_REQUIRED');}catch(error){return Promise.reject(error);}
  const worker=this.#workers.get(placed.nodeId),entry={placement:binding(placed),request:captured,controller:new AbortController(),start:null,dispatched:false,closing:false,closePromise:null,closeState:null,unavailable:false};this.#entries.set(captured.sessionId,entry);
  entry.start=Promise.resolve().then(async()=>{if(!worker?.available)fail('CLUSTER_PROVIDER_UNAVAILABLE');if(entry.closing||request.signal?.aborted||entry.controller.signal.aborted)fail('CLUSTER_PROVIDER_CANCELLED');entry.dispatched=true;const signal=request.signal?AbortSignal.any([request.signal,entry.controller.signal]):entry.controller.signal;const result=await worker.client.call('create',{placement:entry.placement,request:{...captured,version:this.#version}},{signal,timeoutMs:70000});if(entry.closing||request.signal?.aborted||entry.controller.signal.aborted||result?.version!==this.#version||!worker.available)throw new ClusterRpcError('CLUSTER_PROVIDER_UNAVAILABLE','unknown');this.#store.ready(entry.placement);return {version:result.version};});void entry.start.catch(()=>{});return entry.start;
 }
 #current(request){
  if(this.#phase!=='available'||request.region!==this.#region||request.version!==this.#version)fail('CLUSTER_PROVIDER_UNAVAILABLE');
  const route=this.#store.route(identity(request)),entry=this.#entries.get(request.sessionId),worker=this.#workers.get(route.nodeId);
  if(!entry||entry.closing||entry.unavailable||!worker?.available||!same(entry.placement,route))fail('CLUSTER_PROVIDER_UNAVAILABLE');return {entry,worker};
 }
 async resolveSource(request){
  const {entry,worker}=this.#current(request),target=await worker.client.call('resolve',{placement:entry.placement,request:identity(request)},{signal:request.signal});this.#current(request);
  if(worker.validateSource(target,identity(request))!==true)fail('CLUSTER_PROVIDER_SOURCE');return target;
 }
 async resolveSourceStream(request){
  const {entry,worker}=this.#current(request),target=await this.resolveSource(request);this.#current(request);
  return Object.freeze({...target,connectStream:({signal}={})=>{
   this.#current(request);
   return worker.client.openStream({placement:entry.placement,request:identity(request),key:target.key,signal});
  }});
 }
 async agent(request){
  let entry,worker,command;try{({entry,worker}=this.#current(request));command=captureAgentRequest(request.command);if(command.context&&(command.context.binding.tenantId!==request.tenantId||command.context.binding.sessionId!==request.sessionId))throw new AgentRpcError('AGENT_INVALID_CONTEXT','not-dispatched');}catch(error){throw error instanceof AgentRpcError?error:new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched');}
  const timeoutMs=request.timeoutMs??5000;let result;try{result=await worker.client.call('agent',{placement:entry.placement,request:identity(request),command,timeoutMs},{signal:request.signal,timeoutMs});this.#current(request);}catch(error){throw new AgentRpcError(error.code??'AGENT_UNAVAILABLE',error.outcome??'unknown');}
  return captureAgentResult(result,agentReplyExpectation(command),identity(request));
 }
 close(request){return this.#close(request,false);}
 retryClose(request){return this.#close(request,true);}
 #close(request,retry){
  if(!request||request.region!==this.#region||typeof request.tenantId!=='string'||typeof request.sessionId!=='string')return Promise.resolve({status:'unconfirmed'});
  let entry=this.#entries.get(request.sessionId);
  if(!entry){
   let placed;try{placed=this.#store.beginRelease({tenantId:request.tenantId,sessionId:request.sessionId});}catch{return Promise.resolve({status:'unconfirmed'});}
   entry={placement:binding(placed),request:{tenantId:request.tenantId,sessionId:request.sessionId,region:this.#region},controller:new AbortController(),start:null,dispatched:true,closing:false,closePromise:null,closeState:null,unavailable:true};
   this.#entries.set(request.sessionId,entry);
  }
  if(entry.request.tenantId!==request.tenantId)return Promise.resolve({status:'unconfirmed'});
  if(entry.closePromise&&(!retry||entry.closeState===null||entry.closeState==='closed'))return entry.closePromise;
  entry.closing=true;entry.closeState=null;entry.controller?.abort();try{this.#store.beginRelease(entry.request);}catch{return Promise.resolve({status:'unconfirmed'});}
  entry.closePromise=Promise.resolve().then(async()=>{
   try{await entry.start;}catch{}
   if(!entry.dispatched){const sha256=createHash('sha256').update(JSON.stringify({placement:entry.placement,kind:'controller-not-dispatched'})).digest('hex');this.#proofs.set(entry.request.sessionId,{placement:entry.placement,sha256});this.#store.confirmRetired(entry.placement,{sha256});return {status:'closed'};}
   const worker=this.#workers.get(entry.placement.nodeId),result=await worker.client.call('close',{placement:entry.placement,reason:request.reason??'released',retry});
   if(result?.status!=='closed'||!/^[a-f0-9]{64}$/.test(result.evidence?.sha256??''))return {status:'unconfirmed'};
   this.#proofs.set(entry.request.sessionId,{placement:entry.placement,sha256:result.evidence.sha256});this.#store.confirmRetired(entry.placement,result.evidence);return {status:'closed'};
  }).catch(()=>({status:'unconfirmed'})).then(result=>{entry.closeState=result.status;return result;});return entry.closePromise;
 }
 verifyRetirement(placement,evidence){const proof=this.#proofs.get(placement.sessionId);return !!proof&&same(proof.placement,placement)&&proof.sha256===evidence.sha256;}
 shutdown(){
  if(this.#shutdown)return this.#shutdown;this.#phase='stopping';for(const worker of this.#workers.values())clearTimeout(worker.timer);
  this.#shutdown=Promise.resolve().then(async()=>{await this.#starting?.catch(()=>{});await Promise.all([...this.#workers.values()].map(w=>w.heartbeat));const results=await Promise.all([...this.#entries.values()].map(entry=>this.close({...entry.request,reason:'registry-shutdown'})));for(const worker of this.#workers.values())worker.client.close();this.#listeners.clear();this.#phase='closed';return {status:results.every(r=>r.status==='closed')?'closed':'unconfirmed'};});return this.#shutdown;
 }
}
