import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {EventEmitter,getEventListeners} from 'node:events';
import {rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {agentEventCursor,agentEventAfter,agentEventStreamOptions,writeAgentEventFrame} from '../service/agent-event-http.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {DurableAgentExecutor} from '../service/agent-executor.mjs';
import {fixture,until,deferred,tenantId,actionKey} from './fixtures/agent-executor-fixture.mjs';
import {agentHttpClient,agentPaths} from './fixtures/agent-http-client.mjs';
const enabled={skip:!sessionStoreSupported},token=n=>'fixture_agent_event_'+n+'_00000000000000000000000',ALL=token('all'),READ=token('read'),END=token('end'),OBSERVE=token('observe'),OTHER=token('other'),SLOW=token('slow');
const credentials=[{apiKey:ALL,tenantId,scopes:['agents:read','agents:write','agents:end']},{apiKey:READ,tenantId,scopes:['agents:read']},{apiKey:END,tenantId,scopes:['agents:end']},{apiKey:OBSERVE,tenantId,scopes:['agents:observe']},{apiKey:OTHER,tenantId:'tenant-other',scopes:['agents:read']}];
const streamOptions={pollIntervalMs:10,heartbeatMs:50,maxDurationMs:500,writeTimeoutMs:100,maxEvents:64,maxBytes:262144};
const path=(run,stream=false)=>'/v1/agent-runs/'+run.agentRunId+'/events'+(stream?'/stream':'');
const code=(response,status,value)=>{assert.equal(response.status,status,JSON.stringify(response.body));assert.equal(response.body.error.code,value);};
async function harness(t,{http={},authenticate=createApiKeyAuthenticator(credentials),configure}={}){
 const f=await fixture(t),sockets=new Set(),server=createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate,agentEventStream:streamOptions,...http});
 configure?.(server,f);server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise(resolve=>server.close(resolve));});
 const base='http://127.0.0.1:'+server.address().port,api=agentHttpClient(base,ALL);
 const open=({run,after,headers={},key=READ}={})=>new Promise((resolve,reject)=>{
  const req=request(base+path(run,true)+(after===undefined?'':'?after='+after),{headers:{authorization:'Bearer '+key,...headers},agent:false},res=>{
   const frames=[],chunks=[];let pending='';const closed=deferred();
   res.on('data',chunk=>{chunks.push(chunk);pending+=chunk.toString();for(;;){const i=pending.indexOf('\n\n');if(i<0)break;const text=pending.slice(0,i);pending=pending.slice(i+2);const lines=Object.fromEntries(text.split('\n').map(line=>{const i=line.indexOf(':');return [line.slice(0,i),line.slice(i+1).trimStart()];}));if(lines.data)frames.push({...lines,data:JSON.parse(lines.data)});}});
   res.on('error',()=>{});res.once('close',()=>closed.resolve());resolve({req,res,frames,closed:closed.promise,raw:()=>Buffer.concat(chunks),stop:()=>res.destroy()});
  });req.on('error',reject);req.end();
 });
 const raw=(url,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:server.address().port,path:url,headers:{authorization:'Bearer '+READ,...headers},agent:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))});}catch(e){reject(e);}});});req.on('error',reject);req.end();});
 const page=(run,after,headers={},key=READ)=>agentHttpClient(base,key)('GET',path(run)+(after===undefined?'':'?after='+after),{headers});
 const generate=async(run,context,n=1)=>{for(let i=0;i<n;i++){const row=f.perform(run,context,'event-http-'+i+'-'+f.effects.length,{text:'private-event-action'});assert.equal((await f.invocation(row)).state,'injected');}};
 return {...f,server,base,api,page,open,generate,raw};
}
function cleanWriter(w,signal){assert.equal(w.listenerCount('drain'),0);assert.equal(w.listenerCount('error'),0);assert.equal(w.listenerCount('close'),0);assert.equal(getEventListeners(signal,'abort').length,0);}

test('public event cursor is canonical, bounded and binds the exact original Run without getters',()=>{
 const id='arun_12345678-1234-1234-1234-123456789abc';assert.equal(agentEventAfter(id),0);
 for(const n of [0,1,Number.MAX_SAFE_INTEGER])assert.equal(agentEventAfter(id,agentEventCursor(id,n)),n);
 for(const v of ['',0,'aec1.'+id+'.01','aec1.'+id+'.-1','aec1.'+id+'.9007199254740992','aec1.'+id+'.1\n','aec1.'+id.replace('123456789abc','123456789abd')+'.1',{}])assert.throws(()=>agentEventAfter(id,v),e=>e.code==='AGENT_EVENT_CURSOR_INVALID');
 let calls=0;assert.throws(()=>agentEventStreamOptions({get heartbeatMs(){calls++;return 50;}}),TypeError);assert.equal(calls,0);
 for(const v of [{unknown:1},{maxEvents:65},{maxBytes:8191},{maxDurationMs:60001},{pollIntervalMs:0},{heartbeatMs:49},{writeTimeoutMs:0},{heartbeatMs:30001},{maxDurationMs:100},{maxEvents:NaN}])assert.throws(()=>agentEventStreamOptions(v),TypeError);
});
test('event HTTP validates independent finite admission and stream configuration before binding',enabled,async t=>{
 const f=await fixture(t);for(const value of [{maxAgentEventStreams:0},{maxAgentEventStreams:65},{agentEventStream:null},{agentEventStream:{maxEvents:65}}])assert.throws(()=>createSessionControlServer({registry:f.registry,agentExecutor:f.executor,authenticate:createApiKeyAuthenticator(credentials),...value}),TypeError);
});
test('actual authenticated event pages retain stable IDs and cursor order without Source RPC or private page data',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active();await h.generate(run,context,2);const calls=h.calls.length,first=await h.page(run);assert.equal(first.status,200);const page=first.body.data;assert.equal(page.schema,'agent-event-http-page-v1');assert.equal(page.events.length,4);assert.equal(page.after,agentEventCursor(run.agentRunId,0));assert.equal(page.nextCursor,agentEventCursor(run.agentRunId,4));
 const next=await h.page(run,page.nextCursor);assert.equal(next.body.data.events[0].sequence,5);assert.deepEqual((await h.page(run)).body.data,page);assert.equal(h.calls.length,calls);
 assert.doesNotMatch(JSON.stringify(page),/private-event-action|params|workerRunId|targetId|controlSessionId|evidenceSha256|tenantId/);assert.equal(first.headers['cache-control'],'no-store');assert.equal(first.headers['x-content-type-options'],'nosniff');assert.equal(first.headers['access-control-allow-origin'],undefined);
});
test('events require agents read, backend Origin policy and the authenticated exact tenant',enabled,async t=>{
 const h=await harness(t),{run}=await h.active();for(const k of [END,OBSERVE]){code(await h.page(run,undefined,{},k),403,'FORBIDDEN');const s=await h.open({run,key:k});await s.closed;assert.equal(s.res.statusCode,403);}
 code(await h.page(run,undefined,{origin:'https://browser.example'}),403,'MANAGEMENT_ORIGIN_FORBIDDEN');code(await h.page(run,undefined,{authorization:''}),401,'UNAUTHENTICATED');code(await h.page(run,undefined,{},OTHER),404,'AGENT_RUN_NOT_FOUND');
 const other=await h.open({run,key:OTHER});await other.closed;assert.equal(other.res.statusCode,404);assert.equal(h.effects.length,0);
});
test('event HTTP rejects ambiguous cursor sources, duplicate headers and future or cross Run cursors without poisoning the executor',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),cursor=agentEventCursor(run.agentRunId,1),p=path(run);
 for(const query of ['?','?tenantId=x','?after='+cursor+'&after='+cursor,'?after='+cursor+'&limit=4','?after='+cursor+'?x','?after='+cursor.replace('aec1.','aec1%2e'),'#hash'])code(await h.raw(p+query),404,'ROUTE_NOT_FOUND');
 code(await h.page(run,cursor,{'last-event-id':cursor}),400,'AGENT_EVENT_CURSOR_INVALID');code(await h.raw(p,{'last-event-id':[cursor,cursor]}),400,'INVALID_REQUEST');
 for(const value of ['',cursor+'.0',agentEventCursor(run.agentRunId,9007199254740991),cursor.replace(run.agentRunId,'arun_12345678-1234-1234-1234-123456789abc')])code(await h.page(run,undefined,{'last-event-id':value}),400,'AGENT_EVENT_CURSOR_INVALID');
 code(await h.page(run,cursor,{},OTHER),404,'AGENT_RUN_NOT_FOUND');assert.equal(h.executor.status().state,'active');assert.equal((await h.page(run,undefined,{'last-event-id':cursor})).body.data.after,cursor);
});
test('retention gaps return an explicit 409 and require a caller chosen retained cursor for recovery',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active();await h.generate(run,context,24);const gap=await h.page(run);code(gap,409,'AGENT_EVENT_GAP');const d=gap.body.error.details;assert.equal(d.after,agentEventCursor(run.agentRunId,0));assert.equal(d.missingHistory,true);assert.equal(d.historyOrigin,'created');
 const s=await h.open({run});await s.closed;assert.equal(s.res.statusCode,409);assert.equal(s.res.headers['content-type'],'application/json; charset=utf-8');assert.equal(s.frames.length,0);
 let after=d.oldestCursor;const events=[];for(;;){const r=await h.page(run,after);assert.equal(r.status,200);events.push(...r.body.data.events);after=r.body.data.nextCursor;if(!r.body.data.hasMore)break;}
 assert.equal(events.length,64);assert.equal(after,d.latestCursor);assert.equal(new Set(events.map(e=>e.eventId)).size,64);assert.equal(h.effects.length,24);
});
test('real SSE replays the same durable events and reconnect starts strictly after the last observed cursor',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active(),s=await h.open({run});assert.equal(s.res.statusCode,200);assert.equal(s.res.headers['content-type'],'text/event-stream; charset=utf-8');await until(()=>s.frames.filter(x=>x.event==='agent').length===3);await h.generate(run,context);await until(()=>s.frames.filter(x=>x.event==='agent').length===6);
 const observed=s.frames.filter(x=>x.event==='agent'),last=observed.at(-1).id;s.stop();await s.closed;await until(async()=>((await h.page(run,last)).status===200));await h.generate(run,context);
 const s2=await h.open({run,headers:{'last-event-id':last}});await until(()=>s2.frames.filter(x=>x.event==='agent').length===3);const replay=s2.frames.filter(x=>x.event==='agent'),page=(await h.page(run,last)).body.data;assert.deepEqual(replay.map(x=>x.data),page.events);assert.equal(replay[0].data.sequence,7);assert.equal(replay.some(x=>observed.some(y=>x.data.eventId===y.data.eventId)),false);s2.stop();await s2.closed;
});
test('heartbeats never advance the cursor and stream lifetime is distinct from the authentication request deadline',enabled,async t=>{
 const h=await harness(t,{http:{requestTimeoutMs:50,agentEventStream:{...streamOptions,maxDurationMs:250}}}),{run}=await h.active(),head=h.executor.events(h.runRef(run)).latestSequence,cursor=agentEventCursor(run.agentRunId,head),calls=h.calls.length,s=await h.open({run,after:cursor});await s.closed;
 assert.equal(s.res.statusCode,200);assert.equal(s.frames.filter(f=>f.event==='agent').length,0);assert.ok(s.frames.filter(f=>f.event==='heartbeat').length>=1);for(const f of s.frames.filter(f=>f.event==='heartbeat')){assert.equal(f.data.cursor,cursor);assert.equal(f.id,undefined);}
 const end=s.frames.at(-1);assert.equal(end.event,'checkpoint');assert.equal(end.data.reason,'duration');assert.equal(end.data.cursor,cursor);assert.equal(end.id,undefined);assert.equal(h.calls.length,calls);assert.equal(h.executor.getRun(h.runRef(run)).state,'active');
});
test('a finite event window ends with a cursor checkpoint and reauthentication can continue remaining history',enabled,async t=>{
 const h=await harness(t,{http:{agentEventStream:{...streamOptions,maxEvents:2}}}),{run}=await h.active(),s=await h.open({run});await s.closed;const events=s.frames.filter(f=>f.event==='agent');assert.equal(events.length,2);assert.equal(s.frames.at(-1).data.reason,'events');assert.equal(s.frames.at(-1).data.cursor,events.at(-1).id);const next=await h.open({run,after:events.at(-1).id});await until(()=>next.frames.some(x=>x.event==='agent'));assert.equal(next.frames.find(x=>x.event==='agent').data.sequence,3);next.stop();await next.closed;
});
test('the real SSE byte ceiling includes framing, heartbeat and final checkpoint without skipping the unsent event',enabled,async t=>{
 const h=await harness(t,{http:{agentEventStream:{...streamOptions,maxBytes:8192}}}),{run,context}=await h.active();await h.generate(run,context,20);const s=await h.open({run});await s.closed;const last=s.frames.at(-1),events=s.frames.filter(f=>f.event==='agent');assert.equal(last.event,'checkpoint');assert.equal(last.data.reason,'bytes');assert.ok(s.raw().length<=8192);assert.equal(last.data.cursor,events.at(-1).id);assert.equal((await h.page(run,last.data.cursor)).body.data.events[0].sequence,events.at(-1).data.sequence+1);
});
test('event disconnect and exhausted stream admission do not cancel actual pending Source work or block independent end',enabled,async t=>{
 const h=await harness(t,{http:{maxConcurrentRequests:1,maxAgentEventStreams:1,maxAgentEndRequests:1}}),{run,context}=await h.active(),gate=deferred(),entered=deferred();h.hooks.context=()=>{entered.resolve();return gate.promise;};const pending=h.executor.context(h.runRef(run)).catch(e=>e);await entered.promise;const s=await h.open({run});await until(()=>s.frames.length>0);code(await h.page(run),503,'SERVICE_BUSY');assert.equal((await h.api('GET',agentPaths.run(run.agentRunId))).status,200);assert.equal(h.executor.status().ordinary,1);
 const end=await agentHttpClient(h.base,END)('POST',agentPaths.end(run.agentRunId));assert.equal(end.status,202);await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');assert.equal(h.executor.status().ordinary,1);s.stop();await s.closed;assert.equal(h.executor.status().ordinary,1);gate.resolve(context);await pending;await until(()=>h.executor.status().ordinary===0);assert.equal((await h.page(run)).status,200);assert.equal(h.effects.length,0);
});
test('noncooperative event authentication retains only its independent auth admission after HTTP timeout',enabled,async t=>{
 const gate=deferred(),resolve=createApiKeyAuthenticator(credentials),h=await harness(t,{http:{maxAgentEventStreams:1,maxConcurrentRequests:1,maxAgentEndRequests:1,requestTimeoutMs:50},authenticate:({token})=>token===SLOW?gate.promise:resolve({token})}),{run}=await h.active();code(await h.page(run,undefined,{},SLOW),408,'REQUEST_TIMEOUT');code(await h.page(run),503,'SERVICE_BUSY');assert.equal((await h.api('GET',agentPaths.run(run.agentRunId))).status,200);assert.equal((await agentHttpClient(h.base,END)('POST',agentPaths.end(run.agentRunId))).status,202);gate.resolve({tenantId,scopes:['agents:read']});await until(async()=>((await h.page(run)).status===200));
});
test('ordinary HTTP authentication saturation leaves event replay and end admission available',enabled,async t=>{
 const gate=deferred(),entered=deferred(),resolve=createApiKeyAuthenticator(credentials),h=await harness(t,{http:{maxConcurrentRequests:1,maxAgentEventStreams:1,maxAgentEndRequests:1},authenticate:({token})=>{if(token===SLOW){entered.resolve();return gate.promise;}return resolve({token});}}),{run}=await h.active();const pending=agentHttpClient(h.base,SLOW)('GET',agentPaths.run(run.agentRunId));await entered.promise;assert.equal((await h.page(run)).status,200);assert.equal((await agentHttpClient(h.base,END)('POST',agentPaths.end(run.agentRunId))).status,202);gate.resolve({tenantId,scopes:['agents:read']});assert.equal((await pending).status,200);
});
test('new event connections reauthenticate revocation while an admitted reader ends within its finite observation window',enabled,async t=>{
 let allowed=true;const resolve=createApiKeyAuthenticator(credentials),h=await harness(t,{authenticate:({token})=>token===READ&&!allowed?null:resolve({token})}),{run}=await h.active(),s=await h.open({run});await until(()=>s.frames.some(f=>f.event==='agent'));allowed=false;const cursor=s.frames.filter(f=>f.event==='agent').at(-1).id;code(await h.page(run,cursor),401,'UNAUTHENTICATED');await s.closed;assert.equal(s.frames.at(-1).data.reason,'duration');assert.equal(h.executor.getRun(h.runRef(run)).state,'active');
});
test('a history gap arising during a pending HTTP write closes explicitly without jumping the last event id',enabled,async t=>{
 const held=deferred(),entered=deferred();let writes=0;
 const h=await harness(t,{http:{agentEventStream:{...streamOptions,maxDurationMs:3000,writeTimeoutMs:2500}},configure:server=>server.on('request',(req,res)=>{if(!req.url.endsWith('/events/stream'))return;const original=res.write.bind(res);res.write=(value,callback)=>{if(value.includes('event: agent')&&writes++===0)return original(value,error=>{entered.resolve();held.promise.then(()=>callback(error));});return original(value,callback);};})}),{run,context}=await h.active(),s=await h.open({run});await entered.promise;await h.generate(run,context,24);held.resolve();await s.closed;const events=s.frames.filter(f=>f.event==='agent'),gap=s.frames.at(-1);assert.equal(gap.event,'gap');assert.equal(gap.id,undefined);assert.equal(gap.data.after,events.at(-1).id);assert.equal(gap.data.missingHistory,true);assert.equal(s.frames.some(f=>f.event==='checkpoint'),false);
});
test('ledger identity loss closes an active event stream and never manufactures an end or success checkpoint',enabled,async t=>{
 const h=await harness(t),{run}=await h.active(),s=await h.open({run});await until(()=>s.frames.some(f=>f.event==='agent'));const moved=join(h.directory,'event-ledger-moved.sqlite');await rename(h.path,moved);await s.closed;assert.equal(s.frames.some(f=>f.event==='checkpoint'),false);assert.equal(h.effects.length,0);code(await h.page(run),503,'AGENT_STORAGE_UNAVAILABLE');await rename(moved,h.path);
});
test('a stalled real HTTP write destroys only the event reader, keeps end available and admits no second frame before settlement',enabled,async t=>{
 const entered=deferred();let lateCallback,writes=0;
 const h=await harness(t,{http:{maxAgentEventStreams:1,agentEventStream:{...streamOptions,writeTimeoutMs:100}},configure:server=>server.on('request',(req,res)=>{if(!req.url.endsWith('/events/stream'))return;const original=res.write.bind(res);res.write=(value,callback)=>{writes++;if(value.includes('event: agent'))return original(value,error=>{lateCallback=()=>callback(error);entered.resolve();});return original(value,callback);};})}),{run}=await h.active(),s=await h.open({run});await entered.promise;assert.equal(writes,2);code(await h.page(run),503,'SERVICE_BUSY');assert.equal((await agentHttpClient(h.base,END)('POST',agentPaths.end(run.agentRunId))).status,202);await s.closed;assert.equal(writes,2);assert.equal(s.frames.filter(f=>f.event==='agent').length,1);assert.equal(s.frames.some(f=>f.event==='checkpoint'),false);assert.equal((await h.page(run)).status,200);lateCallback();await new Promise(setImmediate);assert.equal(writes,2);
});
test('event request admission remains held until the actual HTTP response finish rather than the call to end',enabled,async t=>{
 const entered=deferred();let finish;
 const h=await harness(t,{http:{maxAgentEventStreams:1,agentEventStream:{...streamOptions,maxEvents:1,writeTimeoutMs:1000,maxDurationMs:2000}},configure:server=>server.on('request',(req,res)=>{if(!req.url.endsWith('/events/stream'))return;const original=res.end.bind(res);res.end=()=>{finish=original;entered.resolve();return res;};})}),{run}=await h.active(),s=await h.open({run});await entered.promise;code(await h.page(run),503,'SERVICE_BUSY');assert.equal((await h.api('GET',agentPaths.run(run.agentRunId))).status,200);finish();await s.closed;await until(async()=>((await h.page(run)).status===200));assert.equal(s.frames.at(-1).event,'checkpoint');
});
test('a cursor reconnects through a new HTTP server and actual SQLite close reopen with original event IDs intact',enabled,async t=>{
 const h=await harness(t),{run,context}=await h.active();await h.generate(run,context,2);h.executor.end(h.runRef(run));await until(()=>h.executor.getRun(h.runRef(run)).state==='closed');
 const original=[];let n=0;for(;;){const page=h.executor.events({...h.runRef(run),after:n});original.push(...page.events);n=page.nextCursor;if(!page.hasMore)break;}
 const cursor=agentEventCursor(run.agentRunId,4),identity=h.store.identity();await new Promise(resolve=>h.server.close(resolve));await h.executor.shutdown();await h.registry.shutdown();h.store.close();
 const store=new SqliteSessionStore({path:h.path}),providers=new Map([['test',h.provider]]),registry=new SessionRegistry({store,providers,defaultRegion:'test'}),executor=new DurableAgentExecutor({store,registry,providers,actionKey}),server=createSessionControlServer({registry,agentExecutor:executor,authenticate:createApiKeyAuthenticator(credentials),agentEventStream:{...streamOptions,maxDurationMs:100}});
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port,response=await fetch(base+path(run,true),{headers:{authorization:'Bearer '+READ,'last-event-id':cursor},signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);const text=await response.text(),events=text.split('\n\n').filter(x=>x.includes('event: agent\n')).map(x=>JSON.parse(x.split('\n').find(line=>line.startsWith('data: ')).slice(6)));assert.deepEqual(events,original.filter(e=>e.sequence>4));assert.deepEqual(store.identity(),identity);assert.equal(h.effects.length,2);assert.equal(h.counts().createCount,1);
 }finally{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await executor.shutdown();await registry.shutdown();store.close();}
});
test('backpressure requires both actual write callback and drain before another frame may be produced',async()=>{
 const writer=new EventEmitter(),controller=new AbortController();let callback,settled=false;writer.write=(value,cb)=>{callback=cb;return false;};writer.destroy=()=>{};const pending=writeAgentEventFrame(writer,'frame',controller.signal,1000).then(()=>{settled=true;});callback();await new Promise(setImmediate);assert.equal(settled,false);writer.emit('drain');await pending;cleanWriter(writer,controller.signal);
 const second=new EventEmitter();let cb;second.write=(value,callback)=>{cb=callback;return false;};second.destroy=()=>{};const p=writeAgentEventFrame(second,'frame',controller.signal,1000);second.emit('drain');let done=false;void p.then(()=>{done=true;});await new Promise(setImmediate);assert.equal(done,false);cb();await p;cleanWriter(second,controller.signal);
});
test('a stalled event write times out, destroys its reader and releases listeners while late callback cannot send more',async()=>{
 const writer=new EventEmitter(),controller=new AbortController();let callback,destroyed=0;writer.write=(value,cb)=>{callback=cb;return false;};writer.destroy=()=>{destroyed++;};const keepAlive=setTimeout(()=>{},1000);try{await assert.rejects(writeAgentEventFrame(writer,'frame',controller.signal,50),e=>e.code==='AGENT_EVENT_STREAM_STALLED');}finally{clearTimeout(keepAlive);}assert.equal(destroyed,1);cleanWriter(writer,controller.signal);callback();assert.equal(destroyed,1);
});
test('reader abort removes a pending write observer without claiming Source cancellation or waiting for a drain',async()=>{
 const writer=new EventEmitter(),controller=new AbortController();let callback;writer.write=(value,cb)=>{callback=cb;return false;};writer.destroy=()=>{throw Error('transport owner controls destruction');};const p=writeAgentEventFrame(writer,'frame',controller.signal,1000),reason=Error('reader disconnected');controller.abort(reason);await assert.rejects(p,e=>e===reason);cleanWriter(writer,controller.signal);callback();
});
