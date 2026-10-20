import {captureAgentAccessibilityResult} from '../live/agent-accessibility.mjs';
import {AgentRpcError} from './agent-rpc.mjs';
import {captureAgentObservationContext,captureAgentObservationResult} from '../live/agent-observation.mjs';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_'+uuid+'$').test(v);
const fail=(code,outcome=code==='AGENT_INVALID_REPLY'?'unknown':'not-dispatched')=>{throw new AgentRpcError(code,outcome);};
function data(value,fields,code){
 try{if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);if(keys.length!==fields.length||keys.some(k=>!fields.includes(k)||!Object.hasOwn(descriptors[k],'value')))fail(code);return Object.fromEntries(fields.map(k=>[k,descriptors[k].value]));}catch{fail(code);}
}
export function observationRunExpectation(row){return Object.freeze({agentRunId:row.agentRunId,sessionId:row.sessionId,version:row.version,tenantId:row.tenant,targetId:row.binding?.targetId,workerRunId:row.binding?.workerRunId,controlSessionId:row.binding?.controlSessionId});}
function matches(value,expected,code){
 const actual={agentRunId:value.agentRunId,sessionId:value.sessionId,version:value.version,tenantId:value.binding.tenantId,targetId:value.binding.targetId,workerRunId:value.binding.runId,controlSessionId:value.document.controlSessionId};if(Object.keys(actual).some(k=>expected[k]!==undefined&&actual[k]!==expected[k]))fail(code,code==='AGENT_INVALID_REPLY'?'unknown':'not-dispatched');
}
export function capturePublicObservationContext(value,expected={},code='AGENT_INVALID_CONTEXT'){
 const v=data(value,['agentRunId','sessionId','version','binding','document'],code);if(!id(v.agentRunId,'arun')||!id(v.sessionId,'ses')||typeof v.version!=='string'||!v.version.length||v.version.length>256)fail(code);
 let source;try{source=captureAgentObservationContext({binding:v.binding,document:v.document});}catch{fail(code);}if(source.binding.sessionId!==v.sessionId)fail(code);const result=Object.freeze({...v,...source});matches(result,expected,code);return result;
}
export function publicObservationContext(row,value){return capturePublicObservationContext({agentRunId:row.agentRunId,sessionId:row.sessionId,version:row.version,...value},observationRunExpectation(row),'AGENT_INVALID_REPLY');}
export function sourceObservationContext(value,row){const v=capturePublicObservationContext(value,observationRunExpectation(row));return Object.freeze({binding:v.binding,document:v.document});}
export function capturePublicObservation(value,expected={}){
 const fields=['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','query','limits','url','title','nodes','visited','truncated'],v=data(value,fields,'AGENT_INVALID_REPLY'),{agentRunId,sessionId,...source}=v;if(!id(agentRunId,'arun')||!id(sessionId,'ses'))fail('AGENT_INVALID_REPLY','unknown');let captured;try{captured=captureAgentObservationResult(source);}catch{fail('AGENT_INVALID_REPLY','unknown');}if(captured.binding.sessionId!==sessionId)fail('AGENT_INVALID_REPLY','unknown');const result=Object.freeze({agentRunId,sessionId,...captured});matches(result,expected,'AGENT_INVALID_REPLY');if(Buffer.byteLength(JSON.stringify(result))>8192)fail('AGENT_OBSERVATION_LIMIT','unknown');return result;
}
export function publicObservation(row,value){return capturePublicObservation({agentRunId:row.agentRunId,sessionId:row.sessionId,...value},observationRunExpectation(row));}

export function capturePublicAccessibility(value,expected={}){
 const fields=['agentRunId','sessionId','stage','binding','document','observationId','revision','observedAt','version','scope','elementId','limits','url','title','ax','redacted','truncated'],v=data(value,fields,'AGENT_INVALID_REPLY'),{agentRunId,sessionId,...source}=v;if(!id(agentRunId,'arun')||!id(sessionId,'ses'))fail('AGENT_INVALID_REPLY','unknown');let captured;try{captured=captureAgentAccessibilityResult(source);}catch{fail('AGENT_INVALID_REPLY','unknown');}if(captured.binding.sessionId!==sessionId)fail('AGENT_INVALID_REPLY','unknown');const result=Object.freeze({agentRunId,sessionId,...captured});matches(result,expected,'AGENT_INVALID_REPLY');if(Buffer.byteLength(JSON.stringify(result))>8192)fail('AGENT_OBSERVATION_LIMIT','unknown');return result;
}
export function publicAccessibility(row,value){return capturePublicAccessibility({agentRunId:row.agentRunId,sessionId:row.sessionId,...value},observationRunExpectation(row));}
