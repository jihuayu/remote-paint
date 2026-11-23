import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {WebSocket} from 'ws';
import {ClusterWorkerFence} from './cluster-worker-fence.mjs';
import {ClusterRpcError} from './cluster-rpc.mjs';
import {captureAgentRequest,captureAgentResult,agentReplyExpectation,AgentRpcError,agentFailure} from './agent-rpc.mjs';
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const fail=code=>{throw new ClusterRpcError(code,'not-dispatched');};
const bindingKeys=['tenantId','sessionId','nodeId','generation','epoch'];
const same=(a,b)=>bindingKeys.every(k=>a[k]===b[k]);
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','startup-failed','startup-cancelled','worker-unavailable']);
const maxPayload=16*1024*1024;

// Wraps an existing owned provider. Caller supplies the original deployment /
// Engine/retirement verifier; this wrapper never invents physical evidence.
export class ClusterWorkerService {
 #nodeId;#provider;#fence;#region;#version;#leaseMs;#challenge;#entries=new Map();#verify;#resolveStreamTarget;#unsubscribe;#max;#closed=false;#shutdown;
 constructor({nodeId,incarnation,region,version,provider,verifyRetirement,resolveStreamTarget=null,leaseMs=15000,maxSessions=64}={}){
  if(!id(region)||typeof version!=='string'||version.length<1||version.length>256||!provider||!['create','close','resolveSource','agent'].every(k=>typeof provider[k]==='function')||typeof verifyRetirement!=='function'||(resolveStreamTarget!==null&&typeof resolveStreamTarget!=='function')||!Number.isSafeInteger(leaseMs)||leaseMs<100||leaseMs>60000||!Number.isSafeInteger(maxSessions)||maxSessions<1||maxSessions>10000)throw new TypeError('Configure fixed Worker data identity, existing provider and trusted retirement verifier');
  this.#nodeId=nodeId;this.#provider=provider;this.#region=region;this.#version=version;this.#leaseMs=leaseMs;this.#verify=verifyRetirement;this.#resolveStreamTarget=resolveStreamTarget;this.#max=maxSessions;
  this.#fence=new ClusterWorkerFence({nodeId,incarnation,maxSessions,onExpired:async()=>{await Promise.all([...this.#entries.values()].map(entry=>this.#closeEntry(entry,false,'worker-unavailable')));}});
  this.#unsubscribe=provider.subscribeUnavailable?.(event=>{const entry=this.#entries.get(event.sessionId);if(entry&&event.tenantId===entry.request.tenantId&&event.region===region)entry.unavailable=true;});
 }
 #entry(placement){
  if(!exact(placement,bindingKeys))fail('CLUSTER_WORKER_FENCE');const entry=this.#entries.get(placement.sessionId);
  if(!entry||!same(entry.placement,placement))fail('CLUSTER_WORKER_FENCE');return entry;
 }
 #closeTarget(placement){
  if(!exact(placement,bindingKeys)||!id(placement.tenantId)||!id(placement.sessionId)||placement.nodeId!==this.#nodeId||!Number.isSafeInteger(placement.generation)||placement.generation<1||!Number.isSafeInteger(placement.epoch)||placement.epoch<1)fail('CLUSTER_WORKER_FENCE');
  const existing=this.#entries.get(placement.sessionId);
  if(existing){if(!same(existing.placement,placement))fail('CLUSTER_WORKER_FENCE');return existing;}
  const status=this.#fence.status();
  if(status.state!=='active'||!Number.isSafeInteger(status.generation)||placement.generation>status.generation)fail('CLUSTER_WORKER_FENCE');
  if(this.#entries.size>=this.#max)fail('CLUSTER_WORKER_RETENTION_LIMIT');
  const captured=Object.freeze({...placement});
  const entry={placement:captured,request:{tenantId:captured.tenantId,sessionId:captured.sessionId,region:this.#region,version:this.#version},fingerprint:null,closing:true,controller:new AbortController(),closePromise:null,closeState:null,start:null,unavailable:true};
  this.#entries.set(captured.sessionId,entry);
  return entry;
 }
 #request(value){
  if(!exact(value,['tenantId','sessionId','region','version'])||value.region!==this.#region||value.version!==this.#version||!id(value.tenantId)||!id(value.sessionId))fail('CLUSTER_WORKER_REQUEST');return {...value};
 }
 async #closeEntry(entry,retry,reason){
  if(entry.closePromise&&(!retry||entry.closeState===null||entry.closeState==='closed'))return entry.closePromise;
  entry.closing=true;entry.closeState=null;entry.controller?.abort();
  entry.closePromise=Promise.resolve().then(async()=>{
   try{await entry.start;}catch{}
   const method=retry&&typeof this.#provider.retryClose==='function'?'retryClose':'close';
   const result=await this.#provider[method]({...entry.request,reason});if(result?.status!=='closed')return {status:'unconfirmed'};
   const evidence=await this.#verify({placement:entry.placement,request:entry.request,result});
   if(!exact(evidence,['sha256'])||!/^[a-f0-9]{64}$/.test(evidence.sha256))return {status:'unconfirmed'};
   return {status:'closed',evidence};
  }).catch(()=>({status:'unconfirmed'})).then(result=>{entry.closeState=result.status;return result;});return entry.closePromise;
 }
 async openStream({placement,request:reqIdentity,key,signal}={}){
  if(this.#closed)fail('CLUSTER_WORKER_CLOSED');
  const identity=this.#request(reqIdentity),entry=this.#entry(placement);
  if(entry.closing||entry.unavailable||!['tenantId','sessionId','region','version'].every(k=>identity[k]===entry.request[k])||typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))fail('CLUSTER_WORKER_UNAVAILABLE');
  this.#fence.check(entry.placement);
  const combinedSignal=signal?AbortSignal.any([signal,this.#fence.signal,entry.controller.signal]):AbortSignal.any([this.#fence.signal,entry.controller.signal]);
  const rawTarget=await this.#fence.run(entry.placement,()=>this.#provider.resolveSource({...identity,signal:combinedSignal}));
  this.#fence.check(entry.placement);
  if(entry.closing||entry.unavailable||combinedSignal.aborted)fail('CLUSTER_WORKER_UNAVAILABLE');
  if(typeof rawTarget?.key!=='string'||rawTarget.key.length!==64||!timingSafeEqual(Buffer.from(rawTarget.key,'utf8'),Buffer.from(key,'utf8')))fail('CLUSTER_WORKER_SOURCE_KEY');
  const target=this.#resolveStreamTarget?await this.#resolveStreamTarget(rawTarget,identity):rawTarget;
  const streamOrigin=target?.streamOrigin,privateOrigin=target?.origin,streamKey=target?.key;
  if(typeof streamOrigin!=='string'||typeof privateOrigin!=='string'||typeof streamKey!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(streamKey))fail('CLUSTER_WORKER_SOURCE');
  const url=new URL(streamOrigin),sourceOrigin=new URL(privateOrigin);
  if(url.origin!==streamOrigin||!['http:','https:'].includes(url.protocol)||!['http:','https:'].includes(sourceOrigin.protocol)||sourceOrigin.origin!==privateOrigin)fail('CLUSTER_WORKER_SOURCE');
  url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/stream';url.searchParams.set('key',streamKey);
  const upstream=new WebSocket(url,{origin:privateOrigin,perMessageDeflate:false,maxPayload,handshakeTimeout:5000});
  const onAbort=()=>{try{upstream.terminate();}catch{}};
  combinedSignal.addEventListener('abort',onAbort,{once:true});
  upstream.once('close',()=>combinedSignal.removeEventListener('abort',onAbort));
  await new Promise((resolve,reject)=>{
   upstream.once('open',resolve);
   upstream.once('error',()=>reject(new ClusterRpcError('CLUSTER_WORKER_STREAM','not-dispatched')));
   upstream.once('unexpected-response',(_req,res)=>{res.resume();reject(new ClusterRpcError('CLUSTER_WORKER_STREAM','not-dispatched'));});
  });
  this.#fence.check(entry.placement);
  if(entry.closing||entry.unavailable||combinedSignal.aborted){try{upstream.terminate();}catch{}fail('CLUSTER_WORKER_UNAVAILABLE');}
  return upstream;
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
   const entry={placement,request:identity,fingerprint,closing:false,controller:new AbortController(),closePromise:null,closeState:null,start:null,unavailable:false};this.#entries.set(placement.sessionId,entry);
   entry.start=this.#fence.run(placement,async ownerSignal=>{const request={tenantId:identity.tenantId,sessionId:identity.sessionId,region:identity.region,url,ttlSeconds,signal:AbortSignal.any([ownerSignal,entry.controller.signal])},ready=await(typeof this.#provider.createFenced==='function'?this.#provider.createFenced(placement,request):this.#provider.create(request));if(entry.closing||ready?.version!==this.#version)fail('CLUSTER_WORKER_VERSION');return {version:ready.version};});void entry.start.catch(()=>{});return entry.start;
  }
  if(method==='close'){
   if(!exact(payload,['placement','reason','retry'])||!reasons.has(payload.reason)||typeof payload.retry!=='boolean')fail('CLUSTER_WORKER_REQUEST');return this.#closeEntry(this.#closeTarget(payload.placement),payload.retry,payload.reason);
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
