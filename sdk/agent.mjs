import {captureObservationReference,captureObservationContext,captureObservationRequest,captureObservationOptions,validateObservationReply,captureAccessibilityRequest,validateAccessibilityReply} from './agent-observation.mjs';
import {SessionClientError,createBackendTransport,freezeBackendData} from './backend-transport.mjs';
export class AgentClientError extends SessionClientError {constructor(code,options){super(code,options);this.name='AgentClientError';this.message=code==='CLIENT_INVALID_REQUEST'?'Invalid Agent client request':'Agent API request failed';}}
const invalid=()=>{throw new AgentClientError('CLIENT_INVALID_REQUEST',{outcome:'not-dispatched'});};
const plain=v=>!!v&&Object.getPrototypeOf(v)===Object.prototype;
function data(value,allowed,required=allowed){if(!plain(value))invalid();const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))invalid();return Object.fromEntries(keys.filter(k=>descriptors[k].value!==undefined).map(k=>[k,descriptors[k].value]));}
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const id=(v,prefix)=>typeof v==='string'&&v.startsWith(prefix)&&uuid(v.slice(prefix.length));
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const string=(v,max,min=1)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const date=v=>string(v,32)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const code=v=>string(v,64)&&/^[A-Z][A-Z0-9_]*$/.test(v)&&!v.startsWith('CLIENT_');
const runKeys=['agentRunId','sessionId','region','version','state','holdsWriter','beginDispatch','endDispatch','createdAt','updatedAt','error'];
const invocationKeys=['invocationId','agentRunId','sessionId','tool','fence','state','dispatchStarted','receipt','error','createdAt','updatedAt'];
const tools=['move','click','drag','scroll','press','insertText','composition'];
const fenceKeys=['controlSessionId','controlVersion','pageEpoch','viewportVersion'];
const bindingKeys=['tenantId','sessionId','targetId','runId'];
function isFence(v){return exact(v,fenceKeys)&&uuid(v.controlSessionId)&&integer(v.controlVersion,0)&&integer(v.pageEpoch,1)&&integer(v.viewportVersion,1);}
function isBinding(v){return exact(v,bindingKeys)&&string(v.tenantId,128)&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.tenantId)&&id(v.sessionId,'ses_')&&id(v.targetId,'target_')&&id(v.runId,'run_');}
function error(v){return exact(v,['code','outcome'])&&code(v.code)&&['not-dispatched','unknown'].includes(v.outcome);}
function run(v){
 if(!exact(v,runKeys)||!id(v.agentRunId,'arun_')||!id(v.sessionId,'ses_')||!string(v.region,64)||!string(v.version,256)||!['intent','starting','active','closing','recovery-required','closed'].includes(v.state)||typeof v.holdsWriter!=='boolean'||!['not-requested','requested','confirmed'].includes(v.beginDispatch)||!['not-requested','requested','confirmed'].includes(v.endDispatch)||!date(v.createdAt)||!date(v.updatedAt)||v.updatedAt<v.createdAt||!(v.error===null||error(v.error)))return false;
 if((v.state==='closed')===v.holdsWriter||v.endDispatch!=='not-requested'&&v.beginDispatch!=='confirmed'||v.endDispatch==='confirmed'&&v.state!=='closed')return false;
 if(v.state==='intent'&&(v.beginDispatch!=='not-requested'||v.endDispatch!=='not-requested'||v.error!==null)||v.state==='starting'&&(v.beginDispatch!=='requested'||v.endDispatch!=='not-requested'||v.error!==null)||v.state==='active'&&(v.beginDispatch!=='confirmed'||v.endDispatch!=='not-requested'||v.error!==null))return false;
 if(v.error!==null&&(!['closed','closing','recovery-required'].includes(v.state)||v.error.outcome==='not-dispatched'&&v.state!=='closed'))return false;return true;
}
const normalInputs={move:1,click:3,scroll:1,press:2,insertText:1,composition:1};
function invocation(v){
 if(!exact(v,invocationKeys)||!id(v.invocationId,'ainv_')||!id(v.agentRunId,'arun_')||!id(v.sessionId,'ses_')||!tools.includes(v.tool)||!isFence(v.fence)||!['intent','requested','injected','rejected','unknown'].includes(v.state)||typeof v.dispatchStarted!=='boolean'||!date(v.createdAt)||!date(v.updatedAt)||v.updatedAt<v.createdAt)return false;
 if(v.state==='intent')return !v.dispatchStarted&&v.receipt===null&&v.error===null;
 if(v.state==='requested')return v.dispatchStarted&&v.receipt===null&&v.error===null;
 if(v.state==='injected')return v.dispatchStarted&&v.error===null&&exact(v.receipt,['stage','inputs'])&&v.receipt.stage==='input-injected'&&(v.tool==='drag'?integer(v.receipt.inputs,4,19):v.receipt.inputs===normalInputs[v.tool]);
 return v.receipt===null&&error(v.error)&&(v.state==='unknown'?v.dispatchStarted&&v.error.outcome==='unknown':v.error.outcome==='not-dispatched');
}
function validate(status,value,expect,headers){
 if(expect.kind==='agent-accessibility')return validateAccessibilityReply(status,value,expect,headers);
 if(['agent-observation-context','agent-observation'].includes(expect.kind))return validateObservationReply(status,value,expect,headers);
 if(expect.kind==='agent-context')return status===200&&exact(value,['binding','fence'])&&isBinding(value.binding)&&isFence(value.fence)&&value.binding.sessionId===expect.sessionId;
 if(expect.kind.startsWith('agent-invocation')){
  if(!invocation(value)||expect.id&&value.invocationId!==expect.id)return false;
  if(expect.kind==='agent-invocation-get')return status===200;
  if(value.agentRunId!==expect.agentRunId||value.sessionId!==expect.sessionId||value.tool!==expect.tool||!fenceKeys.every(k=>value.fence[k]===expect.fence[k])||value.state==='injected'&&value.receipt.inputs!==expect.inputs)return false;
  return (['intent','requested'].includes(value.state)?status===202:status===200)&&headers.get('location')==='/v1/agent-invocations/'+value.invocationId;
 }
 if(!run(value)||expect.id&&value.agentRunId!==expect.id)return false;
 if(expect.kind==='agent-run-get')return status===200;
 if(expect.kind==='agent-run-create'&&(value.sessionId!==expect.sessionId||value.region!==expect.region||value.version!==expect.version)||expect.kind==='agent-end'&&['intent','starting','active'].includes(value.state))return false;
 return (['intent','starting','closing'].includes(value.state)?status===202:status===200)&&headers.get('location')==='/v1/agent-runs/'+value.agentRunId;
}
function reference(value){const v=data(value,runKeys,['agentRunId','sessionId']);if(!id(v.agentRunId,'arun_')||!id(v.sessionId,'ses_'))invalid();return {agentRunId:v.agentRunId,sessionId:v.sessionId};}
function context(value){const v=data(value,['agentRunId','binding','fence']),binding=data(v.binding,bindingKeys),fence=data(v.fence,fenceKeys);if(!id(v.agentRunId,'arun_')||!isBinding(binding)||!isFence(fence))invalid();return freezeBackendData({agentRunId:v.agentRunId,binding:Object.fromEntries(bindingKeys.map(k=>[k,binding[k]])),fence:Object.fromEntries(fenceKeys.map(k=>[k,fence[k]]))});}
function requestOptions(value,creation=false){const v=data(value,creation?['idempotencyKey','signal','retries']:['signal','retries'],creation?['idempotencyKey']:[]);if(v.signal!==undefined&&!(v.signal instanceof AbortSignal)||v.retries!==undefined&&!integer(v.retries,0,3))invalid();if(creation&&(typeof v.idempotencyKey!=='string'||! /^[\x21-\x7e]{1,128}$/.test(v.idempotencyKey)))invalid();return v;}
function timeout(value){if(value!==undefined&&!integer(value,50,120000))invalid();}
function body(value){const text=JSON.stringify(value);if(new TextEncoder().encode(text).byteLength>32768)invalid();return text;}
function action(value){
 const v=data(value,['tool','params','rpcTimeoutMs'],['tool','params']);if(!tools.includes(v.tool))invalid();timeout(v.rpcTimeoutMs);
 const fields={move:[['x','y','modifiers'],['x','y']],click:[['x','y','button','modifiers'],['x','y']],drag:[['fromX','fromY','toX','toY','steps','button','modifiers'],['fromX','fromY','toX','toY']],scroll:[['x','y','deltaX','deltaY','modifiers'],['x','y','deltaX','deltaY']],press:[['key','code','text','modifiers','windowsVirtualKeyCode','nativeVirtualKeyCode'],['key','code']],insertText:[['text'],['text']],composition:[['text','selectionStart','selectionEnd'],['text','selectionStart','selectionEnd']]}[v.tool],p=data(v.params,...fields);
 if(p.modifiers!==undefined&&!integer(p.modifiers,0,15))invalid();for(const k of ['x','y','fromX','fromY','toX','toY'])if(fields[1].includes(k)&&(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0||p[k]>1e7))invalid();
 if(['click','drag'].includes(v.tool)&&p.button!==undefined&&!['left','middle','right'].includes(p.button)||v.tool==='drag'&&p.steps!==undefined&&!integer(p.steps,1,16))invalid();
 if(v.tool==='scroll'&&['deltaX','deltaY'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k])||Math.abs(p[k])>10000))invalid();
 if(v.tool==='press'){if(!string(p.key,64,0)||!string(p.code,64,0)||p.text!==undefined&&!string(p.text,32,0))invalid();for(const k of ['windowsVirtualKeyCode','nativeVirtualKeyCode'])if(p[k]!==undefined&&!integer(p[k],0,65535))invalid();}
 if(['insertText','composition'].includes(v.tool)&&!string(p.text,8192,0)||v.tool==='composition'&&(!integer(p.selectionStart,0,p.text.length)||!integer(p.selectionEnd,p.selectionStart,p.text.length)))invalid();return {tool:v.tool,params:p,...(v.rpcTimeoutMs===undefined?{}:{rpcTimeoutMs:v.rpcTimeoutMs})};
}
export class AgentClient {
 #transport;
 constructor(config){
  this.#transport=createBackendTransport(config,{validate,ErrorClass:AgentClientError,agentErrors:true,endKind:'agent-end'});
  const call=(method,path,payload,key,expect,options)=>this.#transport.request(method,path,payload,key,expect,options);
  const prepared=(path,payload,key,expect)=>{let originalId=null,originalCreatedAt=null;return Object.freeze({send:async(options={})=>{const result=await call('POST',path,payload,key,expect,requestOptions(options)),id=result.data.agentRunId&&expect.kind==='agent-run-create'?result.data.agentRunId:result.data.invocationId;if(originalId!==null&&originalId!==id||originalCreatedAt!==null&&originalCreatedAt!==result.data.createdAt)throw new AgentClientError('CLIENT_INVALID_RESPONSE',{requestId:result.requestId});originalId=id;originalCreatedAt=result.data.createdAt;return result;}});};
  const prepareRun=(sessionId,input,options)=>{if(!id(sessionId,'ses_'))invalid();const v=data(input,['region','version','rpcTimeoutMs'],['region','version']),r=data(options,['idempotencyKey']);if(!string(v.region,64)||!string(v.version,256))invalid();timeout(v.rpcTimeoutMs);requestOptions(r,true);return prepared('/v1/sessions/'+sessionId+'/agent-runs',body(v),r.idempotencyKey,{kind:'agent-run-create',sessionId,region:v.region,version:v.version});};
  const prepareInvocation=(supplied,input,options)=>{const ctx=context(supplied),v=action(input),r=data(options,['idempotencyKey']);requestOptions(r,true);return prepared('/v1/agent-runs/'+ctx.agentRunId+'/invocations',body({...v,context:{binding:ctx.binding,fence:ctx.fence}}),r.idempotencyKey,{kind:'agent-invocation-create',agentRunId:ctx.agentRunId,sessionId:ctx.binding.sessionId,tool:v.tool,fence:ctx.fence,inputs:v.tool==='drag'?(v.params.steps??4)+3:normalInputs[v.tool]});};
  Object.defineProperty(this,'runs',{enumerable:true,value:Object.freeze({
   prepareCreate:prepareRun,
   create:(sessionId,input,options)=>{const r=requestOptions(options,true);return prepareRun(sessionId,input,{idempotencyKey:r.idempotencyKey}).send({signal:r.signal,retries:r.retries});},
   get:(agentRunId,options={})=>{if(!id(agentRunId,'arun_'))invalid();return call('GET','/v1/agent-runs/'+agentRunId,null,null,{kind:'agent-run-get',id:agentRunId},requestOptions(options));},
   context:async(run,options={})=>{const r=reference(run),result=await call('GET','/v1/agent-runs/'+r.agentRunId+'/context',null,null,{kind:'agent-context',sessionId:r.sessionId},requestOptions(options));return freezeBackendData({data:{agentRunId:r.agentRunId,...result.data},requestId:result.requestId});},
   end:(agentRunId,options={})=>{if(!id(agentRunId,'arun_'))invalid();return call('POST','/v1/agent-runs/'+agentRunId+'/end',null,null,{kind:'agent-end',id:agentRunId},requestOptions(options));}
  })});
  Object.defineProperty(this,'observations',{enumerable:true,value:Object.freeze({
   context:(run,options={})=>{const reference=captureObservationReference(run,invalid),opts=captureObservationOptions(options,invalid);return call('GET','/v1/agent-runs/'+reference.agentRunId+'/observation-context',null,null,{kind:'agent-observation-context',reference},opts);},
   accessibility:(supplied,input,options={})=>{const ctx=captureObservationContext(supplied,invalid),request=captureAccessibilityRequest(input,invalid),opts=captureObservationOptions(options,invalid);return call('POST','/v1/agent-runs/'+ctx.agentRunId+'/accessibility-observations',body({context:ctx,...request}),null,{kind:'agent-accessibility',context:ctx,request},opts);},
   read:(supplied,input,options={})=>{const ctx=captureObservationContext(supplied,invalid),request=captureObservationRequest(input,invalid),opts=captureObservationOptions(options,invalid);return call('POST','/v1/agent-runs/'+ctx.agentRunId+'/observations',body({context:ctx,...request}),null,{kind:'agent-observation',context:ctx,request},opts);}
  })});
  Object.defineProperty(this,'invocations',{enumerable:true,value:Object.freeze({
   prepareCreate:prepareInvocation,
   create:(ctx,input,options)=>{const r=requestOptions(options,true);return prepareInvocation(ctx,input,{idempotencyKey:r.idempotencyKey}).send({signal:r.signal,retries:r.retries});},
   get:(invocationId,options={})=>{if(!id(invocationId,'ainv_'))invalid();return call('GET','/v1/agent-invocations/'+invocationId,null,null,{kind:'agent-invocation-get',id:invocationId},requestOptions(options));}
  })});
 }
 transportStatus(){return this.#transport.status();}
}
