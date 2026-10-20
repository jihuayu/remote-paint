import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runSessionWorker} from '../service/session-worker.mjs';
import {SessionWorkerChannel} from '../service/session-worker-channel.mjs';
import {captureAgentRequest,agentReplyExpectation,captureAgentResult} from '../service/agent-rpc.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {httpObservationFixture,paths} from './fixtures/public-observation-fixture.mjs';
import {uuid} from './fixtures/agent-observation-fixture.mjs';
const sessionId='ses_'+uuid(1),key='a'.repeat(64),binding={tenantId:'tenant',sessionId,targetId:'target_'+uuid(2),runId:'run_'+uuid(3)},document={controlSessionId:uuid(4),pageEpoch:1,viewportVersion:1},context={binding,document},elementId='elh_'+uuid(6),command={op:'observe-ax',runId:binding.runId,context,elementId,limits:{}},start={url:'about:blank',region:'test',ttlSeconds:60};
const result=patch=>({stage:'accessibility-observed',...context,observationId:'obs_'+uuid(5),revision:1,observedAt:'2026-10-20T00:00:00.000Z',version:'fixture',scope:'main-document-element-accessibility',elementId,limits:{maxChars:256},url:'https://fixture.test/',title:'Fixture',ax:{ignored:false,role:'button',name:'Browser computed',description:'',value:null,states:{disabled:false}},redacted:false,truncated:false,...patch});
const defer=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
function pair(t,{ax=true,reply=null,maxFrameBytes=8192}={}){const input=new PassThrough(),output=new PassThrough(),owner=new EventEmitter(),exit=defer(),held=defer();void held.promise.catch(()=>{});const calls=[],resource={agentObservationVersion:1,agentAccessibilityVersion:ax?1:0,initialize:async()=>({version:'fixture'}),agent(request){calls.push(request);if(request.op==='end')return {stage:'run-closed',binding};if(request.op==='observation-context')return context;return reply?reply(request,held):result();},close:async()=>{held.reject(Error('closed'));return {status:'closed'};}};const channel=new SessionWorkerChannel({sessionId,tenantId:'tenant',region:'test',ownerKey:key,input,output,clientDone:exit.promise,maxFrameBytes,helloTimeoutMs:1000,readyTimeoutMs:1000,closeTimeoutMs:200,heartbeatMs:20}),worker=runSessionWorker({identity:{sessionId,tenantId:'tenant',region:'test',ownerKeyHash:createHash('sha256').update(key).digest('hex')},input,output,owner,createResource:()=>resource,startTimeoutMs:1000,ownerLeaseMs:1000,closeTimeoutMs:100});void worker.done.then(value=>{output.end();exit.resolve({code:value.exitCode,signal:null});});t.after(async()=>{held.reject(Error('cleanup'));await channel.close();await worker.done;input.destroy();output.destroy();});return {channel,worker,calls,held};}
test('computed AX requires an independent worker capability and 8KiB channel before dispatch',async t=>{
 for(const options of [{ax:false},{maxFrameBytes:2048}]){const h=pair(t,options);await h.channel.start(start);await assert.rejects(h.channel.agent(command),{code:'AGENT_OBSERVATION_UNAVAILABLE',outcome:'not-dispatched'});assert.equal(h.calls.length,0);if(options.maxFrameBytes===2048)await assert.rejects(h.channel.agent({op:'observation-context',runId:binding.runId}),{code:'AGENT_OBSERVATION_UNAVAILABLE'});else assert.equal((await h.channel.agent({op:'observation-context',runId:binding.runId})).document.pageEpoch,1);}
});
test('computed AX private RPC carries exact DOM handle/document/version and immutable sanitized result',async t=>{
 const h=pair(t);await h.channel.start(start);const r=await h.channel.agent(command);assert.equal(r.elementId,elementId);assert.equal(r.ax.name,'Browser computed');assert.equal(r.document.controlVersion,undefined);assert.ok(Object.isFrozen(r.ax.states));assert.equal(h.calls[0].limits.maxChars,256);assert.equal(h.channel.status().available,true);
});
test('computed AX timeout retains actual private ordinary slot while independently admitted end stays available',async t=>{
 const h=pair(t,{reply:(_request,held)=>held.promise});await h.channel.start(start);await assert.rejects(h.channel.agent(command,{timeoutMs:50}),{code:'AGENT_RPC_TIMEOUT',outcome:'unknown'});assert.equal(h.channel.agentStatus().active,true);await assert.rejects(h.channel.agent(command),{code:'AGENT_RPC_BUSY'});assert.equal((await h.channel.agent({op:'end',runId:binding.runId})).stage,'run-closed');h.held.resolve(result());for(let n=0;n<100&&h.channel.agentStatus().active;n++)await new Promise(r=>setTimeout(r,2));assert.equal(h.channel.agentStatus().active,false);assert.equal(h.calls.filter(c=>c.op==='observe-ax').length,1);
});
test('computed AX wrong version/target/document/redaction cannot pass worker-channel response correlation',async t=>{
 for(const patch of [{version:'wrong'},{binding:{...binding,targetId:'target_'+uuid(99)}},{document:{...document,pageEpoch:2}},{redacted:true},{rawCDP:'private'}]){const h=pair(t,{reply:()=>result(patch)});await h.channel.start(start);await assert.rejects(h.channel.agent(command));await h.worker.done;assert.equal(h.channel.status().available,false);}
});
test('computed AX private capture refuses caller object IDs, write fences, selectors, getters and wrong identity',()=>{
 const captured=captureAgentRequest(command);assert.equal(captured.limits.maxChars,256);const expected=agentReplyExpectation(captured);assert.equal(captureAgentResult(result(),expected,{version:'fixture'}).stage,'accessibility-observed');assert.throws(()=>captureAgentResult(result(),expected,{version:'wrong'}));for(const patch of [{objectId:'remote'},{elementId:'button#id'},{context:{binding,fence:{...document,controlVersion:0}}},{runId:'run_'+uuid(99)},{limits:{maxChars:513}}])assert.throws(()=>captureAgentRequest({...command,...patch}));let reads=0;assert.throws(()=>captureAgentRequest(Object.defineProperty({...command},'elementId',{get(){reads++;}})));assert.equal(reads,0);
});
test('private computed AX adds no implicit public observation query or unimplemented SDK path',{skip:!sessionStoreSupported},async t=>{
 const h=await httpObservationFixture(t),{run}=await h.active(),ctx=(await h.api('observe','GET',paths.context(run.agentRunId))).body.data,before=h.calls.length,r=await h.api('observe','POST',paths.observations(run.agentRunId),{data:{context:ctx,query:{kind:'accessibility',elementId}}});assert.equal(r.status,400);assert.equal(r.body.error.code,'INVALID_AGENT_OBSERVATION');assert.equal(h.calls.length,before);
});
