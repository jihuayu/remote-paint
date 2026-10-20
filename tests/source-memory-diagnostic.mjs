// Test-observer evidence only. These helpers never turn an incomplete native
// sample into an accepted sample or retry/read a replacement cohort.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join} from 'node:path';
export const SOURCE_MEMORY_DIAGNOSTIC_LIMITS=Object.freeze({metricBytes:2097152,envelopeBytes:2101248,records:8});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:'UNCLASSIFIED';
const context=value=>({sessionId:typeof value?.sessionId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)?value.sessionId:null,number:Number.isSafeInteger(value?.number)?value.number:null,phase:['startup','update','resize','navigation','closing'].includes(value?.phase)?value.phase:null});
function attach(error,value){Object.defineProperty(error,'sourceMemoryDiagnostic',{value,enumerable:false,configurable:true});return error;}
export function captureSourceMemoryFailure(error,metrics,where={},gate='sampler-exception'){
 let text,captureStatus='complete';try{text=JSON.stringify(metrics);if(text===undefined)captureStatus='not-serializable';}catch{captureStatus='not-serializable';}
 const metricBytes=text===undefined?null:Buffer.byteLength(text);if(metricBytes>SOURCE_MEMORY_DIAGNOSTIC_LIMITS.metricBytes)captureStatus='oversized';
 const diagnostic={schema:'source-memory-failure-v1',id:randomUUID(),at:new Date().toISOString(),gate,context:context(where),captureStatus,metricBytes,metricsSha256:captureStatus==='complete'?hash(text):null,metrics:captureStatus==='complete'?JSON.parse(text):null,samplerError:{name:typeof error?.name==='string'&&/^[A-Za-z]{1,64}$/.test(error.name)?error.name:'Error',code:code(error?.code),...(typeof error?.field==='string'&&/^[A-Za-z_]{1,64}$/.test(error.field)?{field:error.field}:{})}};
 attach(error,Object.freeze(diagnostic));return error;
}
export function assertSessionSourceMemory(metrics,where={}){
 let gate='process-sampling';try{assert.equal(metrics.processSampling.status,'observed-stable');gate='pss-complete';assert.equal(metrics.pss.completeObservedCohort,true);gate='cgroup-membership';assert.equal(metrics.cgroup.provenance.processMembershipConfirmed,true);return metrics;}
 catch(error){throw captureSourceMemoryFailure(error,metrics,where,gate);}
}
function valid(value){
 if(!value||value.schema!=='source-memory-failure-v1'||typeof value.id!=='string'||!/^[a-f0-9-]{36}$/.test(value.id)||!['process-sampling','pss-complete','cgroup-membership','sampler-exception'].includes(value.gate)||!['complete','not-serializable','oversized'].includes(value.captureStatus))return false;
 let text;try{if(Buffer.byteLength(JSON.stringify(value))>SOURCE_MEMORY_DIAGNOSTIC_LIMITS.envelopeBytes)return false;text=JSON.stringify(value.metrics);}catch{return false;}
 return value.captureStatus==='complete'?Buffer.byteLength(text)===value.metricBytes&&value.metricBytes<=SOURCE_MEMORY_DIAGNOSTIC_LIMITS.metricBytes&&hash(text)===value.metricsSha256:value.metrics===null&&value.metricsSha256===null;
}
export function sourceMemoryFailurePayload(error){const value=error?.sourceMemoryDiagnostic;return valid(value)?structuredClone(value):null;}
export function sourceMemoryErrorReply(error,id){const diagnostic=sourceMemoryFailurePayload(error);return {id,error:typeof error?.stack==='string'?error.stack:String(error),...(diagnostic?{sourceMemoryDiagnostic:diagnostic}:{})};}
export function reviveSourceMemoryError(reply){const error=new Error(reply.error);if(reply.sourceMemoryDiagnostic){if(!valid(reply.sourceMemoryDiagnostic)){error.sourceMemoryDiagnosticRejected=true;return error;}attach(error,Object.freeze(structuredClone(reply.sourceMemoryDiagnostic)));}return error;}
export class SourceMemoryFailureLog {
 #directory;#runId;#count=0;#seen=new Map();#tail=Promise.resolve();
 constructor({directory,runId}={}){if(typeof directory!=='string'||!isAbsolute(directory)||typeof runId!=='string'||!/^[a-f0-9-]{36}$/.test(runId))throw new TypeError('Configure an owned private diagnostic directory and run ID');this.#directory=directory;this.#runId=runId;}
 record(error,request=null){
  const diagnostic=sourceMemoryFailurePayload(error);if(!diagnostic)return Promise.resolve({status:'absent'});if(this.#seen.has(diagnostic.id))return this.#seen.get(diagnostic.id);if(this.#count>=SOURCE_MEMORY_DIAGNOSTIC_LIMITS.records)return Promise.resolve({status:'limit',id:diagnostic.id});const ordinal=++this.#count;
  const work=this.#tail.then(async()=>{const record={at:new Date().toISOString(),runId:this.#runId,ordinal,request:request&&typeof request.id==='string'&&/^[a-f0-9-]{36}$/.test(request.id)&&typeof request.op==='string'&&/^[a-z-]{1,64}$/.test(request.op)?{id:request.id,op:request.op}:null,diagnostic},line=JSON.stringify(record)+'\n';let file,dir;
   try{file=await open(join(this.#directory,'source-memory-failures.jsonl'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size+Buffer.byteLength(line)>SOURCE_MEMORY_DIAGNOSTIC_LIMITS.records*(SOURCE_MEMORY_DIAGNOSTIC_LIMITS.envelopeBytes+1024))throw Object.assign(Error('Invalid diagnostic file'),{code:'SOURCE_DIAGNOSTIC_FILE'});await file.writeFile(line);await file.sync();dir=await open(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await dir.sync();return {status:'saved',id:diagnostic.id,ordinal,sha256:hash(line),bytes:Buffer.byteLength(line)};}
   catch(e){return {status:'failed',id:diagnostic.id,code:code(e?.code)};}
   finally{await file?.close().catch(()=>{});await dir?.close().catch(()=>{});}
  });this.#seen.set(diagnostic.id,work);this.#tail=work.catch(()=>{});return work;
 }
}
