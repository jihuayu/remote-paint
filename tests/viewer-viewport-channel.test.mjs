import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerPort,ViewerChannelError,viewerNonce} from '../sdk/viewer-channel.mjs';
import {ViewerViewportError} from '../sdk/viewer-control.mjs';
const pending=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('Viewport channel deadline');}
function pair(t,options={}){const raw=new MessageChannel(),channel=viewerNonce(),a=new ViewerPort({port:raw.port1,channel,handle:()=>null,...options.a}),b=new ViewerPort({port:raw.port2,channel,handle:()=>null,...options.b});t.after(()=>{a.close();b.close();});return {a,b};}
for(const outcome of ['not-applied','unknown'])test(`finite viewport error reply preserves ${outcome} over actual MessagePort`,async t=>{
 const p=pair(t,{b:{handle:()=>{throw new ViewerViewportError('VIEWER_VIEWPORT_FAILED',outcome);}}});await assert.rejects(p.a.request('resize-viewport',{width:320,height:240,timeoutMs:5000}),e=>e instanceof ViewerViewportError&&e instanceof ViewerChannelError&&e.code==='VIEWER_VIEWPORT_FAILED'&&e.outcome===outcome&&!e.message.includes('private'));assert.equal(p.a.closed,false);
});
test('viewport pre-abort, local size failure and closed transport are known not-applied',async t=>{
 const p=pair(t),abort=new AbortController();abort.abort();await assert.rejects(p.a.request('resize-viewport',null,{signal:abort.signal}),e=>e.code==='CHANNEL_ABORTED'&&e.outcome==='not-applied');await assert.rejects(p.a.request('resize-viewport','x'.repeat(17000)),e=>e.code==='CHANNEL_PROTOCOL'&&e.outcome==='not-applied');p.a.close();await assert.rejects(p.a.request('resize-viewport'),e=>e.code==='CHANNEL_CLOSED'&&e.outcome==='not-applied');
});
for(const reason of ['abort','timeout','close'])test(`viewport ${reason} after dispatch has unknown outcome and keeps actual incoming admission`,async t=>{
 const gate=pending(),started=pending();let signal;const p=pair(t,{b:{maxPending:1,handle:async(_method,data,context)=>{signal=context.signal;started.resolve();await gate.promise;return data;}}}),abort=new AbortController();
 try{const operation=p.a.request('resize-viewport',null,{signal:abort.signal,timeoutMs:reason==='timeout'?50:5000}),rejected=assert.rejects(operation,e=>e.outcome==='unknown'&&e.code===(reason==='abort'?'CHANNEL_ABORTED':reason==='timeout'?'CHANNEL_TIMEOUT':'CHANNEL_CLOSED'));await started.promise;if(reason==='abort')abort.abort();if(reason==='close')p.a.close();await rejected;await until(()=>signal.aborted);if(reason!=='close'){assert.equal(p.b.pending.incoming,1);await assert.rejects(p.a.request('resize-viewport'),e=>e.code==='CHANNEL_BUSY'&&e.outcome==='not-applied');}gate.resolve();if(reason!=='close'){await until(()=>p.b.pending.incoming===0);assert.equal(await p.a.request('state'),null);}}finally{gate.resolve();}
});
test('arbitrary handler diagnostics cannot claim a known viewport outcome',async t=>{
 const p=pair(t,{b:{handle:()=>{throw Object.assign(new Error('private-token'),{code:'VIEWER_VIEWPORT_FAILED',outcome:'not-applied',details:'private'});}}});await assert.rejects(p.a.request('resize-viewport'),e=>e.code==='VIEWER_VIEWPORT_FAILED'&&e.outcome==='unknown'&&!e.message.includes('private'));
});
test('receiver deadline and local/remote admission refusal retain exact viewport outcomes',async t=>{
 const gate=pending(),started=pending();let calls=0;const p=pair(t,{a:{maxPending:1},b:{maxPending:1,requestTimeoutMs:50,handle:async()=>{calls++;started.resolve();await gate.promise;return true;}}});
 try{const operation=p.a.request('resize-viewport'),rejected=assert.rejects(operation,e=>e.code==='CHANNEL_TIMEOUT'&&e.outcome==='unknown');await started.promise;await assert.rejects(p.a.request('resize-viewport'),e=>e.code==='CHANNEL_BUSY'&&e.outcome==='not-applied');await rejected;assert.equal(p.b.pending.incoming,1);await assert.rejects(p.a.request('resize-viewport'),e=>e.code==='CHANNEL_BUSY'&&e.outcome==='not-applied');assert.equal(calls,1);gate.resolve();await until(()=>p.b.pending.incoming===0);}finally{gate.resolve();}
});
test('a real late viewport error reply is ignored without retaining an unbounded request history',async t=>{
 const raw=new MessageChannel(),channel=viewerNonce(),endpoint=new ViewerPort({port:raw.port1,channel,handle:()=>null}),started=pending();let id;
 t.after(()=>{endpoint.close();raw.port2.close();});raw.port2.on('message',text=>{const m=JSON.parse(text);if(m.type==='request'&&m.method==='resize-viewport'){id=m.id;started.resolve();}else if(m.type==='request')raw.port2.postMessage(JSON.stringify({protocol:1,channel,type:'reply',id:m.id,ok:true,value:true}));});
 const abort=new AbortController(),operation=endpoint.request('resize-viewport',null,{signal:abort.signal}),rejected=assert.rejects(operation,e=>e.outcome==='unknown');await started.promise;abort.abort();await rejected;raw.port2.postMessage(JSON.stringify({protocol:1,channel,type:'reply',id,ok:false,code:'VIEWER_VIEWPORT_FAILED',outcome:'unknown'}));assert.equal(await endpoint.request('state'),true);assert.equal(endpoint.closed,false);assert.deepEqual(endpoint.pending,{incoming:0,outgoing:0});
});
test('typed error outcome accessors are never invoked by serialization',async t=>{
 let getter=false;const p=pair(t,{b:{handle:()=>{const error=new ViewerViewportError('VIEWER_VIEWPORT_FAILED','not-applied');Object.defineProperty(error,'outcome',{get(){getter=true;throw new Error('private');}});throw error;}}});await assert.rejects(p.a.request('resize-viewport'),e=>e.outcome==='unknown'&&e.code==='VIEWER_VIEWPORT_FAILED');assert.equal(getter,false);
});
test('invalid viewport reply outcomes close before delivery while late finite replies remain harmless',async t=>{
 for(const extra of [{outcome:'rolled-back'},{outcome:'unknown',private:'must-not-escape'},{}]){
  const raw=new MessageChannel(),channel=viewerNonce(),endpoint=new ViewerPort({port:raw.port1,channel,handle:()=>null});t.after(()=>{endpoint.close();raw.port2.close();});raw.port2.on('message',text=>{const m=JSON.parse(text);if(m.type==='request')raw.port2.postMessage(JSON.stringify({protocol:1,channel,type:'reply',id:m.id,ok:false,code:'VIEWER_VIEWPORT_FAILED',...extra}));});await assert.rejects(endpoint.request('resize-viewport'),e=>e.code==='CHANNEL_PROTOCOL'&&e.outcome==='unknown');assert.equal(endpoint.closed,true);
 }
 const generic=new MessageChannel(),nonce=viewerNonce(),receiver=new ViewerPort({port:generic.port1,channel:nonce,handle:()=>null});t.after(()=>{receiver.close();generic.port2.close();});generic.port2.on('message',text=>{const m=JSON.parse(text);if(m.type==='request')generic.port2.postMessage(JSON.stringify({protocol:1,channel:nonce,type:'reply',id:m.id,ok:false,code:'CHANNEL_BUSY',outcome:'unknown'}));});await assert.rejects(receiver.request('state'),e=>e.code==='CHANNEL_PROTOCOL'&&!Object.hasOwn(e,'outcome'));assert.equal(receiver.closed,true);
 const gate=pending(),started=pending(),p=pair(t,{b:{handle:async method=>{if(method==='resize-viewport'){started.resolve();await gate.promise;throw new ViewerViewportError('VIEWER_VIEWPORT_FAILED','unknown');}return true;}}}),abort=new AbortController(),operation=p.a.request('resize-viewport',null,{signal:abort.signal}),rejected=assert.rejects(operation,e=>e.outcome==='unknown');await started.promise;abort.abort();await rejected;gate.resolve();await until(()=>p.b.pending.incoming===0);assert.equal(await p.a.request('state'),true);assert.equal(p.a.closed,false);
});
