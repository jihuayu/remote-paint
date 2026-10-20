import {agentCancellationAfter,agentCancellationReport} from './agent-cancellation.mjs';
import {publicDownload,captureDownloadFile,checkDownloadFileChunk} from './agent-download-access.mjs';
import {publicScreenshot,captureScreenshotDownload,checkScreenshotDownloadChunk} from './agent-screenshot-access.mjs';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {SqliteSessionStore} from './session-store.mjs';
import {agentNeverDispatchedDigest} from './session-agent-journal.mjs';
import {AGENT_EVENT_LIMITS} from './agent-event-journal.mjs';
import {sourceObservationContext,publicObservationContext,publicObservation,publicAccessibility} from './agent-observation-access.mjs';
import {captureAgentRequest,captureAgentResult,agentReplyExpectation,AgentRpcError,agentFailure} from './agent-rpc.mjs';

const codes=new Set(['AGENT_IDEMPOTENCY_CONFLICT','AGENT_INVOCATION_NOT_FOUND','AGENT_EXECUTOR_CLOSED','AGENT_EXECUTOR_CAPACITY','AGENT_EXECUTOR_BUSY','AGENT_RECOVERY_REQUIRED','AGENT_STORAGE_UNAVAILABLE','AGENT_EVENT_CURSOR_INVALID','AGENT_CANCELLATION_CURSOR_INVALID','AGENT_CANCELLATION_CHANGED']);
export class AgentExecutionError extends Error {
 constructor(code,outcome='not-dispatched'){super('Agent execution is unavailable');this.name='AgentExecutionError';this.code=codes.has(code)||new AgentRpcError(code).code===code?code:'AGENT_INPUT_FAILED';this.outcome=outcome==='unknown'?'unknown':'not-dispatched';}
}
const fail=(code,outcome)=>{throw new AgentExecutionError(code,outcome);};
function data(value,allowed,required=allowed){
 try{if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('AGENT_INVALID_REQUEST');const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.length>allowed.length||keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))fail('AGENT_INVALID_REQUEST');return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));}catch{fail('AGENT_INVALID_REQUEST');}
}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_'+uuid+'$').test(v);
const tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const bounded=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const key=v=>typeof v==='string'&&/^[\x21-\x7e]{1,128}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sorted=value=>Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const errorRow=e=>({code:e.code,outcome:e.outcome});
const stamp=row=>new Date(Math.max(Date.now(),Date.parse(row?.updatedAt??row?.createdAt??0)||0)).toISOString();
function options(value={}){const v=data(value,['signal','timeoutMs'],[]);if(v.signal!==undefined&&!(v.signal instanceof AbortSignal)||v.timeoutMs!==undefined&&(!Number.isInteger(v.timeoutMs)||v.timeoutMs<50||v.timeoutMs>120000))fail('AGENT_INVALID_REQUEST');return Object.freeze(v);}
function runRequest(value){const v=data(value,['tenantId','agentRunId']);if(!tenant(v.tenantId)||!id(v.agentRunId,'arun'))fail('AGENT_INVALID_REQUEST');return v;}
function runView(row){const {agentRunId,sessionId,region,version,state,reserved,beginDispatch,endDispatch,createdAt,updatedAt,error}=row;return structuredClone({agentRunId,sessionId,region,version,state,holdsWriter:reserved,beginDispatch,endDispatch,createdAt,updatedAt,error});}
function invocationView(row){const {invocationId,agentRunId,sessionId,tool,fence,state,dispatchStarted,receipt,error,createdAt,updatedAt}=row;return structuredClone({invocationId,agentRunId,sessionId,tool,fence,state,dispatchStarted,receipt:receipt&&{stage:receipt.stage,inputs:receipt.inputs},error,createdAt,updatedAt});}

// Trusted backend service, not a public HTTP authorizer. Each acknowledged
// intent is durable before work is scheduled. No action payload is persisted.
export class DurableAgentExecutor {
 #store;#registry;#registryIdentity;#providers;#actionKey;#owner=Symbol('durable-Agent-executor');#claimed=false;#fault=false;#stopping=false;#ordinary=new Map();#ending=new Map();#recovered=new Set();#max;#timeout;#shutdown=null;
 constructor({store,registry,providers,actionKey,maxConcurrent=64,timeoutMs=5000}={}){
  if(!(store instanceof SqliteSessionStore)||!registry||typeof registry.requireReady!=='function'||!(providers instanceof Map)||!providers.size||providers.size>64||typeof actionKey!=='string'||!/^[a-f0-9]{64}$/.test(actionKey)||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>256||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>120000)throw TypeError('Configure a private Session store, Registry, Agent providers and 32-byte action key');
  this.#providers=new Map();for(const [region,provider]of providers){if(!bounded(region,64)||!provider||typeof provider.agent!=='function')throw TypeError('Configure bounded Agent provider regions');this.#providers.set(region,provider.agent.bind(provider));}
  this.#store=store;this.#registry=registry.requireReady.bind(registry);this.#registryIdentity=registry;this.#actionKey=Buffer.from(actionKey,'hex');this.#max=maxConcurrent;this.#timeout=timeoutMs;
  try{
   const snapshot=store.claimAgentController(this.#owner,{compact:true});this.#claimed=true;this.#recovered=new Set(snapshot.recoveryRequired);
   for(const row of this.#records('invocations',{unfinishedOnly:true})){if(row.state==='intent')this.#writeInvocation({...row,state:'rejected',error:{code:'AGENT_OWNER_LOST',outcome:'not-dispatched'},updatedAt:stamp(row)});else if(row.state==='requested')this.#writeInvocation({...row,state:'unknown',error:{code:'AGENT_OWNER_LOST',outcome:'unknown'},updatedAt:stamp(row)});}
   for(const row of this.#records('runs',{reservedOnly:true})){if(!row.reserved)continue;const current=this.#reconcile(row.agentRunId);if(current.state==='closed')continue;if(current.beginDispatch==='not-requested')this.#writeRun({...current,state:'closed',reserved:false,closeEvidence:{kind:'never-dispatched',evidenceSha256:agentNeverDispatchedDigest(current)},updatedAt:stamp(current)});else if(current.state!=='recovery-required')this.#writeRun({...current,state:'recovery-required',error:current.error??{code:'AGENT_OWNER_LOST',outcome:'unknown'},updatedAt:stamp(current)});}
  }catch{this.#fault=true;if(this.#claimed){try{store.releaseAgentController(this.#owner);}catch{}this.#claimed=false;}this.#actionKey.fill(0);fail('AGENT_STORAGE_UNAVAILABLE');}
 }
 #snapshot(){if(!this.#claimed||this.#fault)fail(this.#fault?'AGENT_STORAGE_UNAVAILABLE':'AGENT_EXECUTOR_CLOSED');try{return this.#store.agentHead({owner:this.#owner});}catch{this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}}
 #read(method,...args){this.#snapshot();try{return this.#store[method](...args,{owner:this.#owner});}catch{this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}}
 *#records(kind,options={}){let afterId='';for(;;){const page=this.#read('listAgentRecords',kind,{...options,afterId,limit:64});yield*page.records;if(page.nextCursor===null)return;afterId=page.nextCursor;}}
 #writeRun(row,admission=false){try{return this.#store.commitAgentRun(row,{owner:this.#owner}).run;}catch(error){if(admission&&error.code==='STATE_AGENT_LIMIT')fail('AGENT_EXECUTOR_CAPACITY');this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE','unknown');}}
 #writeInvocation(row,admission=false){try{return this.#store.commitAgentInvocation(row,{owner:this.#owner}).invocation;}catch(error){if(admission&&error.code==='STATE_AGENT_LIMIT')fail('AGENT_EXECUTOR_CAPACITY');this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE','unknown');}}
 #reconcile(id){try{return this.#store.reconcileAgentRun(id,{owner:this.#owner}).run;}catch{this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}}
 #run(request,{reconcile=true}={}){const row=this.#read('getAgentRun',request.agentRunId);if(!row||row.tenant!==request.tenantId)fail('AGENT_RUN_NOT_FOUND');return reconcile?this.#reconcile(row.agentRunId):row;}
 #admit(){this.#snapshot();if(this.#stopping)fail('AGENT_EXECUTOR_CLOSED');}
 #ready(row){this.#snapshot();try{const current=this.#registry(row.tenant,row.sessionId);if(current.region!==row.region||current.version!==row.version||current.state!=='ready'||!current.holdsQuota)throw Error();}catch{throw new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched');}this.#snapshot();}
 #active(row){if(this.#recovered.has(row.agentRunId)||row.state!=='active'||!row.reserved)fail('AGENT_RECOVERY_REQUIRED');}
 #readable(row){if(!row.reserved||['closing','closed'].includes(row.state)||row.endDispatch!=='not-requested')fail('AGENT_RUN_CLOSED');if(this.#recovered.has(row.agentRunId)||!row.binding||row.beginDispatch!=='confirmed'||!['active','recovery-required'].includes(row.state))fail('AGENT_RECOVERY_REQUIRED');}
 #capacity(map,id){if(map.has(id))fail('AGENT_EXECUTOR_BUSY');if(map.size>=this.#max)fail('AGENT_EXECUTOR_CAPACITY');}
 #track(map,id,action,observable=false){
  // Install before scheduling any possibly reentrant provider work.
  const entry={kind:null,promise:null};map.set(id,entry);const done=()=>{if(map.get(id)===entry)map.delete(id);};entry.promise=Promise.resolve().then(action).then(value=>{done();return {ok:true,value};},error=>{done();if(!observable||!(error instanceof AgentExecutionError))this.#fault=true;return {ok:false,error};});return entry;
 }
 #uncertainRun(id,error){if(this.#fault||!this.#claimed)return;const existing=this.#read('getAgentRun',id);if(!existing)return;const row=this.#run({tenantId:existing.tenant,agentRunId:id});if(row.state==='closed')return;if(row.state==='intent')return;this.#writeRun({...row,state:'recovery-required',error:row.error??{code:error.code,outcome:'unknown'},updatedAt:stamp(row)});}
 async #rpc(row,command,opts){
  this.#ready(row);const current=this.#run({tenantId:row.tenant,agentRunId:row.agentRunId});if(['observe','observation-context','observe-ax','observe-screenshot','read-screenshot','release-screenshot','arm-download','download-info','read-download','release-download'].includes(command.op))this.#readable(current);if(this.#recovered.has(row.agentRunId)||command.op==='begin'&&current.state!=='starting'||['perform','context'].includes(command.op)&&current.state!=='active'||command.op==='end'&&(current.state!=='closing'||current.endDispatch!=='requested'))throw new AgentRpcError('AGENT_RUN_CLOSED','not-dispatched');if(opts.signal?.aborted)throw new AgentRpcError('AGENT_RPC_CANCELLED','not-dispatched');const call=this.#providers.get(row.region);if(!call)throw new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched');
  let result;try{result=await call({tenantId:row.tenant,sessionId:row.sessionId,region:row.region,version:row.version,command,timeoutMs:opts.timeoutMs??this.#timeout,...(opts.signal?{signal:opts.signal}:{})});}catch(error){throw agentFailure(error,'unknown');}
  // Validation and loss of Ready after a possible send are always unknown.
  try{this.#ready(row);return captureAgentResult(result,agentReplyExpectation(command),{tenantId:row.tenant,sessionId:row.sessionId,version:row.version});}catch{throw new AgentRpcError('AGENT_INVALID_REPLY','unknown');}
 }
 create(value,callOptions){
  const v=data(value,['tenantId','sessionId','region','version','idempotencyKey']),opts=options(callOptions);if(!tenant(v.tenantId)||!id(v.sessionId,'ses')||!bounded(v.region,64)||!bounded(v.version,256)||!key(v.idempotencyKey))fail('AGENT_INVALID_REQUEST');
  const keyHash=hash(['Agent-create-key-v1',v.tenantId,v.idempotencyKey]),fingerprint=hash(['Agent-create-request-v1',v.sessionId,v.region,v.version]),prior=this.#read('findAgentRun',v.tenantId,keyHash);if(prior){if(prior.fingerprint!==fingerprint)fail('AGENT_IDEMPOTENCY_CONFLICT');return runView(this.#reconcile(prior.agentRunId));}
  this.#admit();if(opts.signal?.aborted)fail('AGENT_RPC_CANCELLED');const at=stamp(),row={agentRunId:'arun_'+randomUUID(),sessionId:v.sessionId,tenant:v.tenantId,region:v.region,version:v.version,createKeyHash:keyHash,fingerprint,state:'intent',reserved:true,beginDispatch:'not-requested',binding:null,beginResultHash:null,endDispatch:'not-requested',closeEvidence:null,error:null,createdAt:at,updatedAt:at};this.#ready(row);
  if(this.#read('findAgentWriter',row.sessionId))fail('AGENT_RUN_BUSY');this.#capacity(this.#ordinary,row.agentRunId);this.#writeRun(row,true);const task=this.#track(this.#ordinary,row.agentRunId,()=>this.#begin(row,opts));task.kind='begin';return runView(row);
 }
 async #begin(initial,opts){
  let sent=false;
  try{
   let row=this.#run({tenantId:initial.tenant,agentRunId:initial.agentRunId});if(row.state==='closed')return;if(row.state!=='intent'||this.#stopping||opts.signal?.aborted){if(row.state==='intent')this.#writeRun({...row,state:'closed',reserved:false,closeEvidence:{kind:'never-dispatched',evidenceSha256:agentNeverDispatchedDigest(row)},updatedAt:stamp(row)});return;}
   this.#ready(row);row=this.#writeRun({...row,state:'starting',beginDispatch:'requested',updatedAt:stamp(row)});sent=true;const result=await this.#rpc(row,Object.freeze({op:'begin'}),opts);row=this.#run({tenantId:row.tenant,agentRunId:row.agentRunId});if(row.state==='closed')return;
   this.#writeRun({...row,state:row.state==='starting'?'active':'closing',beginDispatch:'confirmed',binding:{workerRunId:result.binding.runId,targetId:result.binding.targetId,controlSessionId:result.fence.controlSessionId},beginResultHash:hash(result),updatedAt:stamp(row)});
  }catch(error){
   if(this.#fault)return;const e=agentFailure(error,sent?'unknown':'not-dispatched'),row=this.#run({tenantId:initial.tenant,agentRunId:initial.agentRunId});if(row.state==='closed')return;
   if(row.beginDispatch==='not-requested')this.#writeRun({...row,state:'closed',reserved:false,closeEvidence:{kind:'never-dispatched',evidenceSha256:agentNeverDispatchedDigest(row)},updatedAt:stamp(row)});
   else if(e.outcome==='not-dispatched'){const digest=hash({schema:'Agent-begin-rejection-v1',agentRunId:row.agentRunId,error:errorRow(e)});this.#writeRun({...row,state:'closed',reserved:false,beginResultHash:digest,error:errorRow(e),closeEvidence:{kind:'begin-rejected',evidenceSha256:digest},updatedAt:stamp(row)});}
   else this.#uncertainRun(row.agentRunId,e);
  }
 }
 getRun(value){return runView(this.#run(runRequest(value)));}
 getInvocation(value){const v=data(value,['tenantId','invocationId']);if(!tenant(v.tenantId)||!id(v.invocationId,'ainv'))fail('AGENT_INVALID_REQUEST');const row=this.#read('getAgentInvocation',v.invocationId);if(!row||row.tenant!==v.tenantId)fail('AGENT_INVOCATION_NOT_FOUND');return invocationView(row);}
 events(value){
  const v=data(value,['tenantId','agentRunId','after','limit'],['tenantId','agentRunId']),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId}),after=Object.hasOwn(v,'after')?v.after:0,limit=Object.hasOwn(v,'limit')?v.limit:AGENT_EVENT_LIMITS.pageEvents;
  if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>AGENT_EVENT_LIMITS.pageEvents)fail('AGENT_INVALID_REQUEST');const row=this.#run(ref);
  try{return this.#store.listAgentEvents(row.agentRunId,row.tenant,{after,limit},{owner:this.#owner});}catch(error){if(error?.code==='STATE_AGENT_EVENT_CURSOR')fail('AGENT_EVENT_CURSOR_INVALID');this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}
 }
 cancellation(value){
  const v=data(value,['tenantId','agentRunId','after'],['tenantId','agentRunId']),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#run(ref);let options;
  try{options=agentCancellationAfter(v.agentRunId,v.after);}catch{fail('AGENT_CANCELLATION_CURSOR_INVALID');}
  this.#snapshot();let snapshot;
  try{snapshot=this.#store.agentCancellationSnapshot(v.agentRunId,v.tenantId,options,{owner:this.#owner});}catch(error){if(error?.code==='STATE_AGENT_CANCELLATION_CHANGED')fail('AGENT_CANCELLATION_CHANGED');if(error?.code==='STATE_AGENT_CANCELLATION_CURSOR')fail('AGENT_CANCELLATION_CURSOR_INVALID');this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}
  try{return agentCancellationReport(snapshot,{ordinaryPending:this.#ordinary.has(v.agentRunId),endPending:this.#ending.has(v.agentRunId),recoveryRequired:this.#recovered.has(v.agentRunId),executorStopping:this.#stopping});}catch{this.#fault=true;fail('AGENT_STORAGE_UNAVAILABLE');}
 }
 context(value,callOptions){
  const v=runRequest(value),opts=options(callOptions);this.#admit();const row=this.#run(v);this.#active(row);this.#capacity(this.#ordinary,row.agentRunId);
  const task=this.#track(this.#ordinary,row.agentRunId,async()=>{try{const current=this.#run(v);this.#active(current);const result=await this.#rpc(current,Object.freeze({op:'context',runId:current.binding.workerRunId}),opts);if(!same(result.binding,{tenantId:row.tenant,sessionId:row.sessionId,targetId:row.binding.targetId,runId:row.binding.workerRunId})||result.fence.controlSessionId!==row.binding.controlSessionId)throw new AgentRpcError('AGENT_INVALID_REPLY','unknown');this.#active(this.#run(v));return result;}catch(error){let e=error instanceof AgentExecutionError?error:agentFailure(error);try{if(e.outcome==='unknown')this.#uncertainRun(row.agentRunId,e);}catch{e=new AgentExecutionError('AGENT_STORAGE_UNAVAILABLE','unknown');}throw new AgentExecutionError(e.code,e.outcome);}},true);return task.promise.then(result=>{if(!result.ok)throw result.error;return result.value;});
 }
 observationContext(value,callOptions){
  const v=runRequest(value),opts=options(callOptions);this.#admit();const row=this.#run(v);this.#readable(row);return this.#observationRead(row,Object.freeze({op:'observation-context',runId:row.binding.workerRunId}),opts);
 }
 observe(value,callOptions){
  const v=data(value,['tenantId','agentRunId','context','query','limits'],['tenantId','agentRunId','context','query']),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const context=sourceObservationContext(v.context,row),command=captureAgentRequest({op:'observe',runId:row.binding.workerRunId,context,query:v.query,limits:Object.hasOwn(v,'limits')?v.limits:{}});return this.#observationRead(row,command,opts);
 }
 observeAccessibility(value,callOptions){
  const v=data(value,['tenantId','agentRunId','context','elementId','limits'],['tenantId','agentRunId','context','elementId']),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const context=sourceObservationContext(v.context,row),command=captureAgentRequest({op:'observe-ax',runId:row.binding.workerRunId,context,elementId:v.elementId,limits:Object.hasOwn(v,'limits')?v.limits:{}});return this.#observationRead(row,command,opts);
 }
 screenshot(value,callOptions){return this.#screenshotRead('observe-screenshot',value,callOptions);}
 readScreenshot(value,callOptions){return this.#screenshotRead('read-screenshot',value,callOptions);}
 releaseScreenshot(value,callOptions){return this.#screenshotRead('release-screenshot',value,callOptions);}
 #screenshotRead(op,value,callOptions){const fields=op==='observe-screenshot'?['tenantId','agentRunId','context','limits']:op==='read-screenshot'?['tenantId','agentRunId','context','screenshotId','offset','maxBytes']:['tenantId','agentRunId','context','screenshotId'],required=fields.filter(k=>!['limits','maxBytes'].includes(k)),v=data(value,fields,required),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const context=sourceObservationContext(v.context,row),command=captureAgentRequest({op,runId:row.binding.workerRunId,context,...(op==='observe-screenshot'?{limits:Object.hasOwn(v,'limits')?v.limits:{}}:op==='read-screenshot'?{screenshotId:v.screenshotId,offset:v.offset,maxBytes:Object.hasOwn(v,'maxBytes')?v.maxBytes:3072}:{screenshotId:v.screenshotId})});return this.#observationRead(row,command,opts);}
 armDownload(value,callOptions){return this.#downloadRead('arm-download',value,callOptions);}
 downloadInfo(value,callOptions){return this.#downloadRead('download-info',value,callOptions);}
 readDownload(value,callOptions){return this.#downloadRead('read-download',value,callOptions);}
 releaseDownload(value,callOptions){return this.#downloadRead('release-download',value,callOptions);}
 #downloadRead(op,value,callOptions){const fields=op==='arm-download'?['tenantId','agentRunId','context','limits']:op==='read-download'?['tenantId','agentRunId','context','downloadId','offset','maxBytes']:['tenantId','agentRunId','context','downloadId'],required=fields.filter(k=>!['limits','maxBytes'].includes(k)),v=data(value,fields,required),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const context=sourceObservationContext(v.context,row),command=captureAgentRequest({op,runId:row.binding.workerRunId,context,...(op==='arm-download'?{limits:Object.hasOwn(v,'limits')?v.limits:{}}:op==='read-download'?{downloadId:v.downloadId,offset:v.offset,maxBytes:Object.hasOwn(v,'maxBytes')?v.maxBytes:3072}:{downloadId:v.downloadId})});return this.#observationRead(row,command,opts);}
 downloadFile(value,sink,callOptions){
  const v=data(value,['tenantId','agentRunId','context','downloadId','sha256','byteLength','completedAt']),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const request=captureDownloadFile({context:v.context,downloadId:v.downloadId,sha256:v.sha256,byteLength:v.byteLength,completedAt:v.completedAt},row),consumer=data(sink,['start','write','finish']);if(Object.values(consumer).some(v=>typeof v!=='function'))fail('AGENT_INVALID_REQUEST');if(opts.signal?.aborted)fail('AGENT_RPC_CANCELLED');this.#capacity(this.#ordinary,row.agentRunId);
  let started=false;const task=this.#track(this.#ordinary,row.agentRunId,async()=>{try{let offset=0,first=true;const digest=createHash('sha256'),check=()=>{if(opts.signal?.aborted)throw new AgentExecutionError('AGENT_RPC_CANCELLED',started?'unknown':'not-dispatched');this.#readable(this.#run(ref));this.#ready(row);if(this.#stopping)fail('AGENT_EXECUTOR_CLOSED');};
   for(;;){check();const command=captureAgentRequest({op:'read-download',runId:row.binding.workerRunId,context:request.context,downloadId:request.downloadId,offset,maxBytes:3072}),chunk=await (started=true,this.#rpc(row,command,{...(opts.timeoutMs===undefined?{}:{timeoutMs:opts.timeoutMs})}));check();const bytes=checkDownloadFileChunk(chunk,request,first);digest.update(bytes);if(chunk.complete&&digest.digest('hex')!==request.sha256)throw new AgentExecutionError('AGENT_INVALID_REPLY','unknown');if(first){await consumer.start(Object.freeze({context:request.publicContext,downloadId:request.downloadId,sha256:request.sha256,byteLength:request.byteLength,completedAt:request.completedAt}));check();first=false;}await consumer.write(bytes);check();offset+=bytes.length;if(chunk.complete){await consumer.finish();check();return Object.freeze({stage:'download-delivered',agentRunId:row.agentRunId,downloadId:request.downloadId,byteLength:offset,sha256:request.sha256});}}
  }catch(error){const e=error instanceof AgentExecutionError?error:agentFailure(error);throw new AgentExecutionError(e.code,e.outcome);}},true);task.kind='observation';return new Promise((resolve,reject)=>{const abort=()=>reject(new AgentExecutionError('AGENT_RPC_CANCELLED',started?'unknown':'not-dispatched'));opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)abort();task.promise.then(result=>result.ok?resolve(result.value):reject(result.error)).finally(()=>opts.signal?.removeEventListener('abort',abort));});
 }
 downloadScreenshot(value,sink,callOptions){
  const v=data(value,['tenantId','agentRunId','context','screenshotId','sha256','byteLength','observedAt']),opts=options(callOptions),ref=runRequest({tenantId:v.tenantId,agentRunId:v.agentRunId});this.#admit();const row=this.#run(ref);this.#readable(row);const request=captureScreenshotDownload({context:v.context,screenshotId:v.screenshotId,sha256:v.sha256,byteLength:v.byteLength,observedAt:v.observedAt},row),consumer=data(sink,['start','write','finish']);if(Object.values(consumer).some(v=>typeof v!=='function'))fail('AGENT_INVALID_REQUEST');if(opts.signal?.aborted)fail('AGENT_RPC_CANCELLED');this.#capacity(this.#ordinary,row.agentRunId);
  let started=false;const task=this.#track(this.#ordinary,row.agentRunId,async()=>{try{let offset=0,first=true;const digest=createHash('sha256'),check=()=>{if(opts.signal?.aborted)throw new AgentExecutionError('AGENT_RPC_CANCELLED',started?'unknown':'not-dispatched');this.#readable(this.#run(ref));this.#ready(row);if(this.#stopping)fail('AGENT_EXECUTOR_CLOSED');};
   for(;;){check();const command=captureAgentRequest({op:'read-screenshot',runId:row.binding.workerRunId,context:request.context,screenshotId:request.screenshotId,offset,maxBytes:3072}),chunk=await (started=true,this.#rpc(row,command,{...(opts.timeoutMs===undefined?{}:{timeoutMs:opts.timeoutMs})}));check();const bytes=checkScreenshotDownloadChunk(chunk,request,first);digest.update(bytes);if(chunk.complete&&digest.digest('hex')!==request.sha256)throw new AgentExecutionError('AGENT_INVALID_REPLY','unknown');if(first){await consumer.start(Object.freeze({context:request.publicContext,screenshotId:request.screenshotId,sha256:request.sha256,byteLength:request.byteLength,observedAt:request.observedAt}));check();first=false;}await consumer.write(bytes);check();offset+=bytes.length;if(chunk.complete){await consumer.finish();check();return Object.freeze({stage:'screenshot-downloaded',agentRunId:row.agentRunId,screenshotId:request.screenshotId,byteLength:offset,sha256:request.sha256});}}
  }catch(error){const e=error instanceof AgentExecutionError?error:agentFailure(error);throw new AgentExecutionError(e.code,e.outcome);}},true);task.kind='observation';return new Promise((resolve,reject)=>{const abort=()=>reject(new AgentExecutionError('AGENT_RPC_CANCELLED',started?'unknown':'not-dispatched'));opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)abort();task.promise.then(result=>result.ok?resolve(result.value):reject(result.error)).finally(()=>opts.signal?.removeEventListener('abort',abort));});
 }
 #observationRead(row,command,opts){
  if(opts.signal?.aborted)fail('AGENT_RPC_CANCELLED');this.#capacity(this.#ordinary,row.agentRunId);let task;
  task=this.#track(this.#ordinary,row.agentRunId,async()=>{
   let replied=false;
   try{
    if(opts.signal?.aborted)throw new AgentRpcError('AGENT_RPC_CANCELLED','not-dispatched');const current=this.#run({tenantId:row.tenant,agentRunId:row.agentRunId});this.#readable(current);if(this.#stopping)fail('AGENT_EXECUTOR_CLOSED');task.started=true;
    // Caller cancellation observes only this read. Never pass it into Source
    // or change durable writer state because a read result is unavailable.
    const result=await this.#rpc(current,command,{...(opts.timeoutMs===undefined?{}:{timeoutMs:opts.timeoutMs})});replied=true;const after=this.#run({tenantId:row.tenant,agentRunId:row.agentRunId});this.#readable(after);if(this.#stopping)fail('AGENT_EXECUTOR_CLOSED');return command.op==='observation-context'?publicObservationContext(after,result):command.op==='observe-ax'?publicAccessibility(after,result):['observe-screenshot','read-screenshot','release-screenshot'].includes(command.op)?publicScreenshot(after,result,command.op==='observe-screenshot'?'screenshot':command.op==='read-screenshot'?'chunk':'released'):['arm-download','download-info','read-download','release-download'].includes(command.op)?publicDownload(after,result,command.op==='arm-download'?'armed':command.op==='download-info'?'info':command.op==='read-download'?'chunk':'released'):publicObservation(after,result);
   }catch(error){const e=error instanceof AgentExecutionError?error:agentFailure(error);throw new AgentExecutionError(e.code,replied&&error instanceof AgentExecutionError?'unknown':e.outcome);}
  },true);task.kind='observation';task.started=false;
  return new Promise((resolve,reject)=>{
   const abort=()=>reject(new AgentExecutionError('AGENT_RPC_CANCELLED',task.started?'unknown':'not-dispatched'));opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)abort();
   task.promise.then(result=>{if(result.ok)resolve(result.value);else reject(result.error);}).finally(()=>opts.signal?.removeEventListener('abort',abort));
  });
 }
 perform(value,callOptions){
  const v=data(value,['tenantId','agentRunId','idempotencyKey','tool','params','context']),opts=options(callOptions);if(!tenant(v.tenantId)||!id(v.agentRunId,'arun')||!key(v.idempotencyKey))fail('AGENT_INVALID_REQUEST');const row=this.#run(v);if(!row.binding)fail('AGENT_RECOVERY_REQUIRED');const command=captureAgentRequest({op:'perform',runId:row.binding.workerRunId,tool:v.tool,params:v.params,context:v.context});
  if(command.context.binding.tenantId!==row.tenant||command.context.binding.sessionId!==row.sessionId||command.context.binding.targetId!==row.binding.targetId||command.context.fence.controlSessionId!==row.binding.controlSessionId)fail('AGENT_INVALID_CONTEXT');
  const keyHash=hash(['Agent-invocation-key-v1',row.tenant,row.agentRunId,v.idempotencyKey]),fingerprint=createHmac('sha256',this.#actionKey).update(JSON.stringify({schema:'Agent-action-fingerprint-v1',tool:command.tool,params:sorted(command.params),binding:command.context.binding,fence:command.context.fence})).digest('hex'),prior=this.#read('findAgentInvocation',row.agentRunId,row.tenant,keyHash);
  if(prior){if(prior.fingerprint!==fingerprint)fail('AGENT_IDEMPOTENCY_CONFLICT');return invocationView(prior);}
  this.#admit();this.#active(row);this.#ready(row);if(opts.signal?.aborted)fail('AGENT_RPC_CANCELLED');this.#capacity(this.#ordinary,row.agentRunId);const at=stamp(),invocation={invocationId:'ainv_'+randomUUID(),agentRunId:row.agentRunId,sessionId:row.sessionId,tenant:row.tenant,keyHash,fingerprint,tool:command.tool,fence:{...command.context.fence},state:'intent',dispatchStarted:false,receipt:null,error:null,createdAt:at,updatedAt:at};this.#writeInvocation(invocation,true);this.#track(this.#ordinary,row.agentRunId,()=>this.#perform(row,invocation,command,opts));return invocationView(invocation);
 }
 async #perform(run,initial,command,opts){
  let sent=false;
  try{
   const current=this.#run({tenantId:run.tenant,agentRunId:run.agentRunId});this.#active(current);if(this.#stopping||opts.signal?.aborted)throw new AgentRpcError('AGENT_RPC_CANCELLED','not-dispatched');this.#ready(current);this.#writeInvocation({...initial,state:'requested',dispatchStarted:true,updatedAt:stamp(initial)});sent=true;const result=await this.#rpc(current,command,opts);this.#writeInvocation({...initial,state:'injected',dispatchStarted:true,receipt:{stage:'input-injected',inputs:result.inputs,evidenceSha256:hash(result)},updatedAt:stamp(initial)});
  }catch(error){if(this.#fault)return;const e=error instanceof AgentExecutionError?new AgentRpcError('AGENT_RUN_CLOSED',sent?'unknown':'not-dispatched'):agentFailure(error,sent?'unknown':'not-dispatched');this.#writeInvocation({...initial,state:e.outcome==='unknown'?'unknown':'rejected',dispatchStarted:sent,error:errorRow(e),updatedAt:stamp(initial)});if(e.outcome==='unknown')this.#uncertainRun(run.agentRunId,e);}
 }
 end(value,callOptions){
  const v=runRequest(value),opts=options(callOptions);this.#snapshot();const row=this.#run(v);if(row.state==='closed'||this.#ending.has(row.agentRunId)||row.endDispatch!=='not-requested')return runView(row);
  if(this.#recovered.has(row.agentRunId))return runView(row);
  if(row.beginDispatch==='not-requested'){return runView(this.#writeRun({...row,state:'closed',reserved:false,closeEvidence:{kind:'never-dispatched',evidenceSha256:agentNeverDispatchedDigest(row)},updatedAt:stamp(row)}));}
  if(row.binding===null&&!this.#ordinary.has(row.agentRunId)){this.#uncertainRun(row.agentRunId,new AgentRpcError('AGENT_UNAVAILABLE','unknown'));return runView(this.#run(v));}
  this.#capacity(this.#ending,row.agentRunId);let current=row;if(row.state!=='closing')current=this.#writeRun({...row,state:'closing',updatedAt:stamp(row)});const begin=this.#ordinary.get(row.agentRunId);this.#track(this.#ending,row.agentRunId,()=>this.#end(current,opts,begin?.kind==='begin'?begin.promise:null));return runView(current);
 }
 async #end(initial,opts,begin){
  try{
   if(begin)await begin;let row=this.#run({tenantId:initial.tenant,agentRunId:initial.agentRunId});if(row.state==='closed')return;if(!row.binding){this.#uncertainRun(row.agentRunId,new AgentRpcError('AGENT_UNAVAILABLE','unknown'));return;}if(row.endDispatch!=='not-requested')return;
   row=this.#writeRun({...row,state:'closing',endDispatch:'requested',updatedAt:stamp(row)});const result=await this.#rpc(row,Object.freeze({op:'end',runId:row.binding.workerRunId}),opts);if(result.binding.targetId!==row.binding.targetId||result.binding.runId!==row.binding.workerRunId)throw new AgentRpcError('AGENT_INVALID_REPLY','unknown');row=this.#run({tenantId:row.tenant,agentRunId:row.agentRunId});if(row.state==='closed')return;this.#writeRun({...row,state:'closed',reserved:false,endDispatch:'confirmed',closeEvidence:{kind:'worker-run-closed',evidenceSha256:hash(result)},updatedAt:stamp(row)});
  }catch(error){if(!this.#fault)this.#uncertainRun(initial.agentRunId,agentFailure(error));}
 }
 status(){return Object.freeze({state:this.#fault?'fault':!this.#claimed?'closed':this.#stopping?'stopping':'active',ordinary:this.#ordinary.size,ending:this.#ending.size,ownerHeld:this.#claimed});}
 usesRegistry(registry){return this.#registryIdentity===registry;}
 shutdown({timeoutMs=5000}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw TypeError('Configure a bounded shutdown observation');
  if(!this.#shutdown){this.#stopping=true;this.#shutdown=Promise.resolve().then(async()=>{
   if(!this.#fault&&this.#claimed){for(const row of this.#records('runs',{reservedOnly:true})){if(!row.reserved)continue;while(this.#ending.size>=this.#max)await Promise.race([...this.#ending.values()].map(x=>x.promise));this.end({tenantId:row.tenant,agentRunId:row.agentRunId});const end=this.#ending.get(row.agentRunId);if(end)await end.promise;}}
   while(this.#ordinary.size||this.#ending.size)await Promise.all([...this.#ordinary.values(),...this.#ending.values()].map(x=>x.promise));let remaining=[];if(!this.#fault&&this.#claimed)for(const row of this.#records('runs',{reservedOnly:true}))remaining.push(row.agentRunId);if(this.#claimed){this.#store.releaseAgentController(this.#owner);this.#claimed=false;}this.#actionKey.fill(0);return Object.freeze({status:this.#fault||remaining.length?'unconfirmed':'closed',remainingRuns:remaining});
  }).catch(()=>{this.#fault=true;return Object.freeze({status:'unconfirmed'});});}
  return new Promise(resolve=>{const timer=setTimeout(()=>resolve(Object.freeze({status:'unconfirmed',pending:true})),timeoutMs);this.#shutdown.then(value=>{clearTimeout(timer);resolve(value);});});
 }
}
