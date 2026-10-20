import {createHash,timingSafeEqual} from 'node:crypto';
import {validateLinuxRuntimeWitness} from './linux-runtime-witness.mjs';
import {AgentRpcError,captureAgentRequest,agentReplyExpectation,captureAgentResult,agentFailure} from './agent-rpc.mjs';

const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const ignoreClosedStreamError=()=>{};
const session=v=>typeof v==='string'&&/^ses_[A-Za-z0-9_-]{1,124}$/.test(v);
function request(value,region){
 if(!exact(value,['url','region','ttlSeconds'])||value.region!==region||!integer(value.ttlSeconds,1,86400)||typeof value.url!=='string'||value.url.length>8192)return false;
 try{const url=new URL(value.url);return value.url==='about:blank'||['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}
}

// One Session per private byte channel. The runtime must independently fence
// and retire the complete process/container namespace; Closed is a resource
// close attestation, not a kernel-wide process census or Registry commit.
export function runSessionWorker({identity,createResource,deriveResourceSecret=null,runtimeWitness=null,input=process.stdin,output=process.stdout,owner=process,
 startTimeoutMs=5000,initializationTimeoutMs=60000,ownerLeaseMs=30000,closeTimeoutMs=10000,maxFrameBytes=32768}={}){
 if(!exact(identity,['sessionId','tenantId','region','ownerKeyHash'])||!session(identity.sessionId)||!tenant(identity.tenantId)||typeof identity.region!=='string'||!identity.region.length||identity.region.length>64||!hash(identity.ownerKeyHash)||typeof createResource!=='function'||runtimeWitness!==null&&typeof runtimeWitness!=='function')throw new TypeError('Configure a fixed worker identity and resource factory');
 if(deriveResourceSecret!==null&&typeof deriveResourceSecret!=='function')throw new TypeError('Configure an explicit trusted private resource derivation');
 for(const [value,min,max]of [[startTimeoutMs,50,30000],[initializationTimeoutMs,50,120000],[ownerLeaseMs,50,60000],[closeTimeoutMs,50,30000],[maxFrameBytes,1024,65536]])if(!integer(value,min,max))throw new TypeError('Invalid worker bounds');
 identity=structuredClone(identity);
 const expected=Buffer.from(identity.ownerKeyHash,'hex'),controller=new AbortController(),frameBuffer=Buffer.alloc(maxFrameBytes);
 let bytes=0,resource=null,started=false,starting=Promise.resolve(),startSettled=true,initializing=false,invalidOwner=false,stopping=false,finished=false,closeTask=null,
  failure=null,reason=null,leaseTimer=null,initializeTimer=null,startTimer,outputAvailable=true,resolveDone,resourceUnsubscribe=null,
  resourceReady=false,agentActive=null,agentEnding=null,lastAgentRequestId=0,pendingOutputBytes=0;
 const done=new Promise(resolve=>{resolveDone=resolve;});
 const emit=value=>{
  if(!outputAvailable||output.destroyed)return;
  let frame;try{frame=JSON.stringify({protocol:'session-worker-v1',sessionId:identity.sessionId,...value})+'\n';}catch{lost();return;}const size=Buffer.byteLength(frame);
  if(size>8192||pendingOutputBytes+size>32768){lost();return;}pendingOutputBytes+=size;
  try{output.write(frame,error=>{pendingOutputBytes-=size;if(error)lost();});}catch{pendingOutputBytes-=size;lost();}
 };
 const detachResource=()=>{const unsubscribe=resourceUnsubscribe;resourceUnsubscribe=null;try{unsubscribe?.();}catch{failure??='WORKER_HEALTH_UNSUBSCRIBE_FAILED';}};
 const cleanup=()=>{
  detachResource();
  clearTimeout(startTimer);clearTimeout(leaseTimer);clearTimeout(initializeTimer);
  input.off('data',data);input.off('end',lost);input.off('error',lost);output.off('error',lost);
  // Each worker owns these streams until its process exits. Final writes can
  // fail asynchronously after cleanup; the sink retains no Session/resource.
  input.on('error',ignoreClosedStreamError);output.on('error',ignoreClosedStreamError);owner.off('SIGTERM',terminate);owner.off('SIGINT',terminate);owner.off('disconnect',lost);
  input.pause();frameBuffer.fill(0);bytes=0;
 };
 const finish=(status,exitCode)=>{
  if(finished)return;finished=true;if(status!=='closed')failure??='WORKER_CLEANUP_UNCONFIRMED';cleanup();
  const result={status,exitCode,reason,failure};
  emit({type:status==='closed'?'Closed':'CleanupIncomplete',reason,code:failure});resolveDone(result);
 };
 const stop=(why,code=null)=>{
  if(stopping)return closeTask;
  stopping=true;reason=why;failure=code;clearTimeout(startTimer);clearTimeout(leaseTimer);clearTimeout(initializeTimer);
  // Publish the close fence before abort listeners or resource callbacks run.
  let resolveClose;closeTask=new Promise(resolve=>{resolveClose=resolve;});
  const timeout=setTimeout(()=>{failure??='WORKER_CLOSE_TIMEOUT';finish('cleanup-incomplete',1);resolveClose();},closeTimeoutMs);
  detachResource();
  if(why==='resource-unavailable')emit({type:'Unavailable',code:'WORKER_RESOURCE_UNAVAILABLE'});
  controller.abort(why);
  void Promise.resolve().then(async()=>{
   let closed=false;
   try{
    if(resource){
     const receipt=await resource.close();
     // A factory cannot acknowledge a close while initialization can still
     // acquire resources. NativeLiveResource waits for that actual outcome.
     const early=initializing&&!startSettled;
     await starting;await Promise.allSettled([agentActive?.done,agentEnding?.done].filter(Boolean));
     closed=receipt?.status==='closed'&&!early;if(early)failure??='WORKER_EARLY_CLOSE_RECEIPT';
    }else{await starting;await Promise.allSettled([agentActive?.done,agentEnding?.done].filter(Boolean));closed=!invalidOwner;}
   }catch{closed=false;failure??='WORKER_CLOSE_FAILED';}
   clearTimeout(timeout);finish(closed?'closed':'cleanup-incomplete',closed&&!failure?0:1);resolveClose();
  });
  return closeTask;
 };
 function lost(){outputAvailable=false;void stop('owner-disconnected');}
 function terminate(){void stop('worker-terminated');}
 const armLease=()=>{clearTimeout(leaseTimer);leaseTimer=setTimeout(()=>{void stop('owner-lease-expired');},ownerLeaseMs);};
 const authenticate=value=>hash(value.ownerKey)&&value.sessionId===identity.sessionId&&timingSafeEqual(createHash('sha256').update(value.ownerKey).digest(),expected);
 const message=value=>{
  if(stopping||finished)return;
  if(!plain(value)||!authenticate(value)){void stop('protocol-rejected','WORKER_AUTHENTICATION_FAILED');return;}
  if(value.type==='Start'){
   if(started||!exact(value,['type','sessionId','ownerKey','request'])||!request(value.request,identity.region)){void stop('protocol-rejected','WORKER_INVALID_START');return;}
   started=true;clearTimeout(startTimer);armLease();
   try{
    let secret;
    if(deriveResourceSecret){secret=deriveResourceSecret({ownerKey:value.ownerKey,sessionId:identity.sessionId,tenantId:identity.tenantId,region:identity.region});if(secret&&typeof secret.then==='function'){void Promise.resolve(secret).catch(()=>{});throw new TypeError('Asynchronous resource derivation is unsupported');}if(!hash(secret))throw new TypeError('Invalid private resource secret');}
    resource=createResource({sessionId:identity.sessionId,tenantId:identity.tenantId,request:structuredClone(value.request),signal:controller.signal,...(deriveResourceSecret?{resourceSecret:secret}:{})});
    if(resource&&typeof resource.then==='function'){void Promise.resolve(resource).catch(()=>{});throw new TypeError('Asynchronous resource factory is unsupported');}
    if(!resource||typeof resource.initialize!=='function'||typeof resource.close!=='function')throw new TypeError('Expected a synchronous resource owner');
    if(resource.subscribeUnavailable!==undefined){
     if(typeof resource.subscribeUnavailable!=='function')throw new TypeError('Invalid resource health subscription');
     const unsubscribe=resource.subscribeUnavailable(()=>{void stop('resource-unavailable','WORKER_RESOURCE_UNAVAILABLE');});
     if(unsubscribe&&typeof unsubscribe.then==='function'){void Promise.resolve(unsubscribe).catch(()=>{});throw new TypeError('Asynchronous health subscription is unsupported');}
     if(typeof unsubscribe!=='function')throw new TypeError('Expected synchronous health unsubscribe');resourceUnsubscribe=unsubscribe;
     if(stopping){detachResource();return;}
    }
   }catch{invalidOwner=true;void stop('startup-failed','WORKER_RESOURCE_FACTORY_FAILED');return;}
   startSettled=false;
   starting=Promise.resolve().then(async()=>{
    if(stopping)return;
    initializing=true;
    const ready=await resource.initialize();startSettled=true;
    if(!ready||typeof ready.version!=='string'||!ready.version.length||ready.version.length>256)throw new TypeError('Invalid resource version');
    if(!stopping){resourceReady=true;clearTimeout(initializeTimer);emit({type:'Ready',version:ready.version,...(typeof resource.agent==='function'?{capabilities:['agent-rpc-v1',...(resource.agentObservationVersion===1?['agent-observe-v1',...(resource.agentAccessibilityVersion===1?['agent-observe-ax-v1']:[])]:[])]}:{})});}
   }).catch(()=>{if(!stopping)void stop('startup-failed','WORKER_START_FAILED');}).finally(()=>{startSettled=true;});
   initializeTimer=setTimeout(()=>{void stop('startup-expired','WORKER_START_TIMEOUT');},initializationTimeoutMs);
  }else if(value.type==='AgentCall'){
   if(!exact(value,['type','sessionId','ownerKey','requestId','request'])||!integer(value.requestId,1,Number.MAX_SAFE_INTEGER)||value.requestId<=lastAgentRequestId){void stop('protocol-rejected','WORKER_INVALID_AGENT_MESSAGE');return;}
   lastAgentRequestId=value.requestId;let captured;
   const replyError=error=>{if(!stopping){const safe=agentFailure(error);emit({type:'AgentResult',requestId:value.requestId,ok:false,error:{code:safe.code,outcome:safe.outcome}});}};
   try{captured=captureAgentRequest(value.request);}catch(error){replyError(agentFailure(error,'not-dispatched'));return;}
   if(!resourceReady||typeof resource?.agent!=='function'){replyError(new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched'));return;}
   const ending=captured.op==='end';if(ending?agentEnding:agentActive||agentEnding){replyError(new AgentRpcError('AGENT_RPC_BUSY','not-dispatched'));return;}
   let resolveWork,rejectWork;const slot={done:new Promise((resolve,reject)=>{resolveWork=resolve;rejectWork=reject;})};void slot.done.catch(()=>{});if(ending)agentEnding=slot;else agentActive=slot;
   // Install ownership before invoking the synchronous resource entry: it may
   // reenter stop(), and end must fence a running composite immediately.
   try{Promise.resolve(resource.agent(captured)).then(resolveWork,rejectWork);}catch(error){rejectWork(error);}
   const retire=()=>{if(agentActive===slot)agentActive=null;if(agentEnding===slot)agentEnding=null;};
   void slot.done.then(result=>{
    if(stopping){retire();return;}
    let capturedResult;try{capturedResult=captureAgentResult(result,agentReplyExpectation(captured),identity);}catch{replyError(new AgentRpcError('AGENT_INPUT_FAILED','unknown'));void stop('resource-unavailable','WORKER_AGENT_RESULT_INVALID');return;}
    retire();emit({type:'AgentResult',requestId:value.requestId,ok:true,result:capturedResult});
   },error=>{retire();replyError(agentFailure(error));});
  }else if((value.type==='OwnerHeartbeat'||value.type==='Close')&&started&&exact(value,['type','sessionId','ownerKey'])){
   if(value.type==='OwnerHeartbeat')armLease();else void stop('released');
  }else void stop('protocol-rejected','WORKER_INVALID_MESSAGE');
 };
 function data(chunk){
  if(stopping||finished)return;
  if(!Buffer.isBuffer(chunk)){void stop('protocol-rejected','WORKER_INVALID_FRAME');return;}
  let offset=0;
  while(offset<chunk.length&&!stopping){
   const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,length=end-offset;
   if(bytes+length>maxFrameBytes){void stop('protocol-rejected','WORKER_FRAME_LIMIT');return;}
   if(length){chunk.copy(frameBuffer,bytes,offset,end);bytes+=length;}
   if(newline<0)return;
   let value;
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(frameBuffer.subarray(0,bytes)));}
   catch{void stop('protocol-rejected','WORKER_INVALID_FRAME');return;}
   frameBuffer.fill(0,0,bytes);bytes=0;message(value);
   offset=end+1;
  }
 }
 input.on('data',data);input.once('end',lost);input.on('error',lost);output.on('error',lost);owner.on('SIGTERM',terminate);owner.on('SIGINT',terminate);owner.on('disconnect',lost);
 startTimer=setTimeout(()=>{void stop('start-expired','WORKER_START_HANDSHAKE_TIMEOUT');},startTimeoutMs);
 let witness=null;
 if(runtimeWitness!==null){try{const value=runtimeWitness();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});throw new TypeError('Asynchronous runtime collector is unsupported');}witness=validateLinuxRuntimeWitness(value);}catch{void stop('startup-failed','WORKER_RUNTIME_WITNESS_FAILED');}}
 if(!stopping){emit({type:'WorkerHello',...(witness?{runtimeWitness:witness}:{})});input.resume();}
 return Object.freeze({done,stop:()=>stop('runtime-stop')});
}
