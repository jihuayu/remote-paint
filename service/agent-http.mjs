import {AgentEventHttpError,agentEventCursor,agentEventAfter} from './agent-event-http.mjs';
import {capturePublicDownloadArmed,capturePublicDownloadInfo,capturePublicDownloadChunk,capturePublicDownloadReleased} from './agent-download-access.mjs';
import {capturePublicScreenshot,capturePublicScreenshotChunk,capturePublicScreenshotReleased} from './agent-screenshot-access.mjs';
import {DurableAgentExecutor,AgentExecutionError} from './agent-executor.mjs';
import {AgentRpcError,captureAgentContext} from './agent-rpc.mjs';
import {capturePublicObservationContext,capturePublicObservation,capturePublicAccessibility} from './agent-observation-access.mjs';
import {InputError} from '../live/input.mjs';

export const AGENT_HTTP_SCOPES=Object.freeze(['agents:read','agents:write','agents:end','agents:observe','agents:webhooks:read','agents:webhooks:write']);
const errors={
 AGENT_WEBHOOK_ENDPOINT_NOT_FOUND:[404,'Automatic Webhook endpoint not found'],AGENT_WEBHOOK_ENDPOINT_UNAVAILABLE:[503,'Webhook endpoint is unavailable'],AGENT_WEBHOOK_SUBSCRIPTION_NOT_FOUND:[404,'Webhook subscription not found'],AGENT_WEBHOOK_SUBSCRIPTION_CONFLICT:[409,'Webhook subscription start cursor is immutable'],AGENT_WEBHOOK_HISTORY_UNAVAILABLE:[409,'Webhook requires retained original event history'],AGENT_WEBHOOK_CAPACITY:[429,'Webhook subscription capacity reached'],AGENT_WEBHOOK_NOT_CONFIGURED:[503,'Webhook capture is unavailable'],
 AGENT_CANCELLATION_CURSOR_INVALID:[400,'Invalid Agent cancellation cursor'],AGENT_CANCELLATION_CHANGED:[409,'Agent cancellation report changed; restart from its first page'],
 AGENT_EVENT_CURSOR_INVALID:[400,'Invalid Agent event cursor'],AGENT_EVENT_GAP:[409,'Agent event history is no longer retained'],AGENT_EVENT_STREAM_STALLED:[504,'Agent event reader did not drain'],
 STALE_AGENT_DOWNLOAD:[409,'Agent download handle is stale'],AGENT_DOWNLOAD_BUSY:[409,'Agent download is in flight'],AGENT_DOWNLOAD_LIMIT:[413,'Agent download exceeds the allowed limit'],AGENT_DOWNLOAD_FAILED:[502,'Agent download could not be confirmed'],AGENT_DOWNLOAD_TIMEOUT:[504,'Agent download window expired'],AGENT_DOWNLOAD_CANCELLED:[409,'Agent download was cancelled'],
 STALE_AGENT_SCREENSHOT:[409,'Agent screenshot handle is stale'],INVALID_AGENT_OBSERVATION:[400,'Invalid Agent observation'],STALE_AGENT_ELEMENT:[409,'Agent element handle is stale'],STALE_AGENT_PAGE:[409,'Agent document context is stale'],
 AGENT_OBSERVATION_UNAVAILABLE:[409,'Agent observation is unavailable'],AGENT_OBSERVATION_BUSY:[409,'Agent observation is in flight'],AGENT_OBSERVATION_LIMIT:[413,'Agent observation exceeds the allowed limit'],AGENT_OBSERVATION_FAILED:[502,'Agent observation could not be confirmed'],
 AGENT_NOT_CONFIGURED:[503,'Agent access is unavailable'],AGENT_INVALID_REQUEST:[400,'Invalid Agent request'],AGENT_INVALID_CONTEXT:[400,'Invalid Agent context'],
 INVALID_AGENT_FENCE:[400,'Invalid Agent fence'],AGENT_ACTION_FORBIDDEN:[403,'Agent action is not allowed'],AGENT_METHOD_FORBIDDEN:[403,'Agent method is not allowed'],
 AGENT_RUN_NOT_FOUND:[404,'Agent run not found'],AGENT_INVOCATION_NOT_FOUND:[404,'Agent invocation not found'],
 AGENT_IDEMPOTENCY_CONFLICT:[409,'Idempotency key is already bound to another Agent request'],AGENT_RECOVERY_REQUIRED:[409,'Agent run requires reconciliation'],
 AGENT_RUN_BUSY:[409,'Session already has an Agent writer'],AGENT_RUN_CLOSED:[409,'Agent run is closed'],AGENT_PAUSED:[409,'Agent input is paused'],
 AGENT_EXECUTOR_BUSY:[409,'Agent operation is in flight'],AGENT_RPC_BUSY:[409,'Agent operation is in flight'],
 AGENT_EXECUTOR_CAPACITY:[429,'Agent capacity reached'],AGENT_EXECUTOR_CLOSED:[503,'Agent execution is unavailable'],AGENT_STORAGE_UNAVAILABLE:[503,'Agent state confirmation is unavailable'],
 AGENT_UNAVAILABLE:[409,'Agent Session is unavailable'],AGENT_RPC_TIMEOUT:[504,'Agent reply deadline exceeded'],AGENT_RPC_CANCELLED:[409,'Agent reply observation was cancelled'],
 AGENT_RPC_LIMIT:[413,'Agent request exceeds the allowed limit'],AGENT_INVALID_REPLY:[502,'Agent reply could not be confirmed'],AGENT_INPUT_FAILED:[502,'Agent operation could not be confirmed']
};
class AgentHttpError extends Error {constructor(code){super('Agent HTTP access is unavailable');this.code=code;this.outcome='not-dispatched';}}
export function agentHttpError(error){
 if(!(error instanceof AgentEventHttpError||error instanceof AgentHttpError||error instanceof AgentExecutionError||error instanceof AgentRpcError||error instanceof InputError))return null;
 const code=Object.hasOwn(errors,error.code)?error.code:'AGENT_INPUT_FAILED',[status,message]=errors[code];return {code,status,message,outcome:error.outcome==='unknown'?'unknown':'not-dispatched',...(error instanceof AgentEventHttpError&&error.code==='AGENT_EVENT_GAP'?{details:error.details}:{})};
}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const runPath=new RegExp('^/v1/agent-runs/(arun_'+uuid+')(?:/(cancel|cancellation|events/stream|events|context|invocations|end|observation-context|observations|accessibility-observations|screenshot-observations|screenshot-chunks|screenshot-releases|screenshot-downloads|download-arms|download-observations|download-chunks|download-releases|download-files))?$');
const webhookPath=new RegExp('^/v1/agent-runs/(arun_'+uuid+')/(webhook-endpoints|webhook-subscriptions)(?:/(awsub_'+uuid+'))?$');
const invocationPath=new RegExp('^/v1/agent-invocations/(ainv_'+uuid+')$');
const createPath=new RegExp('^/v1/sessions/(ses_'+uuid+')/agent-runs$');
export function agentHttpRoute(path){
 let match;if((match=webhookPath.exec(path))){if(match[2]==='webhook-endpoints'&&match[3])return null;const creating=match[2]==='webhook-subscriptions'&&!match[3];return {agent:true,method:creating?'POST':'GET',scope:creating?'agents:webhooks:write':'agents:webhooks:read',kind:'agent-webhook-'+(creating?'subscribe':match[3]?'subscription':'endpoints'),id:match[1],...(match[3]?{subscriptionId:match[3]}:{}),needsBody:creating};}
 if((match=createPath.exec(path)))return {agent:true,method:'POST',scope:'agents:write',kind:'agent-create',id:match[1],needsBody:true};
 if((match=invocationPath.exec(path)))return {agent:true,method:'GET',scope:'agents:read',kind:'agent-invocation',id:match[1]};
 if((match=runPath.exec(path))){const suffix=match[2],observation=['observations','observation-context','accessibility-observations','screenshot-observations','screenshot-chunks','screenshot-releases','screenshot-downloads','download-arms','download-observations','download-chunks','download-releases','download-files'].includes(suffix);return {agent:true,method:['invocations','end','cancel','observations','accessibility-observations','screenshot-observations','screenshot-chunks','screenshot-releases','screenshot-downloads','download-arms','download-observations','download-chunks','download-releases','download-files'].includes(suffix)?'POST':'GET',scope:observation?'agents:observe':suffix==='invocations'?'agents:write':['end','cancel'].includes(suffix)?'agents:end':'agents:read',kind:'agent-'+(suffix==='events/stream'?'event-stream':suffix??'run'),id:match[1],needsBody:['invocations','observations','accessibility-observations','screenshot-observations','screenshot-chunks','screenshot-releases','screenshot-downloads','download-arms','download-observations','download-chunks','download-releases','download-files'].includes(suffix)};}
 return null;
}
export function createAgentHttpAccess(executor,registry){
 if(executor===null)return null;if(!(executor instanceof DurableAgentExecutor)||!executor.usesRegistry(registry))throw TypeError('Agent executor must use the exact HTTP Registry');
 return Object.freeze(Object.fromEntries(['create','getRun','getInvocation','events','cancellation','context','observationContext','observe','observeAccessibility','screenshot','readScreenshot','releaseScreenshot','downloadScreenshot','armDownload','downloadInfo','readDownload','releaseDownload','downloadFile','perform','end','webhookEndpoints','subscribeWebhook','webhookSubscription'].map(name=>[name,executor[name].bind(executor)])));
}
function data(value,allowed,required=allowed){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new AgentExecutionError('AGENT_INVALID_REQUEST');
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);if(keys.length>allowed.length||keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value'))||required.some(k=>!Object.hasOwn(descriptors,k)))throw new AgentExecutionError('AGENT_INVALID_REQUEST');return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
}
function rpcOptions(input){if(!Object.hasOwn(input,'rpcTimeoutMs'))return undefined;const n=input.rpcTimeoutMs;if(!Number.isInteger(n)||n<50||n>120000)throw new AgentExecutionError('AGENT_INVALID_REQUEST');return {timeoutMs:n};}
function run(row){const {agentRunId,sessionId,region,version,state,holdsWriter,beginDispatch,endDispatch,createdAt,updatedAt,error}=row;return {agentRunId,sessionId,region,version,state,holdsWriter,beginDispatch,endDispatch,createdAt,updatedAt,error:error&&{code:error.code,outcome:error.outcome}};}
function invocation(row){const {invocationId,agentRunId,sessionId,tool,fence,state,dispatchStarted,receipt,error,createdAt,updatedAt}=row;return {invocationId,agentRunId,sessionId,tool,fence:{controlSessionId:fence.controlSessionId,controlVersion:fence.controlVersion,pageEpoch:fence.pageEpoch,viewportVersion:fence.viewportVersion},state,dispatchStarted,receipt:receipt&&{stage:receipt.stage,inputs:receipt.inputs},error:error&&{code:error.code,outcome:error.outcome},createdAt,updatedAt};}
function webhook(row){
 const cursor=n=>agentEventCursor(row.agentRunId,n);
 return {...row,after:cursor(row.after),acceptedThrough:cursor(row.acceptedThrough),queuedThrough:cursor(row.queuedThrough),observedLatest:cursor(row.observedLatest),missingFrom:row.missingFrom===null?null:cursor(row.missingFrom),missingThrough:row.missingThrough===null?null:cursor(row.missingThrough),head:row.head?{...row.head,cursor:cursor(row.head.sequence)}:null};
}
export async function handleAgentHttp({selected,principal,input,idempotencyKey,access,registry,wait,signal,screenshotSink,downloadSink}){
 if(!access)throw new AgentHttpError('AGENT_NOT_CONFIGURED');const tenantId=principal.tenantId,reference={tenantId,agentRunId:selected.id};let result,status=200,location;
 if(selected.kind==='agent-webhook-endpoints')result=access.webhookEndpoints(reference);
 else if(selected.kind==='agent-webhook-subscription')result=webhook(access.webhookSubscription({...reference,subscriptionId:selected.subscriptionId}));
 else if(selected.kind==='agent-webhook-subscribe'){
  const body=data(input,['endpointId','after']);access.webhookEndpoints(reference);const after=agentEventAfter(selected.id,body.after);result=webhook(access.subscribeWebhook({...reference,endpointId:body.endpointId,after}));location='/v1/agent-runs/'+selected.id+'/webhook-subscriptions/'+result.subscriptionId;
 }else if(selected.kind==='agent-create'){
  const body=data(input,['region','version','rpcTimeoutMs'],['region','version']),options=rpcOptions(body);registry.getSession(tenantId,selected.id);
  result=run(access.create({tenantId,sessionId:selected.id,region:body.region,version:body.version,idempotencyKey},options));status=['intent','starting','closing'].includes(result.state)?202:200;location='/v1/agent-runs/'+result.agentRunId;
 }else if(selected.kind==='agent-invocations'){
  const body=data(input,['tool','params','context','rpcTimeoutMs'],['tool','params','context']);result=invocation(access.perform({...reference,idempotencyKey,tool:body.tool,params:body.params,context:body.context},rpcOptions(body)));status=['intent','requested'].includes(result.state)?202:200;location='/v1/agent-invocations/'+result.invocationId;
 }else if(selected.kind==='agent-observation-context'){
  result=capturePublicObservationContext(await wait(access.observationContext(reference),signal),{tenantId,agentRunId:selected.id},'AGENT_INVALID_REPLY');
 }else if(selected.kind==='agent-observations'){
  const body=data(input,['context','query','limits','rpcTimeoutMs'],['context','query']);result=capturePublicObservation(await wait(access.observe({...reference,context:body.context,query:body.query,...(Object.hasOwn(body,'limits')?{limits:body.limits}:{})},rpcOptions(body)),signal),{tenantId,agentRunId:selected.id});
 }else if(selected.kind==='agent-accessibility-observations'){
  const body=data(input,['context','elementId','limits','rpcTimeoutMs'],['context','elementId']);result=capturePublicAccessibility(await wait(access.observeAccessibility({...reference,context:body.context,elementId:body.elementId,...(Object.hasOwn(body,'limits')?{limits:body.limits}:{})},rpcOptions(body)),signal),{tenantId,agentRunId:selected.id});
 }else if(['agent-screenshot-observations','agent-screenshot-chunks','agent-screenshot-releases'].includes(selected.kind)){
  const kind=selected.kind,capturing=kind==='agent-screenshot-observations',reading=kind==='agent-screenshot-chunks',allowed=capturing?['context','limits','rpcTimeoutMs']:reading?['context','screenshotId','offset','maxBytes','rpcTimeoutMs']:['context','screenshotId','rpcTimeoutMs'],body=data(input,allowed,allowed.filter(k=>!['limits','maxBytes','rpcTimeoutMs'].includes(k))),{rpcTimeoutMs,...request}=body,call=capturing?access.screenshot:reading?access.readScreenshot:access.releaseScreenshot,validate=capturing?capturePublicScreenshot:reading?capturePublicScreenshotChunk:capturePublicScreenshotReleased;result=validate(await wait(call({...reference,...request},rpcOptions(body)),signal),{tenantId,agentRunId:selected.id});
 }else if(selected.kind==='agent-screenshot-downloads'){
  const body=data(input,['context','screenshotId','sha256','byteLength','observedAt','rpcTimeoutMs'],['context','screenshotId','sha256','byteLength','observedAt']),{rpcTimeoutMs,...request}=body;await wait(access.downloadScreenshot({...reference,...request},screenshotSink,{...rpcOptions(body),signal}),signal);return {binary:true};
 }else if(['agent-download-arms','agent-download-observations','agent-download-chunks','agent-download-releases'].includes(selected.kind)){
  const kind=selected.kind,arming=kind==='agent-download-arms',reading=kind==='agent-download-chunks',allowed=arming?['context','limits','rpcTimeoutMs']:reading?['context','downloadId','offset','maxBytes','rpcTimeoutMs']:['context','downloadId','rpcTimeoutMs'],body=data(input,allowed,allowed.filter(k=>!['limits','maxBytes','rpcTimeoutMs'].includes(k))),{rpcTimeoutMs,...request}=body,call=arming?access.armDownload:reading?access.readDownload:kind==='agent-download-observations'?access.downloadInfo:access.releaseDownload,validate=arming?capturePublicDownloadArmed:reading?capturePublicDownloadChunk:kind==='agent-download-observations'?capturePublicDownloadInfo:capturePublicDownloadReleased;result=validate(await wait(call({...reference,...request},rpcOptions(body)),signal),{tenantId,agentRunId:selected.id});
 }else if(selected.kind==='agent-download-files'){
  const body=data(input,['context','downloadId','sha256','byteLength','completedAt','rpcTimeoutMs'],['context','downloadId','sha256','byteLength','completedAt']),{rpcTimeoutMs,...request}=body;await wait(access.downloadFile({...reference,...request},downloadSink,{...rpcOptions(body),signal}),signal);return {binary:true};
 }else if(selected.kind==='agent-cancellation')result=access.cancellation({...reference,...(selected.cancellationCursor?{after:selected.cancellationCursor}:{})});
 else if(selected.kind==='agent-cancel'){access.end(reference);result=access.cancellation(reference);status=['pending','settling'].includes(result.status)?202:200;location='/v1/agent-runs/'+selected.id+'/cancellation';}
 else if(selected.kind==='agent-run')result=run(access.getRun(reference));
 else if(selected.kind==='agent-invocation')result=invocation(access.getInvocation({tenantId,invocationId:selected.id}));
 else if(selected.kind==='agent-context'){
  // The HTTP caller observes this bounded read. Disconnect/deadline must not
  // cancel the private RPC and turn read-only authority into a writer reset.
  result=captureAgentContext(await wait(access.context(reference),signal));
 }else if(selected.kind==='agent-end'){result=run(access.end(reference));status=['intent','starting','closing'].includes(result.state)?202:200;location='/v1/agent-runs/'+result.agentRunId;}
 else throw new AgentExecutionError('AGENT_INVALID_REQUEST');
 return {data:result,status,location};
}
