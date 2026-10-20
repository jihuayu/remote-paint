const codes=new Set(['VIEWER_CONFIG_INVALID','VIEWER_CONFIG_TIMEOUT','VIEWER_CONFIG_ABORTED']);
export class PublicViewerConfigError extends Error {constructor(code){super('Public Viewer configuration unavailable');this.name='PublicViewerConfigError';this.code=codes.has(code)?code:'VIEWER_CONFIG_INVALID';}}
const fail=()=>{throw new PublicViewerConfigError('VIEWER_CONFIG_INVALID');};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function origin(value){
 if(typeof value!=='string'||value.length>2048)fail();let url;try{url=new URL(value);}catch{fail();}
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail();return value;
}
function validate(value){
 const names=['schema','gatewayOrigin','allowedParentOrigins','viewerBuild'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==names.length||names.some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k)??{},'value'))||value.schema!=='public-viewer-v1'||!Array.isArray(value.allowedParentOrigins)||value.allowedParentOrigins.length>32||typeof value.viewerBuild!=='string'||!/^[a-f0-9]{64}$/.test(value.viewerBuild))fail();
 const gatewayOrigin=origin(value.gatewayOrigin),allowedParentOrigins=value.allowedParentOrigins.map(origin);
 if(new Set(allowedParentOrigins).size!==allowedParentOrigins.length||new TextEncoder().encode(gatewayOrigin+allowedParentOrigins.join('')).length>8192)fail();
 return Object.freeze({schema:value.schema,gatewayOrigin,allowedParentOrigins:Object.freeze(allowedParentOrigins),viewerBuild:value.viewerBuild});
}
// Fixed same-origin metadata endpoint. No cookies, API key, redirect, retry or
// Source lookup. Body bytes, headers and total wait are bounded before parsing.
export async function loadPublicViewerConfig({origin:viewerOrigin,fetch:fetcher=globalThis.fetch,signal,timeoutMs=5000}={}){
 const base=origin(viewerOrigin);if(typeof fetcher!=='function'||!integer(timeoutMs,50,10000)||signal!==undefined&&!(signal instanceof AbortSignal))fail();
 const controller=new AbortController();let timedOut=false,timer;
 const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 const deadline=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new PublicViewerConfigError(timedOut?'VIEWER_CONFIG_TIMEOUT':'VIEWER_CONFIG_ABORTED')),{once:true});timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);});if(signal?.aborted)controller.abort();
 const work=(async()=>{
  if(controller.signal.aborted)throw new PublicViewerConfigError('VIEWER_CONFIG_ABORTED');
  const response=await fetcher(base+'/viewer-config',{signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'});
  if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new PublicViewerConfigError('VIEWER_CONFIG_ABORTED');}
  const length=response.headers.get('content-length');
  if(response.status!==200||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>16384)){void response.body?.cancel().catch(()=>{});fail();}
  const reader=response.body?.getReader();if(!reader)fail();let size=0;const chunks=[];
  const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel();
  try{
   for(;;){if(controller.signal.aborted)throw new PublicViewerConfigError('VIEWER_CONFIG_ABORTED');const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16384)fail();chunks.push(part.value);}
   if(controller.signal.aborted)throw new PublicViewerConfigError('VIEWER_CONFIG_ABORTED');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   return validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }catch(error){void reader.cancel().catch(()=>{});throw error;}finally{controller.signal.removeEventListener('abort',cancel);reader.releaseLock();}
 })();
 try{return await Promise.race([work,deadline]);}catch(error){if(error instanceof PublicViewerConfigError)throw error;throw new PublicViewerConfigError('VIEWER_CONFIG_INVALID');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
