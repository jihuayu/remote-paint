import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAgentEventBody,AGENT_EVENT_MAX_BYTES} from '../service/agent-event-schema.mjs';
const uuid='00000000-0000-4000-8000-000000000001',at='2026-10-21T07:00:00.000Z';
const run=()=>({schema:'agent-event-v1',eventId:'aevt_'+uuid,agentRunId:'arun_'+uuid,sessionId:'ses_'+uuid,region:'test',version:'v1',sequence:1,observedAt:at,type:'run.updated',data:{state:'active',holdsWriter:true,beginDispatch:'confirmed',endDispatch:'not-requested',error:null,closeEvidenceKind:null,stateUpdatedAt:at}});
const invocation=()=>({...run(),type:'invocation.updated',data:{invocationId:'ainv_'+uuid,tool:'insertText',state:'injected',dispatchStarted:true,receipt:{stage:'input-injected',inputs:1},error:null,stateUpdatedAt:at}});
const parse=e=>parseAgentEventBody(JSON.stringify(e));
const rejects=mutate=>{const e=run();mutate(e);assert.throws(()=>parse(e),TypeError);};

test('shared projection parser accepts run/invocation metadata and explicit snapshot types without a Source database',()=>{
 for(const source of [run(),invocation()])for(const suffix of ['updated','snapshot']){const e={...source,type:source.type.split('.')[0]+'.'+suffix};assert.deepEqual(parse(e),e);}
});
test('projection rejects all private control fields including nested action and receipt evidence',()=>{
 for(const field of ['tenant','binding','controlSessionId','action','url','token','text','fence'])rejects(e=>{e[field]='private';});
 for(const field of ['action','binding','closeEvidence','text'])rejects(e=>{e.data[field]='private';});
 const e=invocation();e.data.receipt.evidenceSha256='0'.repeat(64);assert.throws(()=>parse(e),TypeError);
});
test('projection rejects malformed identities unsafe sequence and noncanonical dates',()=>{
 for(const [key,values] of Object.entries({eventId:['private','aevt_x'],agentRunId:['arun_x',1],sessionId:['',':private','x'.repeat(129)],region:['','x'.repeat(65)],version:['','x'.repeat(257)],sequence:[0,-1,1.5,Number.MAX_SAFE_INTEGER+1],observedAt:['yesterday','2026-10-21T07:00:00Z']}))for(const value of values)rejects(e=>{e[key]=value;});
});
test('projection distinguishes malformed JSON structure and enforces actual UTF8 body bytes',()=>{
 for(const value of [null,{},[],42,'',JSON.stringify(null),'{','{}'])assert.throws(()=>parseAgentEventBody(value),TypeError);
 const e=run();e.region='雪'.repeat(64);e.version='界'.repeat(256);assert.deepEqual(parse(e),e);
 const text=JSON.stringify(e);assert.equal(AGENT_EVENT_MAX_BYTES,3072);assert.throws(()=>parseAgentEventBody(text+' '.repeat(3073-Buffer.byteLength(text))),TypeError);
});
test('projection cannot turn a held or uncertain run into a closed or confirmed outcome',()=>{
 for(const mutate of [e=>e.data.holdsWriter=false,e=>e.data.state='closed',e=>e.data.closeEvidenceKind='worker-run-closed',e=>e.data.endDispatch='confirmed',e=>e.data.error={code:'FAILED',outcome:'not-dispatched'},e=>e.data.state='starting'])rejects(mutate);
 const e=run();Object.assign(e.data,{state:'recovery-required',error:{code:'RPC_TIMEOUT',outcome:'unknown'}});assert.deepEqual(parse(e),e);
});
test('projection validates all closure evidence kinds without asserting underlying evidence authenticity',()=>{
 for(const [kind,begin,end,error] of [['never-dispatched','not-requested','not-requested',null],['begin-rejected','requested','not-requested',{code:'REJECTED',outcome:'not-dispatched'}],['worker-run-closed','confirmed','confirmed',null],['session-terminal','confirmed','not-requested',null]]){
  const e=run();Object.assign(e.data,{state:'closed',holdsWriter:false,beginDispatch:begin,endDispatch:end,error,closeEvidenceKind:kind});assert.deepEqual(parse(e),e);
  e.data.holdsWriter=true;assert.throws(()=>parse(e),TypeError);
 }
});
test('projection requires injection receipt to match state and dispatch with bounded metadata',()=>{
 for(const mutate of [e=>e.data.dispatchStarted=false,e=>e.data.receipt.inputs=33,e=>e.data.receipt.stage='business-success',e=>e.data.receipt=null,e=>e.data.state='unknown',e=>e.data.tool='execute',e=>e.data.invocationId='ainv_x']){const e=invocation();mutate(e);assert.throws(()=>parse(e),TypeError);}
 for(const [state,dispatched,error] of [['intent',false,null],['requested',true,null],['rejected',false,{code:'REJECTED',outcome:'not-dispatched'}],['unknown',true,{code:'RPC_TIMEOUT',outcome:'unknown'}]]){const e=invocation();Object.assign(e.data,{state,dispatchStarted:dispatched,receipt:null,error});assert.deepEqual(parse(e),e);}
});
test('projection parsing returns detached data and does not invoke caller hooks',()=>{
 let calls=0;assert.throws(()=>parseAgentEventBody({toString(){calls++;return JSON.stringify(run());},toJSON(){calls++;return run();}}),TypeError);assert.equal(calls,0);
 const e=run(),v=parse(e);v.data.state='private';assert.equal(e.data.state,'active');
});
