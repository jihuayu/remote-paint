import {createHash} from 'node:crypto';
// Backend-only observation DTO capture. No Source, CDP or DOM implementation.
import {freezeBackendData} from './backend-transport.mjs';
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const fields={context:['agentRunId','sessionId','version','binding','document'],binding:['tenantId','sessionId','targetId','runId'],document:['controlSessionId','pageEpoch','viewportVersion'],limits:['maxNodes','maxChars','maxVisited'],node:['elementId','tag','id','role','name','text','value','redacted']};
const resultFields=['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','query','limits','url','title','nodes','visited','truncated'];
const runFields=['agentRunId','sessionId','region','version','state','holdsWriter','beginDispatch','endDispatch','createdAt','updatedAt','error'];
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const id=(v,p)=>typeof v==='string'&&v.startsWith(p+'_')&&uuid(v.slice(p.length+1));
const string=(v,max,min=0)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const equal=(a,b,keys)=>keys.every(k=>a[k]===b[k]);
function data(value,allowed,required,invalid){
 if(!plain(value))invalid();const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))invalid();return Object.fromEntries(keys.filter(k=>descriptors[k].value!==undefined).map(k=>[k,descriptors[k].value]));
}
function validContext(v){return exact(v,fields.context)&&id(v.agentRunId,'arun')&&id(v.sessionId,'ses')&&string(v.version,256,1)&&exact(v.binding,fields.binding)&&string(v.binding.tenantId,128,1)&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.binding.tenantId)&&v.binding.sessionId===v.sessionId&&id(v.binding.targetId,'target')&&id(v.binding.runId,'run')&&exact(v.document,fields.document)&&uuid(v.document.controlSessionId)&&integer(v.document.pageEpoch,1)&&integer(v.document.viewportVersion,1);}
function query(value,invalid){
 const v=data(value,['kind','by','value','elementId'],['kind'],invalid);let keys;
 if(v.kind==='snapshot')keys=['kind'];else if(v.kind==='locate'){keys=['kind','by','value'];if(!['id','tag','testId'].includes(v.by)||!string(v.value,128,1)||/[\x00-\x1f]/.test(v.value)||v.by==='tag'&&!/^[a-z][a-z0-9-]{0,63}$/.test(v.value))invalid();}else if(v.kind==='element'){keys=['kind','elementId'];if(!id(v.elementId,'elh'))invalid();}else invalid();
 if(!exact(v,keys))invalid();return Object.fromEntries(keys.map(k=>[k,v[k]]));
}
function limits(value,invalid){const v=data(value,fields.limits,[],invalid),l={maxNodes:v.maxNodes??8,maxChars:v.maxChars??1024,maxVisited:v.maxVisited??128};if(!integer(l.maxNodes,1,16)||!integer(l.maxChars,0,2048)||!integer(l.maxVisited,1,256))invalid();return l;}
export function captureObservationReference(value,invalid){const v=data(value,runFields,['agentRunId','sessionId','version'],invalid);if(!id(v.agentRunId,'arun')||!id(v.sessionId,'ses')||!string(v.version,256,1))invalid();return Object.freeze({agentRunId:v.agentRunId,sessionId:v.sessionId,version:v.version});}
export function captureObservationContext(value,invalid){
 const v=data(value,fields.context,fields.context,invalid);v.binding=data(v.binding,fields.binding,fields.binding,invalid);v.document=data(v.document,fields.document,fields.document,invalid);if(!validContext(v))invalid();return freezeBackendData(v);
}
export function captureObservationRequest(value,invalid){
 const v=data(value,['query','limits','rpcTimeoutMs'],['query'],invalid),q=query(v.query,invalid),l=limits(Object.hasOwn(v,'limits')?v.limits:{},invalid);if(v.rpcTimeoutMs!==undefined&&!integer(v.rpcTimeoutMs,50,120000))invalid();return freezeBackendData({query:q,limits:l,...(v.rpcTimeoutMs===undefined?{}:{rpcTimeoutMs:v.rpcTimeoutMs})});
}
export function captureObservationOptions(value,invalid){const v=data(value,['signal'],[],invalid);if(v.signal!==undefined&&!(v.signal instanceof AbortSignal))invalid();return {signal:v.signal,retries:0};}
export function validateObservationReply(status,value,expect,headers){
 if(status!==200||headers.get('location')!==null)return false;
 if(expect.kind==='agent-observation-context')return validContext(value)&&equal(value,expect.reference,['agentRunId','sessionId','version']);
 if(!exact(value,resultFields))return false;
 const ctx=Object.fromEntries(fields.context.map(k=>[k,value[k]])),expected=expect.context;
 if(!validContext(ctx)||!equal(ctx,expected,['agentRunId','sessionId','version'])||!equal(ctx.binding,expected.binding,fields.binding)||!equal(ctx.document,expected.document,fields.document)||value.stage!=='observed'||value.scope!=='main-document-light-dom'||!id(value.observationId,'obs')||!integer(value.revision,1)||!string(value.observedAt,32,1)||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt||!string(value.url,1024)||!string(value.title,256)||typeof value.truncated!=='boolean')return false;
 let q,l;try{const invalid=()=>{throw Error();};q=query(value.query,invalid);l=limits(value.limits,invalid);}catch{return false;}
 if(!exact(value.limits,fields.limits)||!equal(q,expect.request.query,Object.keys(q))||Object.keys(q).length!==Object.keys(expect.request.query).length||!equal(l,expect.request.limits,fields.limits)||!integer(value.visited,0,l.maxVisited)||!Array.isArray(value.nodes)||value.nodes.length>l.maxNodes||value.nodes.length>value.visited)return false;
 let chars=0;const seen=new Set();for(const n of value.nodes){if(!exact(n,fields.node)||!id(n.elementId,'elh')||seen.has(n.elementId)||!string(n.tag,32,1)||!string(n.id,64)||!string(n.role,32)||!string(n.name,64)||!string(n.text,2048)||n.value!==null&&!string(n.value,2048)||typeof n.redacted!=='boolean'||n.redacted&&(n.value!==null||n.text!==''))return false;seen.add(n.elementId);chars+=n.text.length+(n.value?.length??0);}
 // Public IDs add metadata to the already bounded Source record.
 const {agentRunId,sessionId,...source}=value;
 return chars<=l.maxChars&&(q.kind!=='element'||value.nodes.length===1&&value.visited===1)&&new TextEncoder().encode(JSON.stringify(value)).byteLength<=8192&&new TextEncoder().encode(JSON.stringify(source)).byteLength<=6144;
}

const axResultFields=['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','elementId','limits','url','title','ax','redacted','truncated'];
const axBooleans=['disabled','focused','focusable','readonly','required','selected','multiline','multiselectable','expanded','modal','busy'],axTristates=['checked','pressed'];
export function captureAccessibilityRequest(value,invalid){
 const v=data(value,['elementId','limits','rpcTimeoutMs'],['elementId'],invalid),l=data(Object.hasOwn(v,'limits')?v.limits:{},['maxChars'],[],invalid),maxChars=l.maxChars??256;if(!id(v.elementId,'elh')||!integer(maxChars,0,512)||v.rpcTimeoutMs!==undefined&&!integer(v.rpcTimeoutMs,50,120000))invalid();return freezeBackendData({elementId:v.elementId,limits:{maxChars},...(v.rpcTimeoutMs===undefined?{}:{rpcTimeoutMs:v.rpcTimeoutMs})});
}
export function validateAccessibilityReply(status,value,expect,headers){
 if(status!==200||headers.get('location')!==null||!exact(value,axResultFields))return false;
 const ctx=Object.fromEntries(fields.context.map(k=>[k,value[k]])),expected=expect.context;
 if(!validContext(ctx)||!equal(ctx,expected,['agentRunId','sessionId','version'])||!equal(ctx.binding,expected.binding,fields.binding)||!equal(ctx.document,expected.document,fields.document)||value.stage!=='accessibility-observed'||value.scope!=='main-document-element-accessibility'||value.elementId!==expect.request.elementId||!exact(value.limits,['maxChars'])||value.limits.maxChars!==expect.request.limits.maxChars||!id(value.observationId,'obs')||!integer(value.revision,1)||!string(value.observedAt,32,1)||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt||!string(value.url,1024)||!string(value.title,256)||typeof value.truncated!=='boolean'||typeof value.redacted!=='boolean')return false;
 if(value.redacted){if(value.ax!==null)return false;}else{
  const a=value.ax;if(!exact(a,['ignored','role','name','description','value','states'])||typeof a.ignored!=='boolean'||!string(a.role,64)||!string(a.name,512)||!string(a.description,512)||a.value!==null&&!string(a.value,512)||a.name.length+a.description.length+(a.value?.length??0)>expect.request.limits.maxChars||!plain(a.states))return false;
  if(Reflect.ownKeys(a.states).some(k=>![...axBooleans,...axTristates].includes(k)||typeof a.states[k]!=='boolean'&&!(axTristates.includes(k)&&a.states[k]==='mixed')))return false;
 }
 const {agentRunId,sessionId,...source}=value;
 return new TextEncoder().encode(JSON.stringify(value)).byteLength<=8192&&new TextEncoder().encode(JSON.stringify(source)).byteLength<=6144;
}

const screenshotFields=['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','limits','url','title','truncated','screenshotId','mimeType','width','height','byteLength','sha256'];
const screenshotChunkFields=['agentRunId','sessionId','stage','binding','document','version','screenshotId','sha256','observedAt','offset','byteLength','totalBytes','data','complete'];
const screenshotReleasedFields=['agentRunId','sessionId','stage','binding','document','version','screenshotId'];
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),date=v=>string(v,32,1)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const base64=v=>typeof v==='string'&&v.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(v);
function sameContext(v,expected){const ctx=Object.fromEntries(fields.context.map(k=>[k,v[k]]));return validContext(ctx)&&equal(ctx,expected,['agentRunId','sessionId','version'])&&equal(ctx.binding,expected.binding,fields.binding)&&equal(ctx.document,expected.document,fields.document);}
function screenshotBytes(value){const {agentRunId,sessionId,...source}=value;return Buffer.byteLength(JSON.stringify(value))<=8192&&Buffer.byteLength(JSON.stringify(source))<=6144;}
export function captureScreenshotRequest(value,invalid){const v=data(value,['limits','rpcTimeoutMs'],[],invalid),l=data(Object.hasOwn(v,'limits')?v.limits:{},['maxBytes'],[],invalid),maxBytes=Object.hasOwn(l,'maxBytes')?l.maxBytes:1048576;if(!integer(maxBytes,1,4194304)||v.rpcTimeoutMs!==undefined&&!integer(v.rpcTimeoutMs,50,120000))invalid();return freezeBackendData({limits:{maxBytes},...(v.rpcTimeoutMs===undefined?{}:{rpcTimeoutMs:v.rpcTimeoutMs})});}
export function captureScreenshotFileRequest(value,kind,invalid,maxBytes=4194304){
 const allowed=kind==='chunk'?['screenshotId','offset','maxBytes','rpcTimeoutMs']:kind==='download'?['screenshotId','sha256','byteLength','observedAt','rpcTimeoutMs']:['screenshotId','rpcTimeoutMs'],required=kind==='chunk'?['screenshotId','offset']:kind==='download'?['screenshotId','sha256','byteLength','observedAt']:['screenshotId'],v=data(value,allowed,required,invalid);if(!id(v.screenshotId,'shot')||v.rpcTimeoutMs!==undefined&&!integer(v.rpcTimeoutMs,50,120000))invalid();
 if(kind==='chunk'){const n=Object.hasOwn(v,'maxBytes')?v.maxBytes:3072;if(!integer(v.offset,0,4194304)||!integer(n,1,3072))invalid();v.maxBytes=n;}else if(kind==='download'&&(!hash(v.sha256)||!integer(v.byteLength,57,maxBytes)||!date(v.observedAt)))invalid();return freezeBackendData(v);
}
export function validateScreenshotReply(status,value,expect,headers){
 const kind=expect.kind;if(status!==200||headers.get('location')!==null||!exact(value,kind==='agent-screenshot'?screenshotFields:kind==='agent-screenshot-chunk'?screenshotChunkFields:screenshotReleasedFields)||!sameContext(value,expect.context)||!id(value.screenshotId,'shot')||kind!=='agent-screenshot'&&value.screenshotId!==expect.request.screenshotId||!screenshotBytes(value))return false;
 if(kind==='agent-screenshot-released')return value.stage==='screenshot-released';
 if(!hash(value.sha256)||!date(value.observedAt))return false;
 if(kind==='agent-screenshot')return value.stage==='screenshot-observed'&&value.scope==='main-frame-viewport-source-pixels'&&id(value.observationId,'obs')&&integer(value.revision,1)&&exact(value.limits,['maxBytes'])&&value.limits.maxBytes===expect.request.limits.maxBytes&&string(value.url,1024)&&string(value.title,256)&&typeof value.truncated==='boolean'&&value.mimeType==='image/png'&&integer(value.width,1,2048)&&integer(value.height,1,2048)&&value.width*value.height<=4194304&&integer(value.byteLength,57,value.limits.maxBytes);
 return value.stage==='screenshot-chunk'&&integer(value.offset,0,4194304)&&value.offset===expect.request.offset&&integer(value.totalBytes,57,4194304)&&value.offset<=value.totalBytes&&integer(value.byteLength,0,3072)&&value.byteLength===Math.min(expect.request.maxBytes,value.totalBytes-value.offset)&&string(value.data,4096)&&base64(value.data)&&Buffer.byteLength(value.data,'base64')===value.byteLength&&typeof value.complete==='boolean'&&value.complete===(value.offset+value.byteLength===value.totalBytes);
}
export async function readScreenshotBinary(response,expect,{signal,maxBytes,fail,isClientError}){
 let reader,cancellation=null;const cancel=()=>cancellation??=(Promise.resolve().then(()=>reader?reader.cancel():response.body?.cancel()).catch(()=>{})),abort=()=>{void cancel();};signal.addEventListener('abort',abort,{once:true});
 try{
  const h=response.headers,r=expect.request,requestId=h.get('x-request-id'),reject=()=>fail('CLIENT_INVALID_RESPONSE',{requestId:/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId??'')?requestId:null});
  if(response.status!==200||h.get('location')!==null||h.get('content-encoding')!==null||!/^image\/png$/i.test(h.get('content-type')??'')||h.get('content-length')!==String(r.byteLength)||r.byteLength>maxBytes||h.get('cache-control')!=='no-store'||h.get('x-content-type-options')!=='nosniff'||h.get('content-disposition')!=='attachment; filename="'+r.screenshotId+'.png"'||h.get('content-digest')!=='sha-256=:'+Buffer.from(r.sha256,'hex').toString('base64')+':'||h.get('x-screenshot-id')!==r.screenshotId||h.get('x-screenshot-sha256')!==r.sha256||h.get('x-screenshot-observed-at')!==r.observedAt||!/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId??''))reject();
  const encoded=h.get('x-agent-observation-context');if(!string(encoded,4096,1)||!/^[A-Za-z0-9_-]+$/.test(encoded))reject();let ctx;try{const raw=Buffer.from(encoded,'base64url');if(raw.toString('base64url')!==encoded)reject();ctx=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{reject();}if(!validContext(ctx)||!sameContext(ctx,expect.context))reject();
  reader=response.body?.getReader();if(!reader)reject();if(signal.aborted)abort();const bytes=new Uint8Array(r.byteLength),digest=createHash('sha256');let size=0,chunks=0;
  for(;;){if(signal.aborted)throw signal.reason;const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array)||size+part.value.byteLength>bytes.length)reject();bytes.set(part.value,size);digest.update(bytes.subarray(size,size+part.value.byteLength));size+=part.value.byteLength;if(++chunks%128===0)await new Promise(resolve=>setImmediate(resolve));}
  if(signal.aborted)throw signal.reason;if(size!==r.byteLength||digest.digest('hex')!==r.sha256||size<57||!Buffer.from(bytes.buffer,bytes.byteOffset,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8)!==13||Buffer.from(bytes.buffer,bytes.byteOffset+12,4).toString('latin1')!=='IHDR')reject();const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),width=view.getUint32(16),height=view.getUint32(20);if(!integer(width,1,2048)||!integer(height,1,2048)||width*height>4194304)reject();
  // Only this newly allocated byte array is caller-owned and mutable. All
  // metadata is frozen; no transport/Source buffer or retry state is exposed.
  return Object.freeze({data:Object.freeze({stage:'screenshot-downloaded',...expect.context,screenshotId:r.screenshotId,mimeType:'image/png',byteLength:size,sha256:r.sha256,observedAt:r.observedAt,width,height,bytes}),requestId});
 }catch(error){await cancel();if(isClientError(error))throw error;fail('CLIENT_INVALID_RESPONSE');}finally{signal.removeEventListener('abort',abort);if(cancellation)await cancellation;reader?.releaseLock();}
}
