import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerPort,viewerNonce,viewerHello,readViewerHello,ViewerChannelError} from '../sdk/viewer-channel.mjs';
const pending=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
async function until(check){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Channel condition deadline');}
function pair(t,options={}){const raw=new MessageChannel(),channel=viewerNonce(),first=new ViewerPort({port:raw.port1,channel,handle:async(_method,data)=>data,...options.first}),second=new ViewerPort({port:raw.port2,channel,handle:async(_method,data)=>data,...options.second});t.after(()=>{first.close();second.close();});return {first,second,channel};}

test('actual MessagePort supports duplex requests, bounded notifications and isolated nonce bootstrap',async t=>{
 const events=[],p=pair(t,{second:{notify:(name,data)=>events.push({name,data})}});assert.equal(readViewerHello(viewerHello(p.channel)),p.channel);assert.equal(readViewerHello('{}'),null);assert.equal(readViewerHello('x'.repeat(17000)),null);assert.equal(viewerNonce().length,64);
 assert.deepEqual(await p.first.request('state',{value:1}),{value:1});assert.deepEqual(await p.second.request('state',{value:2}),{value:2});p.first.notify('state',{state:'paused'});await until(()=>events.length===1);assert.deepEqual(events[0],{name:'state',data:{state:'paused'}});assert.deepEqual(p.first.pending,{outgoing:0,incoming:0});
});

test('cancelled non-cooperative incoming handlers retain their admission until actual settlement',async t=>{
 const gate=pending(),started=pending();let calls=0,signal;const p=pair(t,{second:{maxPending:1,handle:async(_method,data,context)=>{calls++;signal=context.signal;started.resolve();await gate.promise;return data;}}});
 const controller=new AbortController(),first=p.first.request('state',{value:1},{signal:controller.signal});await started.promise;controller.abort();await assert.rejects(first,e=>e.code==='CHANNEL_ABORTED');await until(()=>signal.aborted);assert.equal(p.second.pending.incoming,1);
 await assert.rejects(p.first.request('state',{value:2}),e=>e.code==='CHANNEL_BUSY');assert.equal(calls,1);gate.resolve();await until(()=>p.second.pending.incoming===0);assert.deepEqual(await p.first.request('state',{value:3}),{value:3});assert.equal(calls,2);
});

test('request timeout cancels the receiver and late replies cannot affect a later request',async t=>{
 const gate=pending(),started=pending();let signal;const p=pair(t,{second:{handle:async(_method,data,context)=>{if(data===1){signal=context.signal;started.resolve();await gate.promise;}return data;}}});
 const result=p.first.request('state',1,{timeoutMs:50});await started.promise;await assert.rejects(result,e=>e.code==='CHANNEL_TIMEOUT');await until(()=>signal.aborted);assert.equal(await p.first.request('state',2),2);gate.resolve();await until(()=>p.second.pending.incoming===0);assert.equal(await p.first.request('state',3),3);
});

test('actual handler deadlines retain capacity and never disclose thrown handler errors',async t=>{
 const gate=pending();let calls=0;const p=pair(t,{second:{maxPending:1,requestTimeoutMs:50,handle:async()=>{calls++;await gate.promise;throw new Error('private-token-must-not-escape');}}});
 await assert.rejects(p.first.request('state',null),e=>e.code==='CHANNEL_TIMEOUT'&&!e.message.includes('private-token'));assert.equal(p.second.pending.incoming,1);await assert.rejects(p.first.request('state',null),e=>e.code==='CHANNEL_BUSY');assert.equal(calls,1);gate.resolve();await until(()=>p.second.pending.incoming===0);
 const other=pair(t,{second:{handle:()=>{throw new Error('private-token-must-not-escape');}}});await assert.rejects(other.first.request('state',null),e=>e.code==='CHANNEL_HANDLER_FAILED'&&!e.message.includes('private-token'));
});

test('outgoing capacity and pre-aborted requests allocate no extra handler work',async t=>{
 const gate=pending(),started=pending();let calls=0;const p=pair(t,{first:{maxPending:1},second:{handle:async()=>{calls++;started.resolve();await gate.promise;return true;}}});
 const current=p.first.request('state');await started.promise;await assert.rejects(p.first.request('state'),e=>e.code==='CHANNEL_BUSY');const controller=new AbortController();controller.abort();await assert.rejects(p.first.request('state',null,{signal:controller.signal}),e=>e.code==='CHANNEL_ABORTED');assert.equal(calls,1);gate.resolve();assert.equal(await current,true);
});

test('wrong nonce, oversized payload, unknown method and replayed request close before new work',async t=>{
 for(const make of [channel=>({protocol:1,channel:'f'.repeat(64),type:'request',id:1,method:'state',data:null}),channel=>'x'.repeat(17000),channel=>({protocol:1,channel,type:'request',id:1,method:'Runtime.evaluate',data:null})]){
  const raw=new MessageChannel(),channel=viewerNonce();let calls=0;const receiver=new ViewerPort({port:raw.port1,channel,handle:()=>{calls++;}});t.after(()=>{receiver.close();raw.port2.close();});raw.port2.postMessage(typeof make(channel)==='string'?make(channel):JSON.stringify(make(channel)));await until(()=>receiver.closed);assert.equal(calls,0);
 }
 const raw=new MessageChannel(),channel=viewerNonce(),gate=pending();let calls=0,signal;const receiver=new ViewerPort({port:raw.port1,channel,handle:async(_method,_data,context)=>{calls++;signal=context.signal;await gate.promise;}});t.after(()=>{receiver.close();raw.port2.close();gate.resolve();});const message=JSON.stringify({protocol:1,channel,type:'request',id:1,method:'state',data:null});raw.port2.postMessage(message);await until(()=>calls===1);raw.port2.postMessage(message);await until(()=>receiver.closed);assert.equal(signal.aborted,true);assert.equal(calls,1);
});

test('unknown future reply IDs are rejected and completed response replay cannot run work',async t=>{
 const raw=new MessageChannel(),channel=viewerNonce(),receiver=new ViewerPort({port:raw.port1,channel,handle:()=>null});t.after(()=>{receiver.close();raw.port2.close();});raw.port2.postMessage(JSON.stringify({protocol:1,channel,type:'reply',id:1,ok:true,value:null}));await until(()=>receiver.closed);
 const p=pair(t);await assert.rejects(p.first.request('state','x'.repeat(17000)),e=>e.code==='CHANNEL_PROTOCOL');assert.equal(p.first.closed,false);assert.equal(await p.first.request('state','valid'),'valid');
 const replay=new MessageChannel(),nonce=viewerNonce(),endpoint=new ViewerPort({port:replay.port1,channel:nonce,handle:()=>null});t.after(()=>{endpoint.close();replay.port2.close();});let requests=0;
 replay.port2.on('message',text=>{const message=JSON.parse(text);if(message.type==='request'){requests++;const response=JSON.stringify({protocol:1,channel:nonce,type:'reply',id:message.id,ok:true,value:message.data});replay.port2.postMessage(response);replay.port2.postMessage(response);}});
 assert.equal(await endpoint.request('state','first'),'first');assert.equal(await endpoint.request('state','second'),'second');assert.equal(requests,2);assert.equal(endpoint.closed,false);
});

test('idle and close propagation abort actual pending work and release both ports',async t=>{
 const raw=new MessageChannel(),channel=viewerNonce();let closed;const receiver=new ViewerPort({port:raw.port1,channel,handle:()=>null,heartbeatMs:50,idleTimeoutMs:100,onClose:error=>{closed=error.code;}});t.after(()=>{receiver.close();raw.port2.close();});await until(()=>receiver.closed);assert.equal(closed,'CHANNEL_TIMEOUT');
 const gate=pending(),started=pending();let signal;const p=pair(t,{second:{handle:async(_method,_data,context)=>{signal=context.signal;started.resolve();await gate.promise;return true;}}});const waiting=p.first.request('state');await started.promise;p.first.close();await assert.rejects(waiting,e=>e.code==='CHANNEL_CLOSED');await until(()=>p.second.closed);assert.equal(signal.aborted,true);gate.resolve();
});

test('invalid ports/options and application error codes have stable non-secret failures',()=>{
 assert.throws(()=>new ViewerPort({port:{},channel:viewerNonce(),handle(){}}),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(new ViewerChannelError('private-secret').code,'CHANNEL_HANDLER_FAILED');
});
