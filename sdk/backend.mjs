import {SessionClientError,createBackendTransport} from './backend-transport.mjs';
export {AgentClient,AgentClientError} from './agent.mjs';
const operationStatuses=new Set(['pending','succeeded','failed']);
const states=new Set(['creating','ready','closing','closed','expired','failed','cleanup-failed','recovery-required']);
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','worker-unavailable']);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const string=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const id=(v,prefix)=>typeof v==='string'&&v.startsWith(prefix)&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const nullable=(v,check)=>v===null||check(v);
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const operationKeys=['operationId','sessionId','kind','status','createdAt','updatedAt','error'];
const sessionKeys=['sessionId','region','state','createdAt','version','ttlSeconds','readyAt','expiresAt','closeReason','holdsQuota'];
export {SessionClientError} from './backend-transport.mjs';
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
function checkOptions(value){options(value,['signal','retries']);if(value.signal!==undefined&&!(value.signal instanceof AbortSignal)||value.retries!==undefined&&!integer(value.retries,0,3))invalid();return value;}
function validateSessionResult(status,data,expect){
 if(expect.kind==='session')return status===200&&session(data)&&data.sessionId===expect.id;
 return operation(data)&&!(expect.kind==='operation'&&data.operationId!==expect.id||expect.kind!=='operation'&&data.kind!==expect.kind||expect.kind==='release-session'&&data.sessionId!==expect.id||status===202&&(data.status!=='pending'||expect.kind==='operation')||expect.kind!=='operation'&&status===200&&data.status==='pending');
}

// Backend-only management client. No automatic retries unless explicitly requested.
// Prepared creation captures the original body and key for every send/retry.
export class SessionClient {
 #transport;
 constructor(config){
  this.#transport=createBackendTransport(config,{validate:validateSessionResult});
  Object.defineProperty(this,'sessions',{value:Object.freeze({
   prepareCreate:(value,request)=>this.#prepare(value,request),
   create:(value,request)=>{options(request,['idempotencyKey','signal','retries']);return this.#prepare(value,{idempotencyKey:request.idempotencyKey}).send({signal:request.signal,retries:request.retries});},
   get:(sessionId,request={})=>{if(!id(sessionId,'ses_'))invalid();return this.#transport.request('GET','/v1/sessions/'+sessionId,null,null,{kind:'session',id:sessionId},checkOptions(request));},
   release:(sessionId,request={})=>{if(!id(sessionId,'ses_'))invalid();return this.#transport.request('DELETE','/v1/sessions/'+sessionId,null,null,{kind:'release-session',id:sessionId},checkOptions(request));}
  }),enumerable:true});
  Object.defineProperty(this,'operations',{value:Object.freeze({get:(operationId,request={})=>{if(!id(operationId,'op_'))invalid();return this.#transport.request('GET','/v1/operations/'+operationId,null,null,{kind:'operation',id:operationId},checkOptions(request));}}),enumerable:true});
 }
 #prepare(value,request){
  options(request,['idempotencyKey']);const key=request.idempotencyKey;if(typeof key!=='string'||!/^[\x21-\x7e]{1,128}$/.test(key))invalid();const body=input(value);
  return Object.freeze({send:(sendOptions={})=>this.#transport.request('POST','/v1/sessions',body,key,{kind:'create-session'},checkOptions(sendOptions))});
 }
}
