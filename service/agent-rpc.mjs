import {captureManagedAgentScreenshot,captureManagedAgentScreenshotRead,captureManagedAgentScreenshotId,captureAgentScreenshotResult,captureAgentScreenshotChunk,captureAgentScreenshotReleased} from '../live/agent-screenshot.mjs';
import {captureManagedAgentAccessibility,captureAgentAccessibilityResult} from '../live/agent-accessibility.mjs';
import {captureManagedAgentObservation,captureAgentObservationResult,captureAgentObservationContext} from '../live/agent-observation.mjs';
import {InputError,AgentInputError,captureAgentFence} from '../live/input.mjs';
import {captureManagedAgentAction} from '../live/managed-agent-run.mjs';
const codes=new Set(['AGENT_UNAVAILABLE','AGENT_RUN_NOT_FOUND','AGENT_RPC_BUSY','AGENT_RPC_TIMEOUT','AGENT_RPC_CANCELLED','AGENT_RPC_LIMIT','AGENT_INVALID_REPLY']);
export class AgentRpcError extends Error {
 constructor(code,outcome='unknown'){super('Agent operation is unavailable');this.name='AgentRpcError';this.code=codes.has(code)||new AgentInputError(code).code===code?code:'AGENT_INPUT_FAILED';this.outcome=outcome==='not-dispatched'?'not-dispatched':'unknown';}
}
const fail=code=>{throw new AgentRpcError(code,'not-dispatched');};
function data(value,fields){
 try{if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('AGENT_INVALID_REQUEST');const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);if(keys.length!==fields.length||keys.some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(descriptors,k)||!Object.hasOwn(descriptors[k],'value')))fail('AGENT_INVALID_REQUEST');return Object.fromEntries(fields.map(k=>[k,descriptors[k].value]));}catch{fail('AGENT_INVALID_REQUEST');}
}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(value,prefix)=>typeof value==='string'&&new RegExp('^'+prefix+'_'+uuid+'$').test(value);
function binding(value){const result=data(value,['tenantId','sessionId','targetId','runId']);if(typeof result.tenantId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.tenantId)||!id(result.sessionId,'ses')||!id(result.targetId,'target')||!id(result.runId,'run'))fail('AGENT_INVALID_REQUEST');return Object.freeze(result);}
export function captureAgentContext(value){const result=data(value,['binding','fence']);return Object.freeze({binding:binding(result.binding),fence:captureAgentFence(result.fence)});}
export function captureAgentRequest(value){
 // Read only the own data descriptor to select a schema, never a caller getter.
 let descriptor;try{descriptor=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'op'):null;}catch{fail('AGENT_INVALID_REQUEST');}const op=descriptor&&Object.hasOwn(descriptor,'value')?descriptor.value:null;
 if(op==='begin'){data(value,['op']);return Object.freeze({op});}
 if(op==='context'&&!Object.hasOwn(value,'runId')){data(value,['op']);return Object.freeze({op});}
 if(op==='context'||op==='end'||op==='observation-context'){const v=data(value,['op','runId']);if(!id(v.runId,'run'))fail('AGENT_INVALID_REQUEST');return Object.freeze(v);}
 if(op==='observe'){try{const v=data(value,['op','runId','context','query','limits']);if(!id(v.runId,'run'))fail('AGENT_INVALID_REQUEST');const context=captureAgentObservationContext(v.context);if(context.binding.runId!==v.runId)fail('AGENT_INVALID_CONTEXT');const observation=captureManagedAgentObservation(v.query,v.limits);return Object.freeze({op,runId:v.runId,context,...observation});}catch(error){throw agentFailure(error,'not-dispatched');}}
 if(op==='observe-ax'){try{const v=data(value,['op','runId','context','elementId','limits']);if(!id(v.runId,'run'))fail('AGENT_INVALID_REQUEST');const context=captureAgentObservationContext(v.context);if(context.binding.runId!==v.runId)fail('AGENT_INVALID_CONTEXT');const accessibility=captureManagedAgentAccessibility(v.elementId,v.limits);return Object.freeze({op,runId:v.runId,context,...accessibility});}catch(error){throw agentFailure(error,'not-dispatched');}}
 if(op==='observe-screenshot'||op==='read-screenshot'||op==='release-screenshot'){try{const fields=op==='observe-screenshot'?['op','runId','context','limits']:op==='read-screenshot'?['op','runId','context','screenshotId','offset','maxBytes']:['op','runId','context','screenshotId'],v=data(value,fields);if(!id(v.runId,'run'))fail('AGENT_INVALID_REQUEST');const context=captureAgentObservationContext(v.context);if(context.binding.runId!==v.runId)fail('AGENT_INVALID_CONTEXT');const request=op==='observe-screenshot'?captureManagedAgentScreenshot(v.limits):op==='read-screenshot'?captureManagedAgentScreenshotRead(v.screenshotId,v.offset,v.maxBytes):{screenshotId:captureManagedAgentScreenshotId(v.screenshotId)};return Object.freeze({op,runId:v.runId,context,...request});}catch(error){throw agentFailure(error,'not-dispatched');}}
 if(op==='perform'){const v=data(value,['op','runId','tool','params','context']);if(!id(v.runId,'run'))fail('AGENT_INVALID_REQUEST');const context=captureAgentContext(v.context);if(context.binding.runId!==v.runId)fail('AGENT_INVALID_CONTEXT');const action=captureManagedAgentAction(v.tool,v.params);return Object.freeze({op,runId:v.runId,tool:action.tool,params:action.params,context});}
 fail('AGENT_INVALID_REQUEST');
}
export function agentReplyExpectation(request){return Object.freeze({op:request.op,runId:request.runId??null,binding:request.context?.binding??null,fence:request.context?.fence??null,...(request.op==='observe'?{document:request.context.document,observation:{query:request.query,limits:request.limits}}:request.op==='observe-ax'?{document:request.context.document,accessibility:{elementId:request.elementId,limits:request.limits}}:request.op==='observe-screenshot'?{document:request.context.document,screenshot:{limits:request.limits}}:request.op==='read-screenshot'?{document:request.context.document,screenshotRead:{screenshotId:request.screenshotId,offset:request.offset,maxBytes:request.maxBytes}}:request.op==='release-screenshot'?{document:request.context.document,screenshotId:request.screenshotId}:{})});}
export function captureAgentResult(value,expected,{sessionId,tenantId,version}={}){
 let result;
 if(expected.op==='observation-context')result=captureAgentObservationContext(value);
 else if(expected.op==='observe')result=captureAgentObservationResult(value,expected);
 else if(expected.op==='observe-ax')result=captureAgentAccessibilityResult(value,expected);
 else if(expected.op==='observe-screenshot')result=captureAgentScreenshotResult(value,expected);
 else if(expected.op==='read-screenshot')result=captureAgentScreenshotChunk(value,expected);
 else if(expected.op==='release-screenshot')result=captureAgentScreenshotReleased(value,expected);
 else if(expected.op==='begin'||expected.op==='context')result=captureAgentContext(value);
 else if(expected.op==='end'){const v=data(value,['stage','binding']);if(v.stage!=='run-closed')fail('AGENT_INVALID_REPLY');result=Object.freeze({stage:v.stage,binding:binding(v.binding)});}
 else if(expected.op==='perform'){const v=data(value,['stage','binding','fence','inputs']);if(v.stage!=='input-injected'||!Number.isInteger(v.inputs)||v.inputs<1||v.inputs>32)fail('AGENT_INVALID_REPLY');result=Object.freeze({stage:v.stage,binding:binding(v.binding),fence:captureAgentFence(v.fence),inputs:v.inputs});}
 else fail('AGENT_INVALID_REPLY');
 if(version!==undefined&&['observe','observe-ax','observe-screenshot','read-screenshot','release-screenshot'].includes(expected.op)&&result.version!==version)fail('AGENT_INVALID_REPLY');
 if(sessionId!==undefined&&result.binding.sessionId!==sessionId||tenantId!==undefined&&result.binding.tenantId!==tenantId||expected.runId!==null&&result.binding.runId!==expected.runId||expected.binding&&Object.keys(expected.binding).some(k=>result.binding[k]!==expected.binding[k])||expected.op!=='observe'&&expected.fence&&Object.keys(expected.fence).some(k=>result.fence?.[k]!==expected.fence[k]))fail('AGENT_INVALID_REPLY');
 return result;
}
export function captureAgentFailure(value){const v=data(value,['code','outcome']),error=new AgentRpcError(v.code,v.outcome);if(error.code!==v.code||!['not-dispatched','unknown'].includes(v.outcome))fail('AGENT_INVALID_REPLY');return error;}
export function agentFailure(error,outcome='unknown'){return error instanceof AgentRpcError||error instanceof AgentInputError?new AgentRpcError(error.code,error.outcome):error instanceof InputError?new AgentRpcError(error.code,outcome):new AgentRpcError('AGENT_INPUT_FAILED',outcome);}
