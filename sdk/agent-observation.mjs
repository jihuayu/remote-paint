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
