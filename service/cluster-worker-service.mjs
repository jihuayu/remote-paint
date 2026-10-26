import {randomUUID,createHash} from 'node:crypto';
import {ClusterWorkerFence} from './cluster-worker-fence.mjs';
import {ClusterRpcError} from './cluster-rpc.mjs';
import {captureAgentRequest,captureAgentResult,agentReplyExpectation,AgentRpcError,agentFailure} from './agent-rpc.mjs';
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const fail=code=>{throw new ClusterRpcError(code,'not-dispatched');};
const bindingKeys=['tenantId','sessionId','nodeId','generation','epoch'];
const same=(a,b)=>bindingKeys.every(k=>a[k]===b[k]);
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','startup-failed','startup-cancelled','worker-unavailable']);

// Wraps an existing owned provider. Caller supplies the original deployment /
// Engine/retirement verifier; this wrapper never invents physical evidence.
export class ClusterWorkerService {
 #provider;#fence;#region;#version;#leaseMs;#challenge;#entries=new Map();#verify;#unsubscribe;#max;#closed=false;#shutdown;
 constructor({nodeId,incarnation,region,version,provider,verifyRetirement,leaseMs=15000,maxSessions=64}={}){
  if(!id(region)||typeof version!=='string'||version.length<1||version.length>256||!provider||!['create','close','resolveSource','agent'].every(k=>typeof provider[k]==='function')||typeof verifyRetirement!=='function'||!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>60000||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>10000)throw new TypeError('Configure fixed Worker data identity, existing provider and trusted retirement verifier');
  this.#provider=provider;this.#region=region;this.#version=version;this.#leaseMs=leaseMs;this.#verify=verifyRetirement;this.#max=maxSessions;
  this.#fence=new ClusterWorkerFence({nodeId,incarnation,maxSessions,onExpired:async()=>{await Promise.all([...this.#entries.values()].map(entry=>this.#closeEntry(entry,false,'worker-unavailable')));}});
  this.#unsubscribe=provider.subscribeUnavailable?.(event=>{const entry=this.#entries.get(event.sessionId);if(entry&&event.tenantId===entry.request.tenantId&&event.region===region)entry.unavailable=true;});
 }
 #entry(placement){
  if(!exact(placement,bindingKeys))fail('CLUSTER_WORKER_FENCE');const entry=this.#entries.get(placement.sessionId);
  if(!entry||!same(entry.placement,placement))fail('CLUSTER_WORKER_FENCE');return entry;
 }
 #request(value){
  if(!exact(value,['tenantId','sessionId','region','version'])||value.region!==this.#region||value.version!==this.#version||!id(value.tenantId)||!id(value.sessionId))fail('CLUSTER_WORKER_REQUEST');return {...value};
 }
 async #closeEntry(entry,retry,reason){
  if(entry.closePromise&&(!retry||entry.closeState===null||entry.closeState==='closed'))return entry.closePromise;
  entry.closing=true;entry.closeState=null;
  entry.closePromise=Promise.resolve().then(async()=>{
   try{await entry.start;}catch{}
   const method=retry&&typeof this.#provider.retryClose==='function'?'retryClose':'close';
   const result=await this.#provider[method]({...entry.request,reason});if(result?.status!=='closed')return {status:'unconfirmed'};
   const evidence=await this.#verify({placement:entry.placement,request:entry.request,result});
   if(!exact(evidence,['sha256'])||!/^[a-f0-9]{64}$/.test(evidence.sha256))return {status:'unconfirmed'};
   return {status:'closed',evidence};
  }).catch(()=>({status:'unconfirmed'})).then(result=>{entry.closeState=result.status;return result;});return entry.closePromise;
 }
 async handle(method,payload,{signal}={}){
  if(this.#closed)fail('CLUSTER_WORKER_CLOSED');
  if(method==='lease-begin'){
   if(!exact(payload,[]))fail('CLUSTER_WORKER_REQUEST');if(this.#challenge)this.#fence.rejectHeartbeat(this.#challenge.observation);
   this.#challenge={id:randomUUID(),observation:this.#fence.beginHeartbeat()};return {challenge:this.#challenge.id};
  }
  if(method==='lease-accept'){
   if(!exact(payload,['challenge','lease','leaseMs'])||payload.challenge!==this.#challenge?.id||payload.leaseMs!==this.#leaseMs)fail('CLUSTER_WORKER_HEARTBEAT');
   const challenge=this.#challenge;this.#challenge=null;return this.#fence.acceptLease(challenge.observation,payload.lease,{leaseMs:this.#leaseMs});
  }
  if(method==='status'){
   if(!exact(payload,[]))fail('CLUSTER_WORKER_REQUEST');return {lease:this.#fence.status(),admissionAvailable:this.#provider.status?.().available!==false,unavailable:[...this.#entries.values()].filter(e=>e.closeState!=='closed'&&e.unavailable).map(e=>({tenantId:e.request.tenantId,sessionId:e.request.sessionId,region:this.#region}))};
  }
  if(method==='create'){
   if(!exact(payload,['placement','request'])||!exact(payload.request,['tenantId','sessionId','region','version','url','ttlSeconds']))fail('CLUSTER_WORKER_REQUEST');
   const {url,ttlSeconds,...identity}=payload.request;this.#request(identity);
   if(typeof url!=='string'||url.length>8192||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>86400)fail('CLUSTER_WORKER_REQUEST');
   let parsed;try{parsed=new URL(url);}catch{fail('CLUSTER_WORKER_REQUEST');}if(url!=='about:blank'&&(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password))fail('CLUSTER_WORKER_REQUEST');
   const placement=this.#fence.admit(payload.placement);if(placement.tenantId!==identity.tenantId||placement.sessionId!==identity.sessionId)fail('CLUSTER_WORKER_FENCE');
   const fingerprint=createHash('sha256').update(JSON.stringify(payload.request)).digest('hex'),old=this.#entries.get(placement.sessionId);
   if(old){if(!same(old.placement,placement)||old.fingerprint!==fingerprint||old.closing)fail('CLUSTER_WORKER_CONFLICT');return old.start;}
   if(this.#entries.size>=this.#max)fail('CLUSTER_WORKER_RETENTION_LIMIT');
   const entry={placement,request:identity,fingerprint,closing:false,closePromise:null,closeState:null,start:null,unavailable:false};this.#entries.set(placement.sessionId,entry);
   entry.start=this.#fence.run(placement,async ownerSignal=>{const request={tenantId:identity.tenantId,sessionId:identity.sessionId,region:identity.region,url,ttlSeconds,signal:ownerSignal},ready=await(typeof this.#provider.createFenced==='function'?this.#provider.createFenced(placement,request):this.#provider.create(request));if(entry.closing||ready?.version!==this.#version)fail('CLUSTER_WORKER_VERSION');return {version:ready.version};});void entry.start.catch(()=>{});return entry.start;
  }
  if(method==='close'){
   if(!exact(payload,['placement','reason','retry'])||!reasons.has(payload.reason)||typeof payload.retry!=='boolean')fail('CLUSTER_WORKER_REQUEST');return this.#closeEntry(this.#entry(payload.placement),payload.retry,payload.reason);
  }
  if(!exact(payload,method==='agent'?['placement','request','command','timeoutMs']:['placement','request']))fail('CLUSTER_WORKER_REQUEST');
  const identity=this.#request(payload.request),entry=this.#entry(payload.placement);if(entry.closing||entry.unavailable||!['tenantId','sessionId','region','version'].every(k=>identity[k]===entry.request[k]))fail('CLUSTER_WORKER_UNAVAILABLE');
  this.#fence.check(entry.placement);
  if(method==='resolve')return this.#fence.run(entry.placement,()=>this.#provider.resolveSource({...identity,signal}));
  if(method==='agent'){
   const command=captureAgentRequest(payload.command);if(!Number.isSafeInteger(payload.timeoutMs)||payload.timeoutMs<50||payload.timeoutMs>120000)throw new AgentRpcError('AGENT_INVALID_REQUEST','not-dispatched');if(command.context&&(command.context.binding.tenantId!==identity.tenantId||command.context.binding.sessionId!==identity.sessionId))throw new AgentRpcError('AGENT_INVALID_CONTEXT','not-dispatched');let result;
   try{result=await this.#provider.agent({...identity,command,timeoutMs:payload.timeoutMs,signal:signal?AbortSignal.any([signal,this.#fence.signal]):this.#fence.signal});}catch(error){throw agentFailure(error,'unknown');}
   try{this.#fence.check(entry.placement);}catch{throw new AgentRpcError('AGENT_UNAVAILABLE','unknown');}
   return captureAgentResult(result,agentReplyExpectation(command),identity);
  }
  fail('CLUSTER_WORKER_REQUEST');
 }
 close(){if(this.#shutdown)return this.#shutdown;this.#closed=true;this.#shutdown=Promise.resolve().then(async()=>{this.#unsubscribe?.();try{await this.#fence.close();const result=await this.#provider.shutdown?.();return {status:result?.status!=='unconfirmed'&&[...this.#entries.values()].every(e=>e.closeState==='closed')?'closed':'unconfirmed'};}catch{return {status:'unconfirmed'};}});return this.#shutdown;}
}
