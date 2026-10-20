import {Agent,request} from 'node:http';
import {createConnection} from 'node:net';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dockerRuntimeCreateBody,verifyDockerRuntime,verifyDockerRuntimeOwnership} from './docker-runtime-spec.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const architecture=v=>({aarch64:'arm64',arm64:'arm64',x86_64:'amd64',amd64:'amd64'})[v];
export class DockerEffectError extends Error{
 constructor(code,{uncertain=false,status=null}={}){super('Docker runtime operation is unavailable');this.name='DockerEffectError';this.code=code;this.uncertain=uncertain;this.status=status;}
}
const fail=(code,fields)=>new DockerEffectError(code,fields);
class SingleConnectionAgent extends Agent{
 constructor(path){super({keepAlive:true,maxSockets:1,maxFreeSockets:1});this.path=path;this.created=false;this.socket=null;this.closed=false;this.drained=new Promise(resolve=>{this.resolveDrain=resolve;});}
 createConnection(_options,callback){
  if(this.created||this.closed){queueMicrotask(()=>callback(fail('EFFECT_CONNECTION_GONE')));return;}
  this.created=true;const socket=this.socket=createConnection({path:this.path});socket.once('close',()=>this.resolveDrain());return socket;
 }
 shutdown(){this.closed=true;this.destroy();if(!this.socket)this.resolveDrain();}
}
function authorize(receipt,kind,plan,cid){
 if(!receipt||!Number.isSafeInteger(receipt.revision)||receipt.revision<1||!receipt.allocation)throw fail('EFFECT_AUTHORIZATION');const row=receipt.allocation;
 for(const[k,v]of Object.entries({sessionId:plan.sessionId,tenant:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,ownerKeyHash:plan.ownerKeyHash,specDigest:plan.specDigest,imageId:plan.imageId,containerName:plan.containerName}))if(row[k]!==v)throw fail('EFFECT_AUTHORIZATION');
 if(row.requestStarted!==true||kind==='create'&&(row.state!=='requested'||row.containerId!==null)||kind==='start'&&(row.state!=='created'||row.containerId!==cid||row.version!==null||row.startDispatch!=='requested')||kind==='remove'&&(row.state!=='closing'||row.containerId!==cid))throw fail('EFFECT_AUTHORIZATION');return receipt.revision;
}
class EffectSession{
 constructor(client,options){this.client=client;Object.assign(this,options);this.agent=new SingleConnectionAgent(client.socketPath);this.connectionId=randomUUID();this.deadline=performance.now()+client.timeoutMs;this.attempted=false;this.closed=false;this.active=false;this.effectSent=false;this.inspection=null;this.profile=null;this.absent=false;this.currentCancel=null;this.armDeadline();}
 armDeadline(){this.leaseTimer=setTimeout(()=>{if(this.closed)return;if(performance.now()<this.deadline)this.armDeadline();else void this.close();},Math.max(1,Math.ceil(this.deadline-performance.now())));}
 check(){if(performance.now()>=this.deadline)throw fail('EFFECT_DEADLINE',{uncertain:this.effectSent});if(this.closed||this.client.state.closed)throw fail('EFFECT_SESSION_CLOSED',{uncertain:this.effectSent});if(this.signal?.aborted)throw fail('EFFECT_ABORTED',{uncertain:this.effectSent});}
 async initialize(){
  const {value}=await this.json('GET','/info',null,[200]);if(value?.ID!==this.plan.daemonId)throw fail('EFFECT_ENGINE_CHANGED');if(value.OSType!=='linux'||architecture(value.Architecture)!==this.client.architecture)throw fail('EFFECT_PLATFORM_CHANGED');
  this.daemon=Object.freeze({id:value.ID,architecture:this.client.architecture,os:'linux'});
  if(this.kind!=='create'){
   const found=await this.json('GET','/containers/'+this.containerId+'/json',null,[200,404]);this.absent=found.status===404;
   if(this.absent){if(this.kind==='start')throw fail('EFFECT_OBJECT_ABSENT');}
   else{this.inspection={found:true,daemon:this.daemon,document:found.value};verifyDockerRuntimeOwnership(this.plan,this.inspection,{containerId:this.containerId});try{this.profile=verifyDockerRuntime(this.plan,this.inspection,{containerId:this.containerId});}catch(e){if(this.kind==='start')throw e;}
    if(this.kind==='start'&&(this.profile.state!=='created'||this.profile.pid!==0))throw fail('EFFECT_START_CONFLICT');}
  }
  this.check();return this;
 }
 json(method,path,body,statuses,{effect=false}={}){
  this.check();if(this.active)throw fail('EFFECT_SESSION_BUSY');this.active=true;
  let payload;try{payload=body===null?null:Buffer.from(JSON.stringify(body));if(payload&&payload.length>this.client.maxRequestBytes)throw fail('EFFECT_REQUEST_LIMIT');}catch(e){this.active=false;throw e instanceof DockerEffectError?e:fail('EFFECT_REQUEST_INVALID');}
  return new Promise((resolve,reject)=>{
   let req,res,buffer=null,used=0,done=false,timer,abort;
   const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);this.signal?.removeEventListener('abort',abort);this.currentCancel=null;this.active=false;buffer?.fill(0);buffer=null;payload?.fill(0);if(error){res?.destroy();req?.destroy();reject(error);}else resolve(result);};
   const error=(code,fields={})=>finish(fail(code,{uncertain:this.effectSent,...fields}));this.currentCancel=()=>error(performance.now()>=this.deadline?'EFFECT_DEADLINE':'EFFECT_SESSION_CLOSED');abort=()=>error('EFFECT_ABORTED');this.signal?.addEventListener('abort',abort,{once:true});
   try{
    if(effect)this.effectSent=true;
    req=request({socketPath:this.client.socketPath,agent:this.agent,path:this.client.api+path,method,headers:{Accept:'application/json',Connection:'keep-alive',...(payload?{'content-type':'application/json','content-length':payload.length}:{})}},response=>{
     res=response;res.on('error',()=>error('EFFECT_IO'));res.on('aborted',()=>error('EFFECT_INCOMPLETE'));
     if(!statuses.includes(res.statusCode)){error('EFFECT_HTTP',{status:res.statusCode});return;}
     const length=res.headers['content-length'];if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>this.client.maxResponseBytes)){error('EFFECT_BODY_LIMIT');return;}
     buffer=Buffer.allocUnsafeSlow(this.client.maxResponseBytes);res.on('data',chunk=>{if(done)return;try{this.check();}catch(e){finish(e);return;}if(!Buffer.isBuffer(chunk)||used+chunk.length>buffer.length){error('EFFECT_BODY_LIMIT');return;}chunk.copy(buffer,used);used+=chunk.length;});
     res.on('end',()=>{if(done)return;try{this.check();if(!res.complete)throw fail('EFFECT_INCOMPLETE',{uncertain:this.effectSent});let value=null;if(used)value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));if(value!==null&&(!value||typeof value!=='object'||Array.isArray(value)))throw fail('EFFECT_REPLY_INVALID',{uncertain:this.effectSent});finish(null,{status:res.statusCode,value});}catch(e){finish(e instanceof DockerEffectError?e:fail('EFFECT_REPLY_INVALID',{uncertain:this.effectSent}));}});
    });
    req.on('socket',socket=>{if(socket!==this.agent.socket)error('EFFECT_CONNECTION_CHANGED');});req.on('error',()=>error('EFFECT_IO'));const onDeadline=()=>{if(performance.now()<this.deadline)timer=setTimeout(onDeadline,Math.max(1,Math.ceil(this.deadline-performance.now())));else error('EFFECT_DEADLINE');};timer=setTimeout(onDeadline,Math.max(1,Math.ceil(this.deadline-performance.now())));this.check();req.end(payload);
   }catch(e){finish(e instanceof DockerEffectError?e:fail('EFFECT_IO',{uncertain:this.effectSent}));}
  });
 }
 async perform(beforeSend){
  this.check();if(this.attempted)throw fail('EFFECT_ALREADY_ATTEMPTED',{uncertain:this.effectSent});this.attempted=true;if(typeof beforeSend!=='function')throw fail('EFFECT_AUTHORIZATION');
  let receipt;try{receipt=beforeSend();if(receipt&&typeof receipt.then==='function'){void Promise.resolve(receipt).catch(()=>{});throw fail('EFFECT_ASYNC_AUTHORIZATION');}}catch(e){throw e instanceof DockerEffectError?e:fail('EFFECT_AUTHORIZATION');}
  const revision=authorize(receipt,this.kind,this.plan,this.containerId);this.check();let response;
  if(this.kind==='create')response=await this.json('POST','/containers/create?name='+encodeURIComponent(this.plan.containerName),dockerRuntimeCreateBody(this.plan),[201],{effect:true});
  else if(this.kind==='start')response=await this.json('POST','/containers/'+this.containerId+'/start',null,[204],{effect:true});
  else if(this.absent)response={status:404,value:null};
  else response=await this.json('DELETE','/containers/'+this.containerId+'?force=true',null,[204],{effect:true});
  const cid=this.kind==='create'?response.value?.Id:this.containerId;if(!hash(cid))throw fail('EFFECT_REPLY_INVALID',{uncertain:this.effectSent});
  if(this.kind==='create'&&response.value?.Warnings!=null&&(!Array.isArray(response.value.Warnings)||response.value.Warnings.length))throw fail('EFFECT_RUNTIME_WARNING',{uncertain:true});
  return Object.freeze({kind:this.kind,containerId:cid,daemonId:this.plan.daemonId,connectionId:this.connectionId,httpStatus:response.status,authorizationRevision:revision,effectAttempted:this.effectSent,alreadyAbsent:this.absent,scope:'One Engine operation on the identity-checked connection;not worker readiness or namespace retirement proof.'});
 }
 facade(){return Object.freeze({kind:this.kind,connectionId:this.connectionId,inspect:()=>structuredClone({inspection:this.inspection,profile:this.profile,absent:this.absent}),perform:callback=>this.perform(callback),close:()=>this.close()});}
 close(){if(this.closePromise)return this.closePromise;this.closed=true;clearTimeout(this.leaseTimer);this.currentCancel?.();this.agent.shutdown();this.closePromise=(async()=>{let timer;try{return await Promise.race([this.agent.drained.then(()=>{this.client.state.sessions.delete(this);return{status:'closed',connectionId:this.connectionId};}),new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'unconfirmed',connectionId:this.connectionId}),250);})]);}finally{clearTimeout(timer);}})();return this.closePromise;}
}
export class DockerEffectClient{
 #config;#state={sessions:new Set(),closed:false,closePromise:null};
 constructor({socketPath,daemonId,architecture='arm64',apiVersion='1.45',timeoutMs=5000,maxRequestBytes=65536,maxResponseBytes=131072,maxConcurrent=4}={}){
  if(typeof socketPath!=='string'||!isAbsolute(socketPath)||socketPath.length>1024||socketPath.includes('\0')||!id(daemonId)||!['arm64','amd64'].includes(architecture)||!/^1\.[0-9]{2,3}$/.test(apiVersion)||!integer(timeoutMs,20,30000)||!integer(maxRequestBytes,1024,131072)||!integer(maxResponseBytes,1024,1048576)||!integer(maxConcurrent,1,16))throw new TypeError('Configure a pinned local Engine and bounded effect sessions');this.#config=Object.freeze({socketPath,daemonId,architecture,api:'/v'+apiVersion,timeoutMs,maxRequestBytes,maxResponseBytes,maxConcurrent,state:this.#state});Object.freeze(this);
 }
 status(){return Object.freeze({closed:this.#state.closed,activeSessions:this.#state.sessions.size,maxConcurrent:this.#config.maxConcurrent});}
 async open({kind,plan,containerId=null,signal}={}){
  if(this.#state.closed)throw fail('EFFECT_CLIENT_CLOSED');if(!['create','start','remove'].includes(kind)||kind==='create'&&containerId!==null||kind!=='create'&&!hash(containerId)||signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Expected fixed runtime operation and complete identity');dockerRuntimeCreateBody(plan);if(plan.daemonId!==this.#config.daemonId)throw fail('EFFECT_ENGINE_CHANGED');if(this.#state.sessions.size>=this.#config.maxConcurrent)throw fail('EFFECT_BUSY');const s=new EffectSession(this.#config,{kind,plan:structuredClone(plan),containerId,signal});this.#state.sessions.add(s);try{await s.initialize();return s.facade();}catch(e){await s.close();throw e;}
 }
 async close(){if(this.#state.closePromise)return this.#state.closePromise;this.#state.closed=true;this.#state.closePromise=Promise.all([...this.#state.sessions].map(s=>s.close())).then(rows=>Object.freeze({status:rows.every(x=>x.status==='closed')?'closed':'unconfirmed',activeSessions:this.#state.sessions.size}));return this.#state.closePromise;}
}
