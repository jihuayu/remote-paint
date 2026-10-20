import {randomUUID} from 'node:crypto';
import {AgentInputError} from './input.mjs';
import {createAgentObservationRealm} from './agent-observation-realm.mjs';
export const MAX_AGENT_OBSERVATION_BYTES=6144;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_'+uuid+'$').test(v);
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const string=(v,max,min=0)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const fail=code=>{throw new AgentInputError(code,'not-dispatched');};
function data(v,fields,required=fields,code='INVALID_AGENT_OBSERVATION'){
 try{if(!v||typeof v!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail(code);const keys=Reflect.ownKeys(v),descriptors=Object.getOwnPropertyDescriptors(v);if(keys.some(k=>!fields.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))fail(code);return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));}catch{fail(code);}
}
export function captureManagedAgentObservation(query,limits={}){
 let kind;try{kind=Object.getOwnPropertyDescriptor(query,'kind')?.value;}catch{fail('INVALID_AGENT_OBSERVATION');}
 let q;if(kind==='snapshot')q=data(query,['kind']);else if(kind==='locate'){q=data(query,['kind','by','value']);if(!['id','tag','testId'].includes(q.by)||!string(q.value,128,1)||/[\x00-\x1f]/.test(q.value)||q.by==='tag'&&!/^[a-z][a-z0-9-]{0,63}$/.test(q.value))fail('INVALID_AGENT_OBSERVATION');}else if(kind==='element'){q=data(query,['kind','elementId']);if(!id(q.elementId,'elh'))fail('INVALID_AGENT_OBSERVATION');}else fail('INVALID_AGENT_OBSERVATION');
 const v=data(limits,['maxNodes','maxChars','maxVisited'],[]),l={maxNodes:v.maxNodes??8,maxChars:v.maxChars??1024,maxVisited:v.maxVisited??128};
 if(!integer(l.maxNodes,1,16)||!integer(l.maxChars,0,2048)||!integer(l.maxVisited,1,256))fail('INVALID_AGENT_OBSERVATION');return Object.freeze({query:Object.freeze(q),limits:Object.freeze(l)});
}
function binding(value){const v=data(value,['tenantId','sessionId','targetId','runId'],undefined,'AGENT_INVALID_REPLY');if(!string(v.tenantId,128,1)||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.tenantId)||!id(v.sessionId,'ses')||!id(v.targetId,'target')||!id(v.runId,'run'))fail('AGENT_INVALID_REPLY');return Object.freeze(v);}
export function captureAgentObservationContext(value){
 const v=data(value,['binding','document'],undefined,'AGENT_INVALID_CONTEXT'),b=binding(v.binding),d=data(v.document,['controlSessionId','pageEpoch','viewportVersion'],undefined,'AGENT_INVALID_CONTEXT');
 if(typeof d.controlSessionId!=='string'||!new RegExp('^'+uuid+'$').test(d.controlSessionId)||!integer(d.pageEpoch,1)||!integer(d.viewportVersion,1))fail('AGENT_INVALID_CONTEXT');return Object.freeze({binding:b,document:Object.freeze(d)});
}
export function captureAgentObservationResult(value,{binding:expectedBinding=null,document=null,observation=null}={}){
 const v=data(value,['stage','binding','document','observationId','revision','observedAt','version','scope','query','limits','url','title','nodes','visited','truncated'],undefined,'AGENT_INVALID_REPLY'),b=binding(v.binding),d=data(v.document,['controlSessionId','pageEpoch','viewportVersion'],undefined,'AGENT_INVALID_REPLY');
 let captured;try{captured=captureManagedAgentObservation(v.query,v.limits);}catch{fail('AGENT_INVALID_REPLY');}const date=typeof v.observedAt==='string'&&Number.isFinite(Date.parse(v.observedAt))&&new Date(v.observedAt).toISOString()===v.observedAt;
 if(v.stage!=='observed'||v.scope!=='main-document-light-dom'||!id(v.observationId,'obs')||!integer(v.revision,1)||!date||!string(v.version,256,1)||!string(v.url,1024)||!string(v.title,256)||typeof v.truncated!=='boolean'||!integer(v.visited,0,captured.limits.maxVisited)||typeof d.controlSessionId!=='string'||!new RegExp('^'+uuid+'$').test(d.controlSessionId)||!integer(d.pageEpoch,1)||!integer(d.viewportVersion,1)||!Array.isArray(v.nodes)||v.nodes.length>captured.limits.maxNodes||v.nodes.length>v.visited||Reflect.ownKeys(v.nodes).length!==v.nodes.length+1)fail('AGENT_INVALID_REPLY');
 if(expectedBinding&&Object.keys(expectedBinding).some(k=>b[k]!==expectedBinding[k])||document&&Object.keys(d).some(k=>d[k]!==document[k])||observation&&(['query','limits'].some(k=>Object.keys(captured[k]).length!==Object.keys(observation[k]).length||Object.keys(captured[k]).some(field=>captured[k][field]!==observation[k][field]))))fail('AGENT_INVALID_REPLY');
 const seen=new Set();let chars=0;const nodes=[];
 for(let i=0;i<v.nodes.length;i++){
  const descriptor=Object.getOwnPropertyDescriptor(v.nodes,String(i));if(!descriptor||!Object.hasOwn(descriptor,'value'))fail('AGENT_INVALID_REPLY');const n=data(descriptor.value,['elementId','tag','id','role','name','text','value','redacted'],undefined,'AGENT_INVALID_REPLY');
  if(!id(n.elementId,'elh')||seen.has(n.elementId)||!string(n.tag,32,1)||!string(n.id,64)||!string(n.role,32)||!string(n.name,64)||!string(n.text,2048)||n.value!==null&&!string(n.value,2048)||typeof n.redacted!=='boolean'||n.redacted&&(n.value!==null||n.text!==''))fail('AGENT_INVALID_REPLY');seen.add(n.elementId);chars+=n.text.length+(n.value?.length??0);nodes.push(Object.freeze(n));
 }
 if(chars>captured.limits.maxChars||v.query.kind==='element'&&(nodes.length!==1||v.visited!==1))fail('AGENT_INVALID_REPLY');
 const result=Object.freeze({...v,binding:b,document:Object.freeze(d),query:captured.query,limits:captured.limits,nodes:Object.freeze(nodes)});if(Buffer.byteLength(JSON.stringify(result))>MAX_AGENT_OBSERVATION_BYTES)fail('AGENT_OBSERVATION_LIMIT');return result;
}
// Source-owned read side. One actual transaction includes evaluation and object
// cleanup; observer deadlines in the outer channel never free that admission.
export function createManagedAgentObserver({source,page,binding:bound,version,authorize,live}){
 if(!string(version,256,1)||typeof authorize!=='function'||typeof live!=='function')fail('AGENT_OBSERVATION_UNAVAILABLE');const capture=source.capture,transport=capture?.cdp;if(capture?.page!==page||typeof transport?.send!=='function')fail('AGENT_OBSERVATION_UNAVAILABLE');const send=transport.send.bind(transport),b=binding(bound),group='agent-observe-'+randomUUID();let state=null,pending=null,closed=false,closing=null,poisoned=false;
 const current=()=>{live();if(closed)fail('AGENT_RUN_CLOSED');if(poisoned)fail('AGENT_OBSERVATION_UNAVAILABLE');const c=source.capture,config=c?.binding?.config;if(c!==capture||c?.page!==page||c?.cdp!==transport||typeof c.cdp.send!=='function'||!integer(c.world,1)||!string(c.documentToken,64,1)||c.stopped||c.transitioning||source.transitioning||config?.documentToken!==c.documentToken||c.binding.world!==c.world||c.binding.revision!==c.revision||config.pageEpoch!==source.pageEpoch||config.viewportVersion!==source.viewportVersion||source.control.closed||source.page!==page||page.isClosed())fail('STALE_AGENT_PAGE');return {capture:c,cdp:c.cdp,send,world:c.world,documentToken:c.documentToken,revision:c.revision,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,controlSessionId:source.control.sessionId,subscriptionId:config.id,token:c.token};};
 const guard=(expected,document)=>{const now=current();if(Object.keys(expected).some(k=>now[k]!==expected[k])||document&&['controlSessionId','pageEpoch','viewportVersion'].some(k=>document[k]!==now[k]))fail('STALE_AGENT_PAGE');authorize();const after=current();if(Object.keys(expected).some(k=>after[k]!==expected[k]))fail('STALE_AGENT_PAGE');return after;};
 const release=async()=>{const old=state;if(old){try{await old.send('Runtime.releaseObjectGroup',{objectGroup:group});}catch(error){poisoned=true;throw error;}if(state===old)state=null;}};
 return Object.freeze({
  context(){authorize();const expected=current();guard(expected);return Object.freeze({binding:b,document:Object.freeze({controlSessionId:expected.controlSessionId,pageEpoch:expected.pageEpoch,viewportVersion:expected.viewportVersion})});},
  observe(query,context,limits={}){
   try{
    if(closed)fail('AGENT_RUN_CLOSED');authorize();const request=captureManagedAgentObservation(query,limits),ctx=captureAgentObservationContext(context),supplied=ctx.binding;if(Object.keys(b).some(k=>supplied[k]!==b[k]))fail('AGENT_INVALID_CONTEXT');if(pending)fail('AGENT_OBSERVATION_BUSY');const expected=current();guard(expected,ctx.document);const observationId='obs_'+randomUUID(),handles=Array.from({length:request.limits.maxNodes},()=> 'elh_'+randomUUID());
    pending=Promise.resolve().then(async()=>{
     try{
      if(state&&Object.keys(expected).some(k=>state.expected[k]!==expected[k]))await release();guard(expected,ctx.document);
      if(!state){state={objectId:null,cdp:expected.cdp,send:expected.send,expected};const expression='('+createAgentObservationRealm.toString()+')('+[expected.token,expected.documentToken,expected.subscriptionId].map(JSON.stringify).join(',')+')',response=await expected.send('Runtime.evaluate',{contextId:expected.world,expression,objectGroup:group,returnByValue:false,awaitPromise:false,silent:true,generatePreview:false,timeout:100});guard(expected,ctx.document);if(response.exceptionDetails||typeof response.result?.objectId!=='string'||response.result.objectId.length>1024)fail('AGENT_OBSERVATION_FAILED');state.objectId=response.result.objectId;}
      guard(expected,ctx.document);const response=await expected.send('Runtime.callFunctionOn',{objectId:state.objectId,functionDeclaration:'function(request,handles){return this.read(request,handles);}',arguments:[{value:request},{value:handles}],returnByValue:true,awaitPromise:false,silent:true,generatePreview:false});guard(expected,ctx.document);if(response.exceptionDetails)fail('AGENT_OBSERVATION_FAILED');const value=response.result?.value;if(value?.ok===false&&['STALE_AGENT_PAGE','STALE_AGENT_ELEMENT','AGENT_OBSERVATION_LIMIT'].includes(value.code))fail(value.code);if(value?.ok!==true)fail('AGENT_OBSERVATION_FAILED');const {ok,...body}=data(value,['ok','revision','url','title','visited','truncated','nodes'],undefined,'AGENT_OBSERVATION_FAILED');return captureAgentObservationResult({stage:'observed',binding:b,document:{controlSessionId:expected.controlSessionId,pageEpoch:expected.pageEpoch,viewportVersion:expected.viewportVersion},observationId,observedAt:new Date().toISOString(),version,scope:'main-document-light-dom',query:request.query,limits:request.limits,...body},{binding:b,document:ctx.document,observation:request});
     }catch(error){if(state?.objectId===null){try{await release();}catch{poisoned=true;}}throw error instanceof AgentInputError?error:new AgentInputError('AGENT_OBSERVATION_FAILED','not-dispatched');}
    });const work=pending;void work.finally(()=>{if(pending===work)pending=null;}).catch(()=>{});return work;
   }catch(error){return Promise.reject(error instanceof AgentInputError?error:new AgentInputError('AGENT_OBSERVATION_FAILED','not-dispatched'));}
  },
  close(){if(closing)return closing;closed=true;closing=(async()=>{try{await pending;}catch{}try{await release();}catch{throw new AgentInputError('AGENT_OBSERVATION_FAILED','unknown');}})();return closing;},
  status:()=>Object.freeze({pending:pending!==null,closed,realm:state!==null})
 });
}
