import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runSessionWorker} from '../service/session-worker.mjs';
import {SessionWorkerChannel} from '../service/session-worker-channel.mjs';
import {captureAgentRequest,agentReplyExpectation,captureAgentResult} from '../service/agent-rpc.mjs';
import {row,uuid} from './fixtures/agent-observation-fixture.mjs';
const sessionId='ses_'+uuid(1),key='a'.repeat(64),binding={tenantId:'tenant',sessionId,targetId:'target_'+uuid(2),runId:'run_'+uuid(3)},document={controlSessionId:uuid(4),pageEpoch:1,viewportVersion:1},context={binding,document},command={op:'observe',runId:binding.runId,context,query:{kind:'snapshot'},limits:{}},start={url:'about:blank',region:'test',ttlSeconds:60};
const result=patch=>({stage:'observed',...context,observationId:'obs_'+uuid(5),revision:1,observedAt:'2026-10-20T00:00:00.000Z',version:'fixture',scope:'main-document-light-dom',query:{kind:'snapshot'},limits:{maxNodes:8,maxChars:1024,maxVisited:128},url:'https://fixture.test/',title:'Fixture',nodes:[row()],visited:1,truncated:false,...patch});
const defer=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
function pair(t,{observe=true,reply=null,maxFrameBytes=8192}={}){
 const input=new PassThrough(),output=new PassThrough(),owner=new EventEmitter(),exit=defer(),held=defer();void held.promise.catch(()=>{});const calls=[],resource={agentObservationVersion:observe?1:0,initialize:async()=>({version:'fixture'}),agent(value){calls.push(value);if(value.op==='end')return {stage:'run-closed',binding};if(value.op==='observation-context')return context;return reply?reply(value,held):result();},close:async()=>{held.reject(Error('closed'));return {status:'closed'};}};
 const channel=new SessionWorkerChannel({sessionId,tenantId:'tenant',region:'test',ownerKey:key,input,output,clientDone:exit.promise,maxFrameBytes,helloTimeoutMs:1000,readyTimeoutMs:1000,closeTimeoutMs:200,heartbeatMs:20}),worker=runSessionWorker({identity:{sessionId,tenantId:'tenant',region:'test',ownerKeyHash:createHash('sha256').update(key).digest('hex')},input,output,owner,createResource:()=>resource,startTimeoutMs:1000,ownerLeaseMs:1000,closeTimeoutMs:100});void worker.done.then(value=>{output.end();exit.resolve({code:value.exitCode,signal:null});});t.after(async()=>{held.reject(Error('cleanup'));await channel.close();await worker.done;input.destroy();output.destroy();});return {channel,worker,calls,held};
}
test('old Agent-only worker rejects observation capability before sending a request',async t=>{
 const h=pair(t,{observe:false});await h.channel.start(start);await assert.rejects(h.channel.agent(command),{code:'AGENT_OBSERVATION_UNAVAILABLE',outcome:'not-dispatched'});assert.equal(h.calls.length,0);
});
test('advertised observation capability routes independent read context and exact bounded response over real byte channel',async t=>{
 const h=pair(t);await h.channel.start(start);const ctx=await h.channel.agent({op:'observation-context',runId:binding.runId});assert.equal(ctx.document.controlVersion,undefined);const response=await h.channel.agent(command);assert.equal(response.binding.targetId,binding.targetId);assert.equal(response.nodes[0].text,'Submit');assert.ok(Object.isFrozen(response.nodes[0]));assert.ok(Buffer.byteLength(JSON.stringify(response))<6144);assert.equal(h.calls.length,2);
});
test('observation timeout keeps actual ordinary slot and priority end remains separately admitted',async t=>{
 const h=pair(t,{reply:(_value,held)=>held.promise});await h.channel.start(start);await assert.rejects(h.channel.agent(command,{timeoutMs:50}),{code:'AGENT_RPC_TIMEOUT',outcome:'unknown'});assert.equal(h.channel.agentStatus().active,true);await assert.rejects(h.channel.agent(command),{code:'AGENT_RPC_BUSY'});assert.equal((await h.channel.agent({op:'end',runId:binding.runId})).stage,'run-closed');h.held.resolve(result());for(let n=0;n<100&&h.channel.agentStatus().active;n++)await new Promise(r=>setTimeout(r,2));assert.equal(h.channel.agentStatus().active,false);assert.equal(h.calls.filter(c=>c.op==='observe').length,1);
});
test('wrong document or foreign target observation result cannot pass worker/channel correlation',async t=>{
 for(const patch of [{document:{...document,pageEpoch:2}},{binding:{...binding,targetId:'target_'+uuid(99)}},{rawCdpObject:'private'}]){const h=pair(t,{reply:()=>result(patch)});await h.channel.start(start);await assert.rejects(h.channel.agent(command));await h.worker.done;assert.equal(h.channel.status().available,false);}
});
test('request capture fixes read context/query/limits and rejects arbitrary scripts or write-fence substitution',()=>{
 const request=captureAgentRequest(command);assert.equal(request.limits.maxVisited,128);assert.equal(request.context.document.controlVersion,undefined);assert.equal(captureAgentResult(result(),agentReplyExpectation(request)).stage,'observed');for(const patch of [{query:{kind:'Runtime.evaluate',expression:'private'}},{context:{binding,fence:{...document,controlVersion:0}}},{query:{kind:'snapshot',expression:'private'}},{runId:'run_'+uuid(88)}])assert.throws(()=>captureAgentRequest({...command,...patch}));
});

test('observation frame budget rejects undersized channels before dispatch and carries valid payloads above legacy 2 KiB',async t=>{
 const small=pair(t,{maxFrameBytes:2048});await small.channel.start(start);await assert.rejects(small.channel.agent(command),{code:'AGENT_OBSERVATION_UNAVAILABLE',outcome:'not-dispatched'});assert.equal(small.calls.length,0);
 const large=result({visited:8,nodes:Array.from({length:8},(_,n)=>row('elh_'+uuid(30+n),{id:'x'.repeat(64),name:'中'.repeat(64),text:'z'.repeat(128)}))});assert.ok(Buffer.byteLength(JSON.stringify(large))>2048&&Buffer.byteLength(JSON.stringify(large))<6144);const current=pair(t,{reply:()=>large});await current.channel.start(start);assert.equal((await current.channel.agent(command)).nodes.length,8);assert.equal(current.channel.status().available,true);
});
