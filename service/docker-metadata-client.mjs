import {request as httpRequest} from 'node:http';
import {isAbsolute} from 'node:path';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const identity=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const arch=v=>({aarch64:'arm64',arm64:'arm64',x86_64:'amd64',amd64:'amd64'})[v]??null;
export class DockerMetadataError extends Error {
 constructor(code,{status=null,bytes=0}={}){super('Docker runtime metadata is unavailable');this.name='DockerMetadataError';this.code=code;this.status=status;this.bytes=bytes;}
}
const fault=(code,fields)=>new DockerMetadataError(code,fields);
// Read-only local Engine API client. No proxy, redirect, implicit retry or
// endpoint discovery. Neither socket closure nor metadata proves retirement.
export class DockerMetadataClient {
 #socket;#daemon;#arch;#api;#timeout;#limit;#concurrency;#runtimeLimit;#active=new Set();#closed=false;#closePromise=null;#drainResolve;#drained;
 constructor({socketPath,daemonId,architecture='arm64',apiVersion='1.45',timeoutMs=5000,maxResponseBytes=128*1024,maxConcurrent=4,maxRuntimeRecords=128}={}){
  if(typeof socketPath!=='string'||!isAbsolute(socketPath)||socketPath.length>1024||socketPath.includes('\0')||!identity(daemonId)||!['arm64','amd64'].includes(architecture)||typeof apiVersion!=='string'||!/^1\.[0-9]{2,3}$/.test(apiVersion)||!integer(timeoutMs,20,30000)||!integer(maxResponseBytes,1024,1024*1024)||!integer(maxConcurrent,1,16)||!integer(maxRuntimeRecords,1,4096))throw new TypeError('Configure a pinned local Docker socket,identity and finite metadata limits');
  this.#socket=socketPath;this.#daemon=daemonId;this.#arch=architecture;this.#api='/v'+apiVersion;this.#timeout=timeoutMs;this.#limit=maxResponseBytes;this.#concurrency=maxConcurrent;this.#runtimeLimit=maxRuntimeRecords;this.#drained=new Promise(resolve=>{this.#drainResolve=resolve;});
 }
 status(){return Object.freeze({closed:this.#closed,activeRequests:this.#active.size,maxConcurrent:this.#concurrency,maxResponseBytes:this.#limit,operationDeadlineMs:this.#timeout,maxRuntimeRecords:this.#runtimeLimit});}
 #context(signal){if(this.#closed)throw fault('ENGINE_CLIENT_CLOSED');if(signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Expected AbortSignal');return {signal,end:performance.now()+this.#timeout};}
 #check(context){if(this.#closed)throw fault('ENGINE_CLIENT_CLOSED');if(context.signal?.aborted)throw fault('ENGINE_ABORTED');if(performance.now()>=context.end)throw fault('ENGINE_DEADLINE');}
 #json(path,context,{absent=false,array=false}={}){
  this.#check(context);if(this.#active.size>=this.#concurrency)throw fault('ENGINE_BUSY');
  return new Promise((resolve,reject)=>{
   let req,res,buffer=null,used=0,settled=false,delivered=false,pendingValue,timer,abort;
   const state={cancel:code=>finish(fault(code)),done:false};this.#active.add(state);
   const release=()=>{if(state.done)return;state.done=true;this.#active.delete(state);if(this.#closed&&!this.#active.size)this.#drainResolve();};
   const cleanup=()=>{clearTimeout(timer);context.signal?.removeEventListener('abort',abort);buffer?.fill(0);buffer=null;};
   const finish=(error,value)=>{
    if(delivered||settled&&!error)return;
    settled=true;buffer?.fill(0);buffer=null;
    if(error){delivered=true;cleanup();res?.destroy();req?.destroy();reject(error);}
    else{pendingValue=value;req.destroy();}
   };
   abort=()=>finish(fault('ENGINE_ABORTED'));context.signal?.addEventListener('abort',abort,{once:true});
   try{
    req=httpRequest({socketPath:this.#socket,path:this.#api+path,method:'GET',agent:false,headers:{Accept:'application/json'}},response=>{
     res=response;const status=response.statusCode;response.on('aborted',()=>finish(fault('ENGINE_INCOMPLETE',{status,bytes:used})));response.on('error',()=>finish(fault('ENGINE_IO')));
     if(status!==200&&!(absent&&status===404)){finish(fault('ENGINE_HTTP',{status}));return;}
     const length=response.headers['content-length'];if(length!==undefined&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>this.#limit)){finish(fault('ENGINE_BODY_LIMIT',{status}));return;}
     buffer=Buffer.allocUnsafeSlow(this.#limit);
     response.on('data',chunk=>{
      if(settled)return;try{this.#check(context);}catch(e){finish(e);return;}
      if(!Buffer.isBuffer(chunk)||used+chunk.length>this.#limit){finish(fault('ENGINE_BODY_LIMIT',{status,bytes:used+chunk.length}));return;}chunk.copy(buffer,used);used+=chunk.length;
     });
     response.on('end',()=>{
      if(settled)return;try{
       this.#check(context);if(!response.complete)throw fault('ENGINE_INCOMPLETE',{status,bytes:used});const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used)));
       if(!value||typeof value!=='object'||Array.isArray(value)!==array)throw fault('ENGINE_RESPONSE_INVALID');finish(null,{status,value});
      }catch(e){finish(e instanceof DockerMetadataError?e:fault('ENGINE_RESPONSE_INVALID'));}
     });
    });
    req.on('error',()=>finish(fault('ENGINE_IO')));req.on('close',()=>{if(!settled)finish(fault('ENGINE_INCOMPLETE',{bytes:used}));release();if(pendingValue&&!delivered){delivered=true;cleanup();try{this.#check(context);resolve(pendingValue);}catch(e){reject(e);}}});
    timer=setTimeout(()=>finish(fault('ENGINE_DEADLINE')),Math.max(1,context.end-performance.now()));this.#check(context);req.end();
   }catch(e){finish(e instanceof DockerMetadataError?e:fault('ENGINE_IO'));if(!req)release();}
  });
 }
 async #assertDaemon(context){
  const {value}=await this.#json('/info',context);if(value.ID!==this.#daemon)throw fault('ENGINE_ID_CHANGED');if(value.OSType!=='linux'||arch(value.Architecture)!==this.#arch)throw fault('ENGINE_PLATFORM_CHANGED');return Object.freeze({id:value.ID,os:value.OSType,architecture:this.#arch,version:typeof value.ServerVersion==='string'?value.ServerVersion:null});
 }
 async daemon({signal}={}){const context=this.#context(signal);return this.#assertDaemon(context);}
 async inspectContainer(selector,{signal}={}){
  if(typeof selector!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(selector))throw new TypeError('Expected a complete container ID or bounded name');
  const context=this.#context(signal);await this.#assertDaemon(context);const result=await this.#json('/containers/'+encodeURIComponent(selector)+'/json',context,{absent:true});const daemon=await this.#assertDaemon(context);
  if(result.status===404)return {found:false,daemon,selector};const v=result.value;if(typeof v.Id!=='string'||!/^[a-f0-9]{64}$/.test(v.Id)||typeof v.Name!=='string'||typeof v.Image!=='string')throw fault('ENGINE_RESPONSE_INVALID');return {found:true,daemon,document:v};
 }
 async inspectImage(imageId,{signal}={}){
  if(typeof imageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new TypeError('A pinned image digest is required');
  const context=this.#context(signal);await this.#assertDaemon(context);const {value}=await this.#json('/images/'+encodeURIComponent(imageId)+'/json',context);const daemon=await this.#assertDaemon(context);
  if(value.Id!==imageId||value.Os!=='linux'||arch(value.Architecture)!==this.#arch)throw fault('ENGINE_IMAGE_CHANGED');return {daemon,document:value};
 }
 // Candidate IDs require full inspection before any ownership or effect decision.
 // No server-side limit: a truncated inventory must never look complete.
 async listRuntimeCandidates({deploymentId,region,signal}={}){
  if(!identity(deploymentId)||typeof region!=='string'||!region.length||region.length>64||/[\x00-\x1f\x7f]/.test(region))throw new TypeError('Expected a fixed deployment and region');
  const prefix='org.remote-paint.runtime.',context=this.#context(signal),labels={[prefix+'deployment']:deploymentId,[prefix+'region']:region};
  await this.#assertDaemon(context);const filters={label:Object.entries(labels).map(([k,v])=>k+'='+v)};
  const {value}=await this.#json('/containers/json?all=1&filters='+encodeURIComponent(JSON.stringify(filters)),context,{array:true});const daemon=await this.#assertDaemon(context);
  if(value.length>this.#runtimeLimit)throw fault('ENGINE_INVENTORY_LIMIT');const ids=new Set();
  for(const row of value){
   if(!row||typeof row!=='object'||typeof row.Id!=='string'||!/^[a-f0-9]{64}$/.test(row.Id)||ids.has(row.Id)||!row.Labels||typeof row.Labels!=='object'||Array.isArray(row.Labels)||Object.entries({...labels,[prefix+'schema']:'session-runtime-v1',[prefix+'daemon']:this.#daemon}).some(([k,v])=>row.Labels[k]!==v))throw fault('ENGINE_INVENTORY_CONFLICT');
   ids.add(row.Id);
  }
  this.#check(context);return Object.freeze({daemon,deploymentId,region,containerIds:Object.freeze([...ids].sort()),scope:'Complete bounded label-filtered metadata snapshot only;not ownership,effect authorization,allocation absence or namespace retirement proof.'});
 }
 close(){
  if(this.#closePromise)return this.#closePromise;this.#closed=true;for(const state of this.#active)state.cancel('ENGINE_CLIENT_CLOSED');if(!this.#active.size)this.#drainResolve();
  this.#closePromise=(async()=>{let timer;try{return await Promise.race([this.#drained.then(()=>Object.freeze({status:'closed',activeRequests:0})),new Promise(resolve=>{timer=setTimeout(()=>resolve(Object.freeze({status:'unconfirmed',activeRequests:this.#active.size})),250);})]);}finally{clearTimeout(timer);}})();return this.#closePromise;
 }
}
