const operationStatuses=new Set(['pending','succeeded','failed']);
const states=new Set(['creating','ready','closing','closed','expired','failed','cleanup-failed','recovery-required']);
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault']);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const string=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const id=(v,prefix)=>typeof v==='string'&&v.startsWith(prefix)&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const nullable=(v,check)=>v===null||check(v);
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const operationKeys=['operationId','sessionId','kind','status','createdAt','updatedAt','error'];
const sessionKeys=['sessionId','region','state','createdAt','version','ttlSeconds','readyAt','expiresAt','closeReason','holdsQuota'];
const retryStatus=status=>status===408||status===429||status>=500;
export class SessionClientError extends Error {
 constructor(code,{status=null,requestId=null,outcome='unknown',retryable=false}={}){
  super(code==='CLIENT_INVALID_REQUEST'?'Invalid Session client request':'Session API request failed');
  this.name='SessionClientError';this.code=code;this.status=status;this.requestId=requestId;this.outcome=outcome;this.retryable=retryable;
 }
}
const fail=(code,options)=>{throw new SessionClientError(code,options);};
const invalid=()=>fail('CLIENT_INVALID_REQUEST',{outcome:'not-dispatched'});
function options(value,allowed){
 if(!plain(value)||Reflect.ownKeys(value).some(k=>!allowed.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))invalid();
 return value;
}
function input(value){
 options(value,['url','region','ttlSeconds']);const captured={};
 for(const name of ['url','region','ttlSeconds'])if(value[name]!==undefined)captured[name]=value[name];
 if(captured.url!==undefined){
  if(!string(captured.url,8192))invalid();let parsed;try{parsed=new URL(captured.url);}catch{invalid();}
  if(captured.url!=='about:blank'&&(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password))invalid();captured.url=parsed.href;
 }
 if(captured.region!==undefined&&!string(captured.region,64)||captured.ttlSeconds!==undefined&&!integer(captured.ttlSeconds,1,86400))invalid();
 return JSON.stringify(captured);
}
function operation(value){
 if(!exact(value,operationKeys)||!id(value.operationId,'op_')||!id(value.sessionId,'ses_')||!['create-session','release-session'].includes(value.kind)||!operationStatuses.has(value.status)||!date(value.createdAt)||!date(value.updatedAt))return false;
 if(value.error!==null&&(!exact(value.error,['code','message'])||!code(value.error.code)||!string(value.error.message,512)))return false;
 return (value.status==='failed')===(value.error!==null);
}
function session(value){
 if(!exact(value,sessionKeys)||!id(value.sessionId,'ses_')||!string(value.region,64)||!states.has(value.state)||!date(value.createdAt)||!nullable(value.version,v=>string(v,256))||!integer(value.ttlSeconds,1,86400)||!nullable(value.readyAt,date)||!nullable(value.expiresAt,date)||!nullable(value.closeReason,v=>reasons.has(v))||typeof value.holdsQuota!=='boolean')return false;
 if(value.state==='ready'&&(!value.version||!value.readyAt||!value.expiresAt||!value.holdsQuota))return false;
 if(['closed','expired','failed'].includes(value.state)&&value.holdsQuota)return false;return true;
}
const code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(v);
function frozen(value){if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function cancelled(signal){if(signal?.aborted)fail('CLIENT_ABORTED',{outcome:'not-dispatched'});}
function signalOption(signal){if(signal!==undefined&&!(signal instanceof AbortSignal))invalid();return signal;}
function checkOptions(value){options(value,['signal','retries']);signalOption(value.signal);if(value.retries!==undefined&&!integer(value.retries,0,3))invalid();return value;}
async function read(response,maxBytes,signal){
 const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>maxBytes)){void response.body?.cancel().catch(()=>{});fail('CLIENT_INVALID_RESPONSE');}
 const reader=response.body?.getReader();if(!reader)fail('CLIENT_INVALID_RESPONSE');let size=0;const chunks=[];
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{
  for(;;){if(signal.aborted)throw signal.reason;const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)fail('CLIENT_INVALID_RESPONSE');chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 }catch(error){void reader.cancel().catch(()=>{});if(error instanceof SessionClientError)throw error;fail('CLIENT_INVALID_RESPONSE');}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}

// Backend-only management client. No automatic retries unless explicitly requested.
// Prepared creation captures the original body and key for every send/retry.
export class SessionClient {
 #base;#apiKey;#fetch;#timeout;#retries;#maxBytes;
 constructor(config){
  options(config,['baseUrl','apiKey','fetch','timeoutMs','retries','maxResponseBytes']);
  if(typeof window!=='undefined'||typeof process==='undefined'||process.release?.name!=='node')throw new TypeError('Session management client requires a Node.js backend');
  let url;try{url=new URL(config.baseUrl);}catch{invalid();}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))invalid();
  if(typeof config.apiKey!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(config.apiKey))invalid();
  const timeout=config.timeoutMs??10000,retries=config.retries??0,maxBytes=config.maxResponseBytes??65536;
  if(!integer(timeout,50,60000)||!integer(retries,0,3)||!integer(maxBytes,1024,1048576)||typeof(config.fetch??globalThis.fetch)!=='function')invalid();
  this.#base=url.origin;this.#apiKey=config.apiKey;this.#fetch=config.fetch??globalThis.fetch;this.#timeout=timeout;this.#retries=retries;this.#maxBytes=maxBytes;
  Object.defineProperty(this,'sessions',{value:Object.freeze({
   prepareCreate:(value,request)=>this.#prepare(value,request),
   create:(value,request)=>{options(request,['idempotencyKey','signal','retries']);return this.#prepare(value,{idempotencyKey:request.idempotencyKey}).send({signal:request.signal,retries:request.retries});},
   get:(sessionId,request={})=>{if(!id(sessionId,'ses_'))invalid();return this.#request('GET','/v1/sessions/'+sessionId,null,null,{kind:'session',id:sessionId},checkOptions(request));},
   release:(sessionId,request={})=>{if(!id(sessionId,'ses_'))invalid();return this.#request('DELETE','/v1/sessions/'+sessionId,null,null,{kind:'release-session',id:sessionId},checkOptions(request));}
  }),enumerable:true});
  Object.defineProperty(this,'operations',{value:Object.freeze({get:(operationId,request={})=>{if(!id(operationId,'op_'))invalid();return this.#request('GET','/v1/operations/'+operationId,null,null,{kind:'operation',id:operationId},checkOptions(request));}}),enumerable:true});
 }
 #prepare(value,request){
  options(request,['idempotencyKey']);const key=request.idempotencyKey;if(typeof key!=='string'||!/^[\x21-\x7e]{1,128}$/.test(key))invalid();const body=input(value);
  return Object.freeze({send:(sendOptions={})=>this.#request('POST','/v1/sessions',body,key,{kind:'create-session'},checkOptions(sendOptions))});
 }
 async #request(method,path,body,key,expect,request){
  const signal=request.signal,retries=request.retries??this.#retries;cancelled(signal);
  for(let attempt=0;;attempt++){
   try{return await this.#attempt(method,path,body,key,expect,signal);}catch(error){
    if(!(error instanceof SessionClientError)||!error.retryable||attempt>=retries||signal?.aborted)throw error;
   }
  }
 }
 async #attempt(method,path,body,key,expect,outer){
  cancelled(outer);const controller=new AbortController();let dispatched=false,timedOut=false;
  const abort=()=>controller.abort();outer?.addEventListener('abort',abort,{once:true});if(outer?.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.#timeout);
  let deadlineReject;const deadline=new Promise((_,reject)=>{deadlineReject=()=>reject(new SessionClientError(outer?.aborted?'CLIENT_ABORTED':'CLIENT_TIMEOUT',{outcome:dispatched?'unknown':'not-dispatched',retryable:!outer?.aborted}));controller.signal.addEventListener('abort',deadlineReject,{once:true});if(controller.signal.aborted)deadlineReject();});
  try{
   const work=(async()=>{
    if(controller.signal.aborted)throw new SessionClientError('CLIENT_ABORTED',{outcome:'not-dispatched'});
    dispatched=true;const response=await this.#fetch(this.#base+path,{method,headers:{authorization:'Bearer '+this.#apiKey,...(body===null?{}:{'content-type':'application/json','idempotency-key':key})},body:body??undefined,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new SessionClientError('CLIENT_TIMEOUT');}
    const status=response.status;let value;
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>{});fail(status>=400?'CLIENT_HTTP_ERROR':'CLIENT_INVALID_RESPONSE',{status,retryable:status>=400&&retryStatus(status)});}
    try{value=await read(response,this.#maxBytes,controller.signal);}catch(error){if(status>=400)fail('CLIENT_HTTP_ERROR',{status,retryable:retryStatus(status)});throw error;}
    const requestId=value?.requestId;
    if(!id(requestId,'req_')||response.headers.get('x-request-id')!==requestId)fail('CLIENT_INVALID_RESPONSE',{status});
    if(status>=400){
     if(!exact(value,['error','requestId'])||!exact(value.error,['code','message'])||(!code(value.error.code)||value.error.code.startsWith('CLIENT_'))||!string(value.error.message,512))fail('CLIENT_INVALID_RESPONSE',{status});
     fail(value.error.code,{status,requestId,outcome:status<500&&status!==408?'rejected':'unknown',retryable:retryStatus(status)});
    }
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||!exact(value,['data','requestId'])||![200,202].includes(status))fail('CLIENT_INVALID_RESPONSE',{status,requestId});
    const data=value.data;
    if(expect.kind==='session'){
     if(status!==200||!session(data)||data.sessionId!==expect.id)fail('CLIENT_INVALID_RESPONSE',{status,requestId});
    }else{
     if(!operation(data)||expect.kind==='operation'&&data.operationId!==expect.id||expect.kind!=='operation'&&data.kind!==expect.kind||expect.kind==='release-session'&&data.sessionId!==expect.id||status===202&&(data.status!=='pending'||expect.kind==='operation')||expect.kind!=='operation'&&status===200&&data.status==='pending')fail('CLIENT_INVALID_RESPONSE',{status,requestId});
    }
    return frozen({data,requestId});
   })();
   return await Promise.race([work,deadline]);
  }catch(error){
   if(outer?.aborted)fail('CLIENT_ABORTED',{outcome:dispatched?'unknown':'not-dispatched'});
   if(timedOut)fail('CLIENT_TIMEOUT',{outcome:dispatched?'unknown':'not-dispatched',retryable:true});
   if(error instanceof SessionClientError)throw error;
   fail('CLIENT_TRANSPORT_ERROR',{outcome:dispatched?'unknown':'not-dispatched',retryable:true});
  }finally{clearTimeout(timer);outer?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',deadlineReject);}
 }
}
