import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {AgentClient,AgentClientError} from '../sdk/agent.mjs';
import {SessionClient} from '../sdk/backend.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {fixture,until,deferred,tenantId} from './fixtures/agent-executor-fixture.mjs';
import {uuid,sessionId,agentRunId,runResponse} from './fixtures/node-agent-sdk-records.mjs';

const key='fixture_node_events_backend_key_000000000000';
const stamp='2026-10-20T00:00:00.000Z';
const cursor=n=>'aec1.'+agentRunId+'.'+n;
const config=(fetch,extra={})=>({baseUrl:'https://api.fixture.test',apiKey:key,fetch,...extra});
const expect=code=>error=>error instanceof AgentClientError&&error.code===code;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const state=(extra={})=>({state:'active',holdsWriter:true,beginDispatch:'confirmed',endDispatch:'not-requested',error:null,closeEvidenceKind:null,...extra});
const event=(sequence,extra={})=>({schema:'agent-event-v1',eventId:'aevt_'+uuid(sequence+100),agentRunId,sessionId,region:'test',version:'sdk-v1',sequence,observedAt:stamp,type:'run.updated',data:state({stateUpdatedAt:stamp}),...extra});
const ready=(after=0,latest=2)=>({schema:'agent-event-stream-v1',agentRunId,historyOrigin:'created',after:cursor(after),oldestCursor:cursor(Math.max(0,latest-64)),latestCursor:cursor(latest),cursor:cursor(after)});
const checkpoint=(n,reason='duration')=>({schema:'agent-event-checkpoint-v1',agentRunId,cursor:cursor(n),reason});
const heartbeat=n=>({schema:'agent-heartbeat-v1',agentRunId,cursor:cursor(n),observedAt:stamp});
const gap=(after=0,latest=70)=>({schema:'agent-event-gap-v1',agentRunId,historyOrigin:'created',after:cursor(after),oldestCursor:cursor(latest-64),latestCursor:cursor(latest),missingHistory:true});
const frame=(name,data,id)=>'event: '+name+'\n'+(id===undefined?'':'id: '+id+'\n')+'data: '+JSON.stringify(data)+'\n\n';
const stream=(text,headers={})=>new Response(new TextEncoder().encode(text),{headers:{'content-type':'text/event-stream; charset=utf-8','x-request-id':'req_events',...headers}});
const json=(data,status=200,headers={})=>new Response(JSON.stringify({data,requestId:'req_events'}),{status,headers:{'content-type':'application/json','x-request-id':'req_events',...headers}});
const errorReply=(code,status=409,details,extra={})=>new Response(JSON.stringify({error:{code,message:'private message '+key,outcome:'not-dispatched',...(details?{details}:{}),...extra},requestId:'req_events'}),{status,headers:{'content-type':'application/json','x-request-id':'req_events'}});
const page=(after=0,latest=2)=>({schema:'agent-event-http-page-v1',agentRunId,sessionId,region:'test',version:'sdk-v1',historyOrigin:'created',after:cursor(after),oldestSequence:Math.max(1,latest-63),latestSequence:latest,gap:false,events:Array.from({length:Math.min(4,latest-after)},(_,i)=>event(after+i+1)),nextCursor:cursor(Math.min(latest,after+4)),hasMore:after+4<latest,oldestCursor:cursor(Math.max(0,latest-64)),latestCursor:cursor(latest)});
const report=(extra={})=>({schema:'agent-cancellation-v1',agentRunId,sessionId,region:'test',version:'sdk-v1',observedAt:stamp,status:'not-requested',run:state(),work:{ordinaryPending:false,endPending:false,recoveryRequired:false,executorStopping:false},scope:'original-agent-run',rollbackSupported:false,rollbackPerformed:false,businessSuccessConfirmed:false,page:{generation:cursor(2),historyOrigin:'created',after:null,nextCursor:null,hasMore:false,completeRun:true},invocations:[],...extra});
function readerResponse(reader){return {status:200,headers:new Headers({'content-type':'text/event-stream','x-request-id':'req_events'}),body:{getReader:()=>reader}};}
function controlledReader({cancel=async()=>{},release=()=>{}}={}){
 const reads=[],queue=[];let done=false,cancelCalls=0,releaseCalls=0;
 const reader={read(){const p=deferred();reads.push(p);if(queue.length)p.resolve(queue.shift());else if(done)p.resolve({done:true});return p.promise;},async cancel(){cancelCalls++;await cancel();},releaseLock(){releaseCalls++;release();}};
 return {reader,reads,send(value){const pending=reads.find(x=>!x.used);if(pending){pending.used=true;pending.resolve(value);}else queue.push(value);},finish(){done=true;for(const p of reads)p.resolve({done:true});},get cancelCalls(){return cancelCalls;},get releaseCalls(){return releaseCalls;}};
}
async function harness(t,{http={},authenticate,client={}}={}){
 const f=await fixture(t),server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:authenticate??createApiKeyAuthenticator([{apiKey:key,tenantId,scopes:['agents:read','agents:write','agents:end']}]),agentEventStream:{pollIntervalMs:10,heartbeatMs:50,maxDurationMs:100,writeTimeoutMs:50,maxEvents:64,maxBytes:262144},...http});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));});
 return {...f,server,client:new AgentClient({baseUrl:'http://127.0.0.1:'+server.address().port,apiKey:key,...client})};
}

test('Node event API validates exact options and bounded configuration without invoking getters or fetch',async()=>{
 let calls=0,reads=0;const fetch=()=>{calls++;return stream('');};
 for(const extra of [{maxConcurrentEventStreams:0},{maxConcurrentEventStreams:65},{eventStreamTimeoutMs:99},{eventStreamTimeoutMs:120001},{maxEventStreamBytes:4095},{maxEventStreamBytes:1048577}])assert.throws(()=>new AgentClient(config(fetch,extra)),expect('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>new SessionClient(config(fetch,{eventStreamTimeoutMs:100})),error=>error.code==='CLIENT_INVALID_REQUEST');
 const client=new AgentClient(config(fetch));
 for(const options of [{after:cursor(0)+'\n'},{after:cursor(0).replace(agentRunId,'arun_'+uuid(99))},{after:cursor(0).replace('.0','.01')},{reconnects:4},{signal:{}},{unknown:true},{get after(){reads++;return cursor(0);}}])assert.throws(()=>client.runs.events(agentRunId,options),expect('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>client.runs.events('arun_invalid'),expect('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>client.runs.cancellation(agentRunId,{after:cursor(0)}),expect('CLIENT_INVALID_REQUEST'));
 assert.throws(()=>client.runs.eventPage(agentRunId,{reconnects:1}),expect('CLIENT_INVALID_REQUEST'));
 assert.equal(reads,0);assert.equal(calls,0);assert.deepEqual(client.eventTransportStatus(),{streams:0});assert.deepEqual(client.transportStatus(),{ordinary:0,ending:0});
});
test('event iterators are lazy and pre-abort, return and throw before first pull never dispatch',async()=>{
 let calls=0;const client=new AgentClient(config(()=>{calls++;return stream('');})),abort=new AbortController();abort.abort();
 await assert.rejects(client.runs.events(agentRunId,{signal:abort.signal}).next(),e=>expect('CLIENT_ABORTED')(e)&&e.outcome==='not-dispatched');
 const returned=client.runs.events(agentRunId);assert.equal(Object.isFrozen(returned),true);assert.equal(returned[Symbol.asyncIterator](),returned);await returned.return();assert.deepEqual(await returned.next(),{done:true,value:undefined});
 const thrown=client.runs.events(agentRunId),reason=Error('caller');await assert.rejects(thrown.throw(reason),e=>e===reason);assert.equal(calls,0);
});
test('event page and explicit cancellation preserve immutable public metadata without business acknowledgement',async()=>{
 const calls=[],client=new AgentClient(config((url,init)=>{calls.push({url,init});return url.includes('/events')?json(page()):json(report());}));
 const result=await client.runs.eventPage(agentRunId);assert.equal(result.data.events.length,2);assert.equal(Object.isFrozen(result.data.events[0].data),true);
 const cancel=await client.runs.cancel(agentRunId).catch(e=>e);assert.equal(cancel.code,'CLIENT_INVALID_RESPONSE');
 const next=new AgentClient(config(()=>json(report(),200,{location:'/v1/agent-runs/'+agentRunId+'/cancellation'})));assert.equal((await next.runs.cancel(agentRunId)).data.businessSuccessConfirmed,false);
 const status=await client.runs.cancellation(agentRunId);assert.equal(status.data.page.completeRun,true);assert.equal(Object.isFrozen(status.data.work),true);assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.body,undefined);
});
test('event pages reject identity, contiguous sequence, cursor, byte, private-field and phase mismatches',async()=>{
 const mutations=[v=>v.events[0].sequence=2,v=>v.events[1].eventId=v.events[0].eventId,v=>v.events[0].sessionId='ses_'+uuid(99),v=>v.events[0].data.holdsWriter=false,v=>v.events[0].private='private',v=>v.events[0].data.stateUpdatedAt='bad',v=>v.events[0].data.closeEvidenceKind='worker-run-closed',v=>v.hasMore=true,v=>v.nextCursor=cursor(3),v=>v.after=cursor(1),v=>v.oldestCursor=cursor(1),v=>v.gap=true,v=>v.events.pop(),v=>v.region='x'.repeat(65),v=>v.extra=true];
 for(const mutate of mutations){const value=page();mutate(value);const client=new AgentClient(config(()=>json(value)));await assert.rejects(client.runs.eventPage(agentRunId),expect('CLIENT_INVALID_RESPONSE'));}
 const p=page(2,7),client=new AgentClient(config(()=>json(p)));assert.equal((await client.runs.eventPage(agentRunId,{after:cursor(2)})).data.nextCursor,cursor(6));
});
test('cancellation reports validate pending work and closed status independently of unknown input effects',async()=>{
 const invocation={invocationId:'ainv_'+uuid(11),tool:'insertText',state:'unknown',dispatchStarted:true,receipt:null,error:{code:'AGENT_RPC_TIMEOUT',outcome:'unknown'},effect:'unknown',updatedAt:stamp};
 const value=report({status:'settling',run:state({state:'closed',holdsWriter:false,endDispatch:'confirmed',closeEvidenceKind:'worker-run-closed'}),work:{ordinaryPending:true,endPending:false,recoveryRequired:false,executorStopping:false},invocations:[invocation]});
 const client=new AgentClient(config(()=>json(value,202,{location:'/v1/agent-runs/'+agentRunId+'/cancellation'}))),result=await client.runs.cancel(agentRunId);assert.equal(result.data.status,'settling');assert.equal(result.data.invocations[0].effect,'unknown');assert.equal(result.data.rollbackPerformed,false);
 for(const mutate of [v=>v.status='closed',v=>v.rollbackSupported=true,v=>v.rollbackPerformed=true,v=>v.businessSuccessConfirmed=true,v=>v.invocations[0].effect='not-dispatched',v=>v.invocations[0].receipt={stage:'input-injected',inputs:1},v=>v.page.generation=cursor(0),v=>v.page.completeRun=false,v=>v.run.closeEvidenceKind=null,v=>v.invocations[0].private=true]){const bad=structuredClone(value);mutate(bad);const c=new AgentClient(config(()=>json(bad)));await assert.rejects(c.runs.cancellation(agentRunId),expect('CLIENT_INVALID_RESPONSE'));}
});
test('event gaps expose only validated immutable details and never skip missing history or retry a changed cancellation page',async()=>{
 let calls=0;const client=new AgentClient(config(()=>{calls++;return errorReply('AGENT_EVENT_GAP',409,gap());},{retries:3}));
 await assert.rejects(client.runs.eventPage(agentRunId),e=>{assert.equal(e.code,'AGENT_EVENT_GAP');assert.equal(e.details.missingHistory,true);assert.equal(Object.isFrozen(e.details),true);assert.doesNotMatch(JSON.stringify(e)+String(e),new RegExp(key));return true;});assert.equal(calls,1);
 for(const details of [{...gap(),after:cursor(7)},{...gap(),missingHistory:false},{...gap(),private:true}]){const bad=new AgentClient(config(()=>errorReply('AGENT_EVENT_GAP',409,details)));await assert.rejects(bad.runs.eventPage(agentRunId),expect('CLIENT_INVALID_RESPONSE'));}
 const spoof=new AgentClient(config(()=>errorReply('AGENT_EVENT_GAP',409,gap(),{outcome:'unknown'})));await assert.rejects(spoof.runs.eventPage(agentRunId),expect('CLIENT_INVALID_RESPONSE'));
 let attempts=0;const retried=new AgentClient(config(()=>++attempts===1?Promise.reject(Error('lost observation')):errorReply('AGENT_EVENT_GAP',409,gap()),{retries:1}));await assert.rejects(retried.runs.eventPage(agentRunId),e=>expect('AGENT_EVENT_GAP')(e)&&e.outcome==='unknown'&&e.details.missingHistory===true);assert.equal(attempts,2);
 const changed=new AgentClient(config(()=>errorReply('AGENT_CANCELLATION_CHANGED')));await assert.rejects(changed.runs.cancellation(agentRunId),expect('AGENT_CANCELLATION_CHANGED'));
});
test('SSE parses strict ready, event, heartbeat and checkpoint across UTF8 byte boundaries and CRLF',async()=>{
 const text=(': comment\n\n'+frame('ready',ready())+frame('agent',event(1,{version:'版本'}),cursor(1))+frame('heartbeat',heartbeat(1))+frame('checkpoint',checkpoint(1))).replaceAll('\n','\r\n');
 const bytes=new TextEncoder().encode(text);let index=0;const response=new Response(new ReadableStream({pull(c){if(index===bytes.length)c.close();else c.enqueue(bytes.slice(index,++index));}}),{headers:{'content-type':'text/event-stream','x-request-id':'req_utf8'}});
 const client=new AgentClient(config(()=>response)),messages=[];for await(const value of client.runs.events(agentRunId,{reconnects:0}))messages.push(value);
 assert.deepEqual(messages.map(v=>v.kind),['ready','event','heartbeat','checkpoint']);assert.equal(messages[1].event.version,'版本');assert.equal(Object.isFrozen(messages[1].event.data),true);await until(()=>client.eventTransportStatus().streams===0);
});
test('checkpoint reconnects from the last delivered event and reauthenticates each finite connection',async()=>{
 const calls=[],client=new AgentClient(config((url,init)=>{calls.push({url,init});const n=calls.length;return stream(frame('ready',ready(n-1,3))+frame('agent',event(n),cursor(n))+frame('checkpoint',checkpoint(n)));})),values=[];
 for await(const message of client.runs.events(agentRunId,{reconnects:2}))values.push(message);
 assert.equal(calls.length,3);assert.deepEqual(values.filter(v=>v.kind==='event').map(v=>v.event.sequence),[1,2,3]);assert.ok(calls[1].url.endsWith('?after='+cursor(1)));assert.ok(calls[2].url.endsWith('?after='+cursor(2)));
 for(const {init}of calls){assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.headers.authorization,'Bearer '+key);assert.equal(init.headers['accept-encoding'],'identity');}
 await until(()=>client.eventTransportStatus().streams===0);
});
test('interrupted SSE reconnects after delivered cursor without duplicate actions or transparent gap repair',async()=>{
 let calls=0;const client=new AgentClient(config(()=>++calls===1?stream(frame('ready',ready())+frame('agent',event(1),cursor(1))):stream(frame('ready',ready(1))+frame('agent',event(2),cursor(2))+frame('checkpoint',checkpoint(2))))),events=[];
 for await(const value of client.runs.events(agentRunId,{reconnects:1}))if(value.kind==='event')events.push(value.event.sequence);
 assert.deepEqual(events,[1,2]);assert.equal(calls,2);
});
test('stream gap is explicit and retains the last delivered cursor without reconnecting',async()=>{
 let calls=0;const client=new AgentClient(config(()=>{calls++;return stream(frame('ready',ready())+frame('agent',event(1),cursor(1))+frame('gap',gap(1,70)));}));const iterator=client.runs.events(agentRunId);
 assert.equal((await iterator.next()).value.kind,'ready');assert.equal((await iterator.next()).value.cursor,cursor(1));await assert.rejects(iterator.next(),e=>expect('AGENT_EVENT_GAP')(e)&&e.cursor===cursor(1)&&e.details.after===cursor(1));assert.equal(calls,1);await iterator.return();
});
test('malformed SSE rejects duplicated fields, phase jumps, changed identity and unsafe control cursors',async()=>{
 const invalid=[frame('agent',event(1),cursor(1)),frame('ready',ready())+frame('agent',event(2),cursor(2)),frame('ready',ready())+frame('heartbeat',heartbeat(1)),frame('ready',ready())+frame('checkpoint',checkpoint(1)),frame('ready',ready())+frame('heartbeat',heartbeat(0),cursor(0)),frame('ready',ready(),cursor(0)),frame('ready',ready())+frame('ready',ready()),frame('ready',ready())+'event: heartbeat\nevent: heartbeat\ndata: {}\n\n',frame('ready',ready())+'retry: 10\n\n',frame('ready',{...ready(),private:true}),frame('ready',ready())+frame('agent',event(1),cursor(1))+frame('agent',event(2,{sessionId:'ses_'+uuid(99)}),cursor(2)),frame('ready',ready())+frame('checkpoint',checkpoint(0))+frame('heartbeat',heartbeat(0))];
 for(const text of invalid){const client=new AgentClient(config(()=>stream(text))),iterator=client.runs.events(agentRunId,{reconnects:0});await assert.rejects(async()=>{for await(const value of iterator)void value;},expect('CLIENT_INVALID_RESPONSE'));await until(()=>client.eventTransportStatus().streams===0);}
});
test('stream rejects bad status, encoding, correlation, length and non-UTF8 bytes before accepting events',async()=>{
 const variants=[()=>stream('',{'content-type':'application/json'}),()=>stream('',{'content-encoding':'gzip'}),()=>stream('',{'x-request-id':'bad'}),()=>stream('',{'content-length':'01'}),()=>stream('',{'content-length':'1048577'}),()=>new Response(new Uint8Array([255,10,10]),{headers:{'content-type':'text/event-stream','x-request-id':'req_utf8'}})];
 for(const reply of variants){const client=new AgentClient(config(reply)),iterator=client.runs.events(agentRunId,{reconnects:0});await assert.rejects(iterator.next(),expect('CLIENT_INVALID_RESPONSE'));await iterator.return();}
});
test('stream frame and total byte budgets apply without silently skipping undelivered events',async()=>{
 for(const text of [':'+ 'x'.repeat(4096)+'\n\n',(':padding '+ 'x'.repeat(990)+'\n\n').repeat(5)]){
  const client=new AgentClient(config(()=>stream(text),{maxEventStreamBytes:4096})),iterator=client.runs.events(agentRunId,{reconnects:0});await assert.rejects(iterator.next(),expect('CLIENT_EVENT_STREAM_LIMIT'));await iterator.return();
 }
 let calls=0;const payload=frame('ready',ready(0,1))+(':padding '+ 'x'.repeat(990)+'\n\n').repeat(2)+frame('checkpoint',checkpoint(0));
 const client=new AgentClient(config(()=>{calls++;return stream(payload);},{maxEventStreamBytes:4096}));await assert.rejects(async()=>{for await(const value of client.runs.events(agentRunId,{reconnects:1}))void value;},expect('CLIENT_EVENT_STREAM_LIMIT'));assert.equal(calls,2);
});
test('demand-driven pulls retain one bounded chunk and forbid concurrent next without cancelling the original pull',async()=>{
 const h=controlledReader(),client=new AgentClient(config(()=>readerResponse(h.reader))),iterator=client.runs.events(agentRunId,{reconnects:0}),first=iterator.next();await until(()=>h.reads.length===1);
 await assert.rejects(iterator.next(),expect('CLIENT_EVENT_STREAM_BUSY'));assert.equal(h.cancelCalls,0);h.send({done:false,value:new TextEncoder().encode(frame('ready',ready())+frame('agent',event(1),cursor(1)))});assert.equal((await first).value.kind,'ready');await sleep(10);assert.equal(h.reads.length,1);assert.equal((await iterator.next()).value.event.sequence,1);assert.equal(h.reads.length,1);h.finish();await iterator.return();await until(()=>client.eventTransportStatus().streams===0);
});
test('noncooperative fetch retains stream capacity after observation timeout while finite get and cancel stay independent',async()=>{
 const gate=deferred();let streamCalls=0,cancelled=0;const client=new AgentClient(config(url=>{if(url.includes('/events/stream')){streamCalls++;return gate.promise;}if(url.endsWith('/cancel'))return json(report(),200,{location:'/v1/agent-runs/'+agentRunId+'/cancellation'});return runResponse();},{eventStreamTimeoutMs:100,timeoutMs:50,maxConcurrentEventStreams:1})),iterator=client.runs.events(agentRunId);
 await assert.rejects(iterator.next(),expect('CLIENT_TIMEOUT'));assert.equal(client.eventTransportStatus().streams,1);await assert.rejects(client.runs.events(agentRunId).next(),expect('CLIENT_CAPACITY'));assert.equal((await client.runs.get(agentRunId)).data.agentRunId,agentRunId);await client.runs.cancel(agentRunId);assert.equal(streamCalls,1);
 gate.resolve({body:{async cancel(){cancelled++;}}});await until(()=>client.eventTransportStatus().streams===0);assert.equal(cancelled,1);await iterator.return();
});
test('abort promptly ends waiting but retains capacity until both noncooperative read and cancellation actually settle',async()=>{
 const cancellation=deferred(),h=controlledReader({cancel:()=>cancellation.promise}),abort=new AbortController(),client=new AgentClient(config(()=>readerResponse(h.reader),{timeoutMs:50,maxConcurrentEventStreams:1})),iterator=client.runs.events(agentRunId,{signal:abort.signal}),pending=iterator.next();await until(()=>h.reads.length===1);abort.abort();await assert.rejects(pending,expect('CLIENT_ABORTED'));await until(()=>h.cancelCalls===1);assert.equal(client.eventTransportStatus().streams,1);
 cancellation.resolve();await sleep(5);assert.equal(client.eventTransportStatus().streams,1);h.finish();await iterator.return();assert.equal(h.releaseCalls,1);assert.equal(client.eventTransportStatus().streams,0);
});
test('return observation timeout does not release noncooperative cleanup and late cleanup can settle the original slot',async()=>{
 const cancellation=deferred(),h=controlledReader({cancel:()=>cancellation.promise}),client=new AgentClient(config(()=>readerResponse(h.reader),{timeoutMs:50})),iterator=client.runs.events(agentRunId),pending=iterator.next();await until(()=>h.reads.length===1);const outcome=pending.catch(e=>e);await assert.rejects(iterator.return(),expect('CLIENT_TIMEOUT'));assert.equal((await outcome).code,'CLIENT_ABORTED');assert.equal(client.eventTransportStatus().streams,1);h.finish();cancellation.resolve();await iterator.return();assert.equal(client.eventTransportStatus().streams,0);
});
test('a paused iterator absolute deadline cancels its actual reader without needing another next',async()=>{
 const h=controlledReader(),client=new AgentClient(config(()=>readerResponse(h.reader),{eventStreamTimeoutMs:100})),iterator=client.runs.events(agentRunId),first=iterator.next();await until(()=>h.reads.length===1);h.send({done:false,value:new TextEncoder().encode(frame('ready',ready()))});await first;
 await until(()=>h.cancelCalls===1);assert.equal(h.releaseCalls,1);assert.equal(client.eventTransportStatus().streams,0);await assert.rejects(iterator.next(),expect('CLIENT_TIMEOUT'));await iterator.return();
});
test('failed reader cancellation and releaseLock retain uncertain capacity instead of granting replacement slots',async()=>{
 for(const where of ['cancel','release']){
  const h=controlledReader(where==='cancel'?{cancel:async()=>{throw Error('private cleanup');}}:{release:()=>{throw Error('private release');}}),client=new AgentClient(config(()=>readerResponse(h.reader),{maxConcurrentEventStreams:1})),iterator=client.runs.events(agentRunId),first=iterator.next();await until(()=>h.reads.length===1);const observed=first.catch(e=>e);h.finish();await assert.rejects(iterator.return(),expect('CLIENT_EVENT_STREAM_CLEANUP_FAILED'));await observed;assert.equal(client.eventTransportStatus().streams,1);await assert.rejects(client.runs.events(agentRunId).next(),expect('CLIENT_CAPACITY'));
 }
});
test('deadline during reconnect cleanup joins one actual cancellation and releases the reader exactly once',async()=>{
 const cancellation=deferred();let releases=0,cancels=0,reads=0;
 const reader={async read(){if(reads++===0)return {done:false,value:new TextEncoder().encode(frame('ready',ready()))};throw Error('transport interrupted');},cancel(){cancels++;return cancellation.promise;},releaseLock(){releases++;}};
 const client=new AgentClient(config(()=>readerResponse(reader),{eventStreamTimeoutMs:100})),iterator=client.runs.events(agentRunId);await iterator.next();const pending=iterator.next();await until(()=>cancels===1);await assert.rejects(pending,expect('CLIENT_TIMEOUT'));cancellation.resolve();await iterator.return();assert.equal(cancels,1);assert.equal(releases,1);assert.equal(client.eventTransportStatus().streams,0);
});
test('actual HTTP event pages, cancellation pagination and stale-generation conflicts preserve original Run effects',{skip:!sessionStoreSupported},async t=>{
 const h=await harness(t),{run,context}=await h.active();for(let i=0;i<6;i++)await h.invocation(h.perform(run,context,'node-event-'+i));const id=run.agentRunId,p=await h.client.runs.eventPage(id);assert.equal(p.data.events.length,4);assert.equal(p.data.hasMore,true);const next=await h.client.runs.eventPage(id,{after:p.data.nextCursor});assert.equal(next.data.events[0].sequence,p.data.events.at(-1).sequence+1);
 const first=(await h.client.runs.cancellation(id)).data;assert.equal(first.invocations.length,4);assert.equal(first.page.hasMore,true);const second=(await h.client.runs.cancellation(id,{after:first.page.nextCursor})).data;assert.equal(second.invocations.length,2);assert.equal(second.page.completeRun,false);assert.equal(new Set([...first.invocations,...second.invocations].map(x=>x.invocationId)).size,6);
 await h.client.runs.cancel(id);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');await assert.rejects(h.client.runs.cancellation(id,{after:first.page.nextCursor}),expect('AGENT_CANCELLATION_CHANGED'));const final=(await h.client.runs.cancellation(id)).data;assert.equal(final.status,'closed');assert.equal(final.businessSuccessConfirmed,false);assert.equal(final.invocations[0].effect,'input-injected');assert.equal(h.effects.length,6);
});
test('for-await break closes only the HTTP reader and explicit cancel reports actual late Source work',{skip:!sessionStoreSupported},async t=>{
 const h=await harness(t),{run,context}=await h.active(),gate=deferred(),entered=deferred();t.after(()=>gate.resolve(context));h.hooks.context=()=>{entered.resolve();return gate.promise;};const pending=h.executor.context(h.runRef(run)).catch(e=>e);await entered.promise;
 for await(const value of h.client.runs.events(run.agentRunId)){assert.equal(value.kind,'ready');break;}await until(()=>h.client.eventTransportStatus().streams===0);assert.equal(h.executor.status().ordinary,1);assert.equal(h.executor.getRun(h.runRef(run)).state,'active');
 await h.client.runs.cancel(run.agentRunId);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');const settling=(await h.client.runs.cancellation(run.agentRunId)).data;assert.equal(settling.status,'settling');assert.equal(settling.work.ordinaryPending,true);gate.resolve(context);await pending;await until(()=>h.executor.status().ordinary===0);assert.equal((await h.client.runs.cancellation(run.agentRunId)).data.status,'closed');assert.equal(h.effects.length,0);
});
test('each actual stream reconnection checks current authorization and never retries revocation',{skip:!sessionStoreSupported},async t=>{
 let allowed=true,calls=0;const h=await harness(t,{authenticate:()=>{calls++;return allowed?{tenantId,scopes:['agents:read','agents:end']}:null;}}),{run}=await h.active(),iterator=h.client.runs.events(run.agentRunId,{reconnects:3});t.after(()=>iterator.return().catch(()=>{}));
 for(;;){const value=(await iterator.next()).value;if(value.kind==='checkpoint')break;}allowed=false;await assert.rejects(iterator.next(),e=>e instanceof AgentClientError&&[401,403].includes(e.status));assert.equal(calls,2);await iterator.return();assert.equal(h.client.eventTransportStatus().streams,0);
});
test('actual event GET redirects never forward backend credentials to another origin',async t=>{
 let targetCalls=0;const target=createServer((_req,res)=>{targetCalls++;res.end();}),redirect=createServer((_req,res)=>{res.writeHead(307,{location:'http://127.0.0.1:'+target.address().port});res.end();});
 for(const server of [target,redirect]){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});}
 const client=new AgentClient({baseUrl:'http://127.0.0.1:'+redirect.address().port,apiKey:key}),iterator=client.runs.events(agentRunId,{reconnects:0});await assert.rejects(iterator.next(),expect('CLIENT_TRANSPORT_ERROR'));await iterator.return();assert.equal(targetCalls,0);
});
test('cancel shares the existing independent end pool and timeout cannot credit unfinished end work',async()=>{
 const gate=deferred(),client=new AgentClient(config(url=>url.endsWith('/cancel')?gate.promise:runResponse(),{timeoutMs:50,maxConcurrentEndRequests:1,maxConcurrentRequests:1}));
 await assert.rejects(client.runs.cancel(agentRunId),expect('CLIENT_TIMEOUT'));assert.deepEqual(client.transportStatus(),{ordinary:0,ending:1});await assert.rejects(client.runs.end(agentRunId),expect('CLIENT_CAPACITY'));assert.equal((await client.runs.get(agentRunId)).data.agentRunId,agentRunId);gate.resolve(json(report(),200,{location:'/v1/agent-runs/'+agentRunId+'/cancellation'}));await until(()=>client.transportStatus().ending===0);
});
test('absolute stream deadline includes all reconnect windows and delays without resetting its budget',async()=>{
 let calls=0;const client=new AgentClient(config(()=>{calls++;return stream(frame('ready',ready())+frame('checkpoint',checkpoint(0)));},{eventStreamTimeoutMs:100}));
 await assert.rejects(async()=>{for await(const value of client.runs.events(agentRunId,{reconnects:3}))void value;},e=>expect('CLIENT_TIMEOUT')(e)&&e.cursor===cursor(0));assert.ok(calls>=1&&calls<=3);await until(()=>client.eventTransportStatus().streams===0);
});
test('actual retained-history gaps are explicit in finite JSON and initial SSE error responses',{skip:!sessionStoreSupported},async t=>{
 const h=await harness(t),{run,context}=await h.active();for(let i=0;i<24;i++)await h.invocation(h.perform(run,context,'node-gap-'+i));
 await assert.rejects(h.client.runs.eventPage(run.agentRunId),e=>expect('AGENT_EVENT_GAP')(e)&&e.details.missingHistory===true);const iterator=h.client.runs.events(run.agentRunId);
 await assert.rejects(iterator.next(),e=>expect('AGENT_EVENT_GAP')(e)&&e.status===409&&e.cursor==='aec1.'+run.agentRunId+'.0');await iterator.return();assert.equal(h.client.eventTransportStatus().streams,0);assert.equal(h.effects.length,24);
});
