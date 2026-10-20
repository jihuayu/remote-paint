// Backend-only actual Page download DTOs and bounded binary receiver.
import {createHash} from 'node:crypto';
import {freezeBackendData} from './backend-transport.mjs';
import {captureObservationContext} from './agent-observation.mjs';
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const id=v=>typeof v==='string'&&/^dl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),emptyHash=createHash('sha256').digest('hex');
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const ctxFields=['agentRunId','sessionId','version','binding','document'],bindingFields=['tenantId','sessionId','targetId','runId'],documentFields=['controlSessionId','pageEpoch','viewportVersion'];
const base=[...ctxFields,'stage','downloadId'],meta=[...base,'scope','armedAt','limits'],readyFields=[...meta,'completedAt','fileName','mimeType','byteLength','sha256'],chunkFields=[...base,'sha256','completedAt','offset','byteLength','totalBytes','data','complete'];
function data(value,allowed,required,invalid){if(!plain(value))invalid();const d=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.some(k=>!allowed.includes(k)||!Object.hasOwn(d[k],'value'))||required.some(k=>!Object.hasOwn(d,k)))invalid();return Object.fromEntries(keys.filter(k=>d[k].value!==undefined).map(k=>[k,d[k].value]));}
const rpc=(v,invalid)=>{if(v.rpcTimeoutMs!==undefined&&!integer(v.rpcTimeoutMs,50,120000))invalid();};
export function captureDownloadRequest(value,kind,invalid,maxBytes=4194304){
 const allowed=kind==='armed'?['limits','rpcTimeoutMs']:kind==='chunk'?['downloadId','offset','maxBytes','rpcTimeoutMs']:kind==='file'?['downloadId','sha256','byteLength','completedAt','rpcTimeoutMs']:['downloadId','rpcTimeoutMs'],required=kind==='armed'?[]:kind==='chunk'?['downloadId','offset']:kind==='file'?['downloadId','sha256','byteLength','completedAt']:['downloadId'],v=data(value,allowed,required,invalid);rpc(v,invalid);
 if(kind==='armed'){const l=data(Object.hasOwn(v,'limits')?v.limits:{},['maxBytes','timeoutMs'],[],invalid),limits={maxBytes:Object.hasOwn(l,'maxBytes')?l.maxBytes:1048576,timeoutMs:Object.hasOwn(l,'timeoutMs')?l.timeoutMs:10000};if(!integer(limits.maxBytes,1,4194304)||!integer(limits.timeoutMs,50,30000))invalid();v.limits=limits;}
 else{if(!id(v.downloadId))invalid();if(kind==='chunk'){v.maxBytes=Object.hasOwn(v,'maxBytes')?v.maxBytes:3072;if(!integer(v.offset,0,4194304)||!integer(v.maxBytes,1,3072))invalid();}if(kind==='file'&&(!hash(v.sha256)||!integer(v.byteLength,0,maxBytes)||v.byteLength===0&&v.sha256!==emptyHash||!date(v.completedAt)))invalid();}
 return freezeBackendData(v);
}
function sameContext(value,expected){try{const ctx=captureObservationContext(Object.fromEntries(ctxFields.map(k=>[k,value[k]])),()=>{throw Error();});return ['agentRunId','sessionId','version'].every(k=>ctx[k]===expected[k])&&bindingFields.every(k=>ctx.binding[k]===expected.binding[k])&&documentFields.every(k=>ctx.document[k]===expected.document[k]);}catch{return false;}}
function budget(value){const {agentRunId,sessionId,...source}=value;return Buffer.byteLength(JSON.stringify(value))<=8192&&Buffer.byteLength(JSON.stringify(source))<=6144;}
function fileName(v){return typeof v==='string'&&v.length>0&&v.length<=128&&Array.from(v).length<=64&&v.normalize('NFC')===v&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069\\/]/.test(v)&&!/^\.|[ .]$/.test(v);}
export function validateDownloadReply(status,v,expect,headers){
 const kind=expect.kind,ready=kind==='agent-download-info'&&v?.stage==='download-ready',fields=kind==='agent-download-armed'||kind==='agent-download-info'&&!ready?meta:kind==='agent-download-info'?readyFields:kind==='agent-download-chunk'?chunkFields:base;
 if(status!==200||headers.get('location')!==null||!exact(v,fields)||!sameContext(v,expect.context)||!id(v.downloadId)||kind!=='agent-download-armed'&&v.downloadId!==expect.request.downloadId||!budget(v))return false;
 if(kind==='agent-download-released')return v.stage==='download-released';
 if(kind==='agent-download-armed'||kind==='agent-download-info'){if(v.stage!==(kind==='agent-download-armed'?'download-armed':ready?'download-ready':'download-pending')||v.scope!=='next-owned-page-download'||!date(v.armedAt)||!exact(v.limits,['maxBytes','timeoutMs'])||!integer(v.limits.maxBytes,1,4194304)||!integer(v.limits.timeoutMs,50,30000)||kind==='agent-download-armed'&&['maxBytes','timeoutMs'].some(k=>v.limits[k]!==expect.request.limits[k]))return false;return !ready||date(v.completedAt)&&Date.parse(v.completedAt)>=Date.parse(v.armedAt)&&fileName(v.fileName)&&v.mimeType==='application/octet-stream'&&integer(v.byteLength,0,v.limits.maxBytes)&&hash(v.sha256)&&(v.byteLength!==0||v.sha256===emptyHash);}
 if(v.stage!=='download-chunk'||!hash(v.sha256)||!date(v.completedAt)||!integer(v.offset,0,4194304)||v.offset!==expect.request.offset||!integer(v.totalBytes,0,4194304)||v.offset>v.totalBytes||!integer(v.byteLength,0,3072)||v.byteLength!==Math.min(expect.request.maxBytes,v.totalBytes-v.offset)||typeof v.data!=='string'||v.data.length>4096||v.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)||Buffer.byteLength(v.data,'base64')!==v.byteLength||Buffer.from(v.data,'base64').toString('base64')!==v.data||typeof v.complete!=='boolean'||v.complete!==(v.offset+v.byteLength===v.totalBytes)||v.byteLength===0&&!v.complete||v.totalBytes===0&&v.sha256!==emptyHash)return false;return true;
}
export async function readDownloadBinary(response,expect,{signal,maxBytes,fail,isClientError}){
 let reader,cancellation=null;const cancel=()=>cancellation??=(Promise.resolve().then(()=>reader?reader.cancel():response.body?.cancel()).catch(()=>{})),abort=()=>{void cancel();};signal.addEventListener('abort',abort,{once:true});
 try{
  const h=response.headers,r=expect.request,requestId=h.get('x-request-id'),reject=()=>fail('CLIENT_INVALID_RESPONSE',{requestId:/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId??'')?requestId:null});
  if(response.status!==200||h.get('location')!==null||h.get('content-encoding')!==null||!/^application\/octet-stream$/i.test(h.get('content-type')??'')||h.get('content-length')!==String(r.byteLength)||r.byteLength>maxBytes||h.get('cache-control')!=='no-store'||h.get('x-content-type-options')!=='nosniff'||h.get('content-disposition')!=='attachment; filename="'+r.downloadId+'.bin"'||h.get('content-digest')!=='sha-256=:'+Buffer.from(r.sha256,'hex').toString('base64')+':'||h.get('x-download-id')!==r.downloadId||h.get('x-download-sha256')!==r.sha256||h.get('x-download-completed-at')!==r.completedAt||!/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId??''))reject();
  const encoded=h.get('x-agent-observation-context');if(typeof encoded!=='string'||encoded.length<1||encoded.length>4096||!/^[A-Za-z0-9_-]+$/.test(encoded))reject();let ctx;try{const raw=Buffer.from(encoded,'base64url');if(raw.toString('base64url')!==encoded)reject();ctx=captureObservationContext(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),reject);}catch{reject();}if(!sameContext(ctx,expect.context))reject();
  reader=response.body?.getReader();if(!reader&&r.byteLength!==0)reject();if(signal.aborted)abort();const bytes=new Uint8Array(r.byteLength),digest=createHash('sha256');let size=0,chunks=0;
  if(reader)for(;;){if(signal.aborted)throw signal.reason;const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array)||size+part.value.byteLength>bytes.length)reject();bytes.set(part.value,size);digest.update(bytes.subarray(size,size+part.value.byteLength));size+=part.value.byteLength;if(++chunks%128===0)await new Promise(resolve=>setImmediate(resolve));}
  if(signal.aborted)throw signal.reason;if(size!==r.byteLength||digest.digest('hex')!==r.sha256)reject();
  // Only these newly allocated bytes are caller-owned and mutable. Metadata is
  // frozen and no network buffer, Source reference or automatic retry escapes.
  return Object.freeze({data:Object.freeze({stage:'download-delivered',...expect.context,downloadId:r.downloadId,mimeType:'application/octet-stream',byteLength:size,sha256:r.sha256,completedAt:r.completedAt,bytes}),requestId});
 }catch(error){await cancel();if(isClientError(error))throw error;fail('CLIENT_INVALID_RESPONSE');}finally{signal.removeEventListener('abort',abort);if(cancellation)await cancellation;reader?.releaseLock();}
}
