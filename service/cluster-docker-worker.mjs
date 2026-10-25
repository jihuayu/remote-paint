import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {DockerSessionProvider} from './docker-session-provider.mjs';
import {SqliteSessionStore} from './session-store.mjs';
import {SessionRegistry} from './session-registry.mjs';
import {ClusterRpcError} from './cluster-rpc.mjs';
import {ClusterWorkerService} from './cluster-worker-service.mjs';

// The node owns its original Session/runtime journal. Global Session identities
// are projected through the normal Registry intent/Ready/retirement pipeline;
// no foreign-key bypass, shared database or second active owner is involved.
export function createDockerClusterWorker({provider,store,...configuration}={}){
 if(!(provider instanceof DockerSessionProvider)||!(store instanceof SqliteSessionStore)||!provider.matchesSessionStore(store)||provider.status().available!==true)throw new TypeError('Expected the actual initialized available provider and its own Session journal');
 const pending=new Map(),region=configuration.region,maxSessions=configuration.maxSessions??64;
 const registry=new SessionRegistry({store,providers:new Map([[region,provider]]),defaultRegion:region,globalQuota:maxSessions,tenantQuota:maxSessions,sessionIdFactory:({tenantId,idempotencyKey})=>{const captured=pending.get(idempotencyKey);if(!captured||captured.tenantId!==tenantId)throw new Error('Missing authenticated placement');return captured.sessionId;}});
 let recovered=false;const recovery=registry.recover().then(result=>{if(result.status!=='closed')throw new ClusterRpcError('CLUSTER_DOCKER_RECOVERY_REQUIRED','not-dispatched');recovered=true;return result;});void recovery.catch(()=>{});
 const wait=async operation=>{const end=performance.now()+70000;for(;;){const current=registry.getOperation(operation.tenantId,operation.operationId);if(current.status!=='pending')return current;if(performance.now()>=end)throw new ClusterRpcError('CLUSTER_DOCKER_UNCONFIRMED');await delay(10);}};
 const close=async request=>{await recovery;const operation=registry.release(request.tenantId,request.sessionId),result=await wait({...operation,tenantId:request.tenantId});return {status:result.status==='succeeded'?'closed':'unconfirmed'};};
 const ready=request=>{const value=registry.requireReady(request.tenantId,request.sessionId);if(value.region!==request.region||value.version!==request.version)throw new ClusterRpcError('CLUSTER_DOCKER_SESSION_UNAVAILABLE','not-dispatched');};
 const backend={
  create(){throw new ClusterRpcError('CLUSTER_DOCKER_FENCE_REQUIRED','not-dispatched');},
  async createFenced(placement,request){
   await recovery;if(request.signal?.aborted)throw new ClusterRpcError('CLUSTER_DOCKER_CANCELLED','not-dispatched');
   const idempotencyKey='cluster_'+createHash('sha256').update(JSON.stringify([placement,request.url,request.ttlSeconds])).digest('hex');pending.set(idempotencyKey,{sessionId:placement.sessionId,tenantId:placement.tenantId});let operation;
   try{operation=registry.create(request.tenantId,{region:request.region,url:request.url,ttlSeconds:request.ttlSeconds},{idempotencyKey});}finally{pending.delete(idempotencyKey);}
   if(operation.sessionId!==placement.sessionId)throw new ClusterRpcError('CLUSTER_DOCKER_IDENTITY','not-dispatched');
   const abort=()=>{try{registry.release(request.tenantId,request.sessionId);}catch{}};request.signal?.addEventListener('abort',abort,{once:true});if(request.signal?.aborted)abort();
   try{const result=await wait({...operation,tenantId:request.tenantId});if(result.status!=='succeeded')throw new ClusterRpcError('CLUSTER_DOCKER_START_FAILED');return {version:registry.requireReady(request.tenantId,request.sessionId).version};}finally{request.signal?.removeEventListener('abort',abort);}
  },close,retryClose:close,
  resolveSource(request){ready(request);return provider.resolveSource(request);},agent(request){ready(request);return provider.agent(request);},
  subscribeUnavailable:callback=>provider.subscribeUnavailable(callback),status:()=>({...provider.status(),available:recovered&&provider.status().available}),
  async shutdown(){await recovery.catch(()=>{});const a=await registry.shutdown(),b=await provider.shutdown();return {status:a.status==='closed'&&b.status==='closed'?'closed':'unconfirmed'};}
 };
 const service=new ClusterWorkerService({...configuration,provider:backend,verifyRetirement:({request,result})=>result.status==='closed'?provider.retirementEvidence(request):null});
 Object.defineProperty(service,'initialize',{value:async()=>{const result=await recovery,status=await service.handle('status',{});if(status.admissionAvailable===false||status.lease.state==='expired')throw new ClusterRpcError('CLUSTER_DOCKER_RECOVERY_REQUIRED','not-dispatched');return result;}});return service;
}
