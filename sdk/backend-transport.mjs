// Internal Node backend transport shared by Session and Agent clients.
export class SessionClientError extends Error {
 constructor(code,{status=null,requestId=null,outcome='unknown',retryable=false}={}){super(code==='CLIENT_INVALID_REQUEST'?'Invalid Session client request':'Session API request failed');this.name='SessionClientError';this.code=code;this.status=status;this.requestId=requestId;this.outcome=outcome;this.retryable=retryable;}
}
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const code=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(v)&&!v.startsWith('CLIENT_');
const retryStatus=status=>status===408||status===429||status>=500;
export function freezeBackendData(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freezeBackendData(child);Object.freeze(value);}return value;}
export function createBackendTransport(config,{validate,ErrorClass=SessionClientError,agentErrors=false,endKind=null}={}){
 const fail=(code,options)=>{throw new ErrorClass(code,options);},invalid=()=>fail('CLIENT_INVALID_REQUEST',{outcome:'not-dispatched'});
 const options=(value,allowed)=>{if(!plain(value)||Reflect.ownKeys(value).some(k=>!allowed.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))invalid();return Object.fromEntries(Object.keys(value).map(k=>[k,value[k]]));};
 const captured=options(config,['baseUrl','apiKey','fetch','timeoutMs','retries','maxResponseBytes','maxConcurrentRequests',...(endKind?['maxConcurrentEndRequests']:[])]);
 if(typeof window!=='undefined'||typeof process==='undefined'||process.release?.name!=='node')throw TypeError('Management clients require a Node.js backend');
 let url;try{url=new URL(captured.baseUrl);}catch{invalid();}if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))invalid();
 const timeout=captured.timeoutMs??10000,retries=captured.retries??0,maxBytes=captured.maxResponseBytes??65536,max=captured.maxConcurrentRequests??64,maxEnd=captured.maxConcurrentEndRequests??8,fetch=captured.fetch??globalThis.fetch,apiKey=captured.apiKey,base=url.origin;
 if(typeof apiKey!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)||!integer(timeout,50,60000)||!integer(retries,0,3)||!integer(maxBytes,1024,1048576)||!integer(max,1,256)||!integer(maxEnd,1,64)||typeof fetch!=='function'||typeof validate!=='function')invalid();
 const ordinary=new Set(),ending=new Set();
 const cancelled=signal=>{if(signal?.aborted)fail('CLIENT_ABORTED',{outcome:'not-dispatched'});};
 async function read(response,signal){
  const length=response.headers.get('content-length');let reader,cancellation=null;
  const cancel=()=>{if(!cancellation)cancellation=Promise.resolve().then(()=>reader?reader.cancel():response.body?.cancel()).catch(()=>{});return cancellation;};
  const abort=()=>{void cancel();};signal.addEventListener('abort',abort,{once:true});
  try{
   if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maxBytes)){await cancel();fail('CLIENT_INVALID_RESPONSE');}
   reader=response.body?.getReader();if(!reader)fail('CLIENT_INVALID_RESPONSE');if(signal.aborted)abort();let size=0;const chunks=[];
   for(;;){if(signal.aborted)throw signal.reason;const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)fail('CLIENT_INVALID_RESPONSE');chunks.push(part.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }catch(error){await cancel();if(error instanceof ErrorClass)throw error;fail('CLIENT_INVALID_RESPONSE');}finally{signal.removeEventListener('abort',abort);if(cancellation)await cancellation;reader?.releaseLock();}
 }
 async function attempt(method,path,body,key,expect,outer){
  cancelled(outer);const slots=endKind&&expect.kind===endKind?ending:ordinary,bound=slots===ending?maxEnd:max;if(slots.size>=bound)fail('CLIENT_CAPACITY',{outcome:'not-dispatched'});
  const slot={};slots.add(slot);const controller=new AbortController();let dispatched=false,timedOut=false,deadlineReject;
  const abort=()=>controller.abort();outer?.addEventListener('abort',abort,{once:true});if(outer?.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout),deadline=new Promise((_,reject)=>{deadlineReject=()=>reject(new ErrorClass(outer?.aborted?'CLIENT_ABORTED':'CLIENT_TIMEOUT',{outcome:dispatched?'unknown':'not-dispatched',retryable:!outer?.aborted}));controller.signal.addEventListener('abort',deadlineReject,{once:true});if(controller.signal.aborted)deadlineReject();});
  const work=(async()=>{
   if(controller.signal.aborted)fail('CLIENT_ABORTED',{outcome:'not-dispatched'});dispatched=true;
   const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+apiKey,...(body===null?{}:{'content-type':'application/json'}),...(key===null?{}:{'idempotency-key':key})},body:body??undefined,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
   if(controller.signal.aborted){try{await response.body?.cancel();}catch{}fail('CLIENT_TIMEOUT');}
   const status=response.status;if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')){try{await response.body?.cancel();}catch{}fail(status>=400?'CLIENT_HTTP_ERROR':'CLIENT_INVALID_RESPONSE',{status,retryable:status>=400&&retryStatus(status)});}
   let value;try{value=await read(response,controller.signal);}catch(error){if(status>=400)fail('CLIENT_HTTP_ERROR',{status,retryable:retryStatus(status)});throw error;}
   const requestId=value?.requestId;if(typeof requestId!=='string'||!/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId)||response.headers.get('x-request-id')!==requestId)fail('CLIENT_INVALID_RESPONSE',{status});
   if(status>=400){
    const hasOutcome=agentErrors&&Object.hasOwn(value.error??{},'outcome');if(!exact(value,['error','requestId'])||!exact(value.error,hasOutcome?['code','message','outcome']:['code','message'])||!code(value.error.code)||typeof value.error.message!=='string'||!value.error.message.length||value.error.message.length>512||hasOutcome&&!['not-dispatched','unknown'].includes(value.error.outcome))fail('CLIENT_INVALID_RESPONSE',{status,requestId});
    fail(value.error.code,{status,requestId,outcome:hasOutcome?value.error.outcome:status<500&&status!==408?'rejected':'unknown',retryable:retryStatus(status)});
   }
   if(!exact(value,['data','requestId'])||![200,202].includes(status)||!validate(status,value.data,expect,response.headers))fail('CLIENT_INVALID_RESPONSE',{status,requestId});return freezeBackendData({data:value.data,requestId});
  })();
  // Observer completion never releases actual fetch/body/cancellation capacity.
  const tracked=work.then(value=>{slots.delete(slot);return value;},error=>{slots.delete(slot);throw error;});
  try{return await Promise.race([tracked,deadline]);}catch(error){if(outer?.aborted)fail('CLIENT_ABORTED',{outcome:dispatched?'unknown':'not-dispatched'});if(timedOut)fail('CLIENT_TIMEOUT',{outcome:dispatched?'unknown':'not-dispatched',retryable:true});if(error instanceof ErrorClass)throw error;fail('CLIENT_TRANSPORT_ERROR',{outcome:dispatched?'unknown':'not-dispatched',retryable:true});}
  finally{clearTimeout(timer);outer?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',deadlineReject);}
 }
 return Object.freeze({
  async request(method,path,body,key,expect,value={}){
   const request=options(value,['signal','retries']);if(request.signal!==undefined&&!(request.signal instanceof AbortSignal)||request.retries!==undefined&&!integer(request.retries,0,3))invalid();const signal=request.signal,count=request.retries??retries;let uncertain=false;
   for(let n=0;;n++){try{return await attempt(method,path,body,key,expect,signal);}catch(error){if(!(error instanceof ErrorClass))throw error;if(uncertain&&error.outcome!=='unknown')error=new ErrorClass(error.code,{status:error.status,requestId:error.requestId,outcome:'unknown',retryable:error.retryable});uncertain||=error.outcome==='unknown';if(!error.retryable||n>=count||signal?.aborted)throw error;}}
  },
  status:()=>Object.freeze({ordinary:ordinary.size,ending:ending.size})
 });
}
