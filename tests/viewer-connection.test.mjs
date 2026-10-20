import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {ViewerTicketSource,ViewerConnection,ViewerConnectionError} from '../sdk/viewer-connection.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,renderer,pending,flush} from './fixtures/viewer-access-harness.mjs';
const enabled={skip:!sessionStoreSupported};
const settings={gatewayOrigin:'https://gateway.example',audience,sessionId:'ses_fixture',role:'readonly'};
function ticket(extra={}){const value='vwt1.'+'a'.repeat(43);return {grantId:'vgr_'+randomUUID(),sessionId:'ses_fixture',version:'v1',role:'readonly',audience,expiresAt:new Date(Date.now()+60000).toISOString(),ticket:value,streamPath:'/v1/viewer/stream?ticket='+value,...extra};}
async function until(predicate){for(let i=0;i<400;i++){if(predicate())return;await delay(5);}assert.fail('Condition deadline');}
function network(t,h,{getTicket,onSocket,hello={},...options}={}){
 const states=[],errors=[],sockets=[],messages=[],requests=[];
 class PublicSocket extends WebSocket {constructor(url){super(url,{origin:audience});sockets.push(this);}}
 const connection=new ViewerConnection({gatewayOrigin:h.base,audience,sessionId:h.sessionId,role:'readonly',WebSocket:PublicSocket,
  getTicket:async request=>{requests.push({reason:request.reason,previousGrantId:request.previousGrantId});if(getTicket)return getTicket(request);if(request.previousGrantId){const r=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{}});assert.equal(r.status,200,r.text);return r.data;}return h.issue();},
  onState:state=>states.push(state),onError:error=>errors.push(error),onSocket:(socket,grant,control)=>{
   socket.onopen=()=>socket.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:['control-channel-v1','input-feedback-v1'],...hello}));
   socket.onmessage=event=>{const message=JSON.parse(event.data);try{if(message.type==='Welcome')control.acceptWelcome(message);if(message.type==='FrameCommit')socket.send(JSON.stringify({type:'FrameAck',frameId:message.frameId,pageEpoch:message.pageEpoch}));messages.push(message);}catch{socket.close(4008,'Viewer rejected handshake');}};
   onSocket?.(socket,grant,control);
  },...options});
 t.after(()=>connection.destroy());return {connection,states,errors,sockets,messages,requests};
}

test('browser ticket source validates fixed destination and identity without accepting backend keys or accessor configuration',async()=>{
 let read=false;
 for(const config of [{...settings,apiKey:'private-backend-key'},{...settings,gatewayOrigin:'https://gateway.example/path'},{...settings,audience:'*'},{...settings,role:'agent'},{...settings,sessionId:{toString(){read=true;return 'ses_fixture';}}},Object.defineProperty({...settings},'getTicket',{get(){read=true;return ()=>ticket();},enumerable:true})])assert.throws(()=>new ViewerTicketSource(Object.defineProperties({getTicket:()=>ticket()},Object.getOwnPropertyDescriptors(config))),ViewerConnectionError);
 assert.equal(read,false);
 const source=new ViewerTicketSource({...settings,getTicket:()=>ticket()});const grant=await source.getTicket();assert.equal(source.settings.version,'v1');assert.ok(Object.isFrozen(grant));assert.ok(!JSON.stringify(source.settings).includes(grant.ticket));source.destroy();await assert.rejects(source.getTicket(),e=>e.code==='VIEWER_CLOSED');
});

test('ticket grant path, role, audience, Session, version, expiry and fields cannot be changed by a callback',async()=>{
 for(const extra of [{sessionId:'ses_other'},{audience:'https://other.example'},{role:'controller'},{ticket:'backend_api_key_00000000000000000000000'},{streamPath:'/v1/viewer/stream?ticket=other'},{expiresAt:new Date(0).toISOString()},{apiKey:'secret'},{grantId:{toString(){throw new Error('must not coerce');}}}]){
  const source=new ViewerTicketSource({...settings,getTicket:()=>ticket(extra)});await assert.rejects(source.getTicket(),e=>e.code==='VIEWER_INVALID_TICKET');source.destroy();
 }
 let calls=0;const source=new ViewerTicketSource({...settings,getTicket:()=>ticket({version:++calls===1?'v1':'v2'})});await source.getTicket();await assert.rejects(source.getTicket(),e=>e.code==='VIEWER_INVALID_TICKET');source.destroy();
});

test('a timed out or aborted non-cooperative ticket callback retains one admission and late credentials are discarded',async()=>{
 const gate=pending();let calls=0;const source=new ViewerTicketSource({...settings,requestTimeoutMs:50,getTicket:()=>{calls++;return gate.promise;}});
 await assert.rejects(source.getTicket(),e=>e.code==='VIEWER_TICKET_TIMEOUT');assert.equal(source.busy,true);await assert.rejects(source.getTicket(),e=>e.code==='VIEWER_TICKET_BUSY');assert.equal(calls,1);gate.resolve(ticket());await flush();assert.equal(source.busy,false);assert.equal(source.settings.version,undefined);source.destroy();
 const second=pending(),abort=new AbortController(),s=new ViewerTicketSource({...settings,getTicket:()=>second.promise}),request=s.getTicket({signal:abort.signal});abort.abort();await assert.rejects(request,e=>e.code==='VIEWER_ABORTED');second.resolve(ticket());await flush();s.destroy();
});

test('callback exceptions and error codes are redacted and consecutive callback retries are finite',enabled,async t=>{
 const h=await fixture(t),n=network(t,h,{maxRetries:1,getTicket:()=>{throw new Error('private-url?apiKey=must-not-escape');}});await n.connection.start();await until(()=>n.connection.state.state==='failed');assert.equal(n.requests.length,2);assert.equal(n.sockets.length,0);assert.equal(n.errors[0].code,'VIEWER_TICKET_UNAVAILABLE');assert.ok(!JSON.stringify([n.states,n.errors]).includes('must-not-escape'));assert.equal(new ViewerConnectionError('private-key').code,'VIEWER_TICKET_UNAVAILABLE');
});

test('real public Viewer connection checks server-selected Session/version/grant/role and can stop and resume',enabled,async t=>{
 const h=await fixture(t),n=network(t,h);await n.connection.start();await until(()=>n.messages.some(m=>m.type==='FrameCommit'));const welcome=n.messages.find(m=>m.type==='Welcome');assert.equal(welcome.viewerSessionId,h.sessionId);assert.equal(welcome.viewerRole,'readonly');assert.equal(n.connection.state.state,'connected');assert.equal(welcome.control,null);assert.equal(welcome.input,false);
 n.connection.stop();assert.equal(n.connection.state.state,'paused');await n.connection.start();await until(()=>n.requests.length===2&&n.connection.state.state==='connected');assert.equal(n.requests[1].previousGrantId,welcome.viewerGrantId);assert.ok(!JSON.stringify(n.states).includes(h.transport.key));
});

test('automatic pre-expiry refresh uses the previous grant, revokes old access and keeps the original Session',enabled,async t=>{
 const h=await fixture(t,{accessOptions:{maxGrants:1}}),n=network(t,h,{getTicket:async request=>{if(!request.previousGrantId)return h.issue('readonly',{ttlSeconds:1});const response=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{ttlSeconds:1}});assert.equal(response.status,200,response.text);return response.data;}});
 await n.connection.start();await until(()=>n.messages.filter(m=>m.type==='Welcome').length>=2);const welcomes=n.messages.filter(m=>m.type==='Welcome');assert.equal(n.requests[1].reason,'refresh');assert.equal(n.requests[1].previousGrantId,welcomes[0].viewerGrantId);assert.notEqual(welcomes[1].viewerGrantId,welcomes[0].viewerGrantId);assert.equal(welcomes[1].viewerSessionId,h.sessionId);assert.equal(n.connection.state.state,'connected');
 const old=new URL(n.sockets[0].url);assert.equal(await h.denied(old.pathname+old.search),403);assert.ok(h.resolutions.length>=2);
});

test('explicit revocation is terminal and never silently asks the application for fresh access',enabled,async t=>{
 const h=await fixture(t),n=network(t,h);await n.connection.start();await until(()=>n.messages.some(m=>m.type==='Welcome'));const id=n.messages.find(m=>m.type==='Welcome').viewerGrantId;assert.equal((await h.api(h.tickets+'/'+id,{method:'DELETE'})).status,200);await until(()=>n.connection.state.state==='failed');assert.equal(n.errors[0].code,'VIEWER_ACCESS_ENDED');await delay(300);assert.equal(n.requests.length,1);
});

test('upstream protocol rejection preserves its safe terminal close code without leaking the private reason',enabled,async t=>{
 const h=await fixture(t),n=network(t,h,{hello:{renderer:{...renderer,wasmSha256:'bad'}}});await n.connection.start();await until(()=>n.connection.state.state==='failed');assert.equal(n.errors[0].code,'VIEWER_ACCESS_ENDED');assert.equal(n.requests.length,1);assert.ok(!JSON.stringify(n.errors).includes(h.transport.key));
});

test('a transient Source close reconnects through a fresh grant and the actual Node data plane',enabled,async t=>{
 const h=await fixture(t),n=network(t,h);await n.connection.start();await until(()=>n.messages.some(m=>m.type==='FrameCommit'));[...h.transport.peers][0].close(1013,'private-reason-must-not-escape');await until(()=>n.messages.filter(m=>m.type==='Welcome').length===2);assert.equal(n.requests[1].reason,'reconnect');assert.equal(n.connection.state.state,'connected');assert.ok(!JSON.stringify(n.states).includes('private-reason'));
});

test('stop/destroy during a slow ticket callback cannot create a late WebSocket',enabled,async t=>{
 const gate=pending(),started=pending(),h=await fixture(t),n=network(t,h,{maxRetries:0,getTicket:async()=>{started.resolve();await gate.promise;return h.issue();}});const starting=n.connection.start();await started.promise;n.connection.stop();await starting;gate.resolve();await delay(25);assert.equal(n.sockets.length,0);assert.equal(h.resolutions.length,0);assert.equal(n.connection.state.state,'paused');n.connection.destroy();n.connection.destroy();assert.equal(n.connection.state.state,'closed');assert.throws(()=>n.connection.start(),e=>e.code==='VIEWER_CLOSED');
});

test('missing Welcome has a bounded handshake deadline and bounded fresh-ticket retry count',enabled,async t=>{
 const h=await fixture(t),n=network(t,h,{connectTimeoutMs:50,maxRetries:1,onSocket:socket=>{socket.onopen=()=>{};}});await n.connection.start();await until(()=>n.connection.state.state==='failed');assert.equal(n.errors[0].code,'VIEWER_HANDSHAKE_TIMEOUT');assert.equal(n.requests.length,2);assert.equal(n.sockets.length,2);await delay(100);assert.equal(n.requests.length,2);
});

test('public Welcome identity mismatch closes before the renderer can mark the connection ready',enabled,async t=>{
 const h=await fixture(t),n=network(t,h,{onSocket:(socket,grant,control)=>{socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.type==='Welcome'){assert.throws(()=>control.acceptWelcome({...message,viewerSessionId:'ses_other'}),e=>e.code==='VIEWER_PROTOCOL_ERROR');socket.close(4008,'Viewer rejected handshake');}};}});await n.connection.start();await until(()=>n.connection.state.state==='failed');assert.equal(n.errors[0].code,'VIEWER_PROTOCOL_ERROR');assert.equal(n.requests.length,1);assert.ok(!n.states.some(s=>s.state==='connected'));
});
