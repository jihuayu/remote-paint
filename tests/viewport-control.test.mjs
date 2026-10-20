import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ControlLease} from '../live/input.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,pending} from './fixtures/viewer-access-harness.mjs';
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('Viewport control deadline');}
function local(t,{resize}={}){
 const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1},latest:{},inputSeq:0}),messages=[],calls=[],cdp={send:async(method,params)=>calls.push({method,params}),detach:async()=>{}},control=new ControlLease(source,cdp),peer={id:'peer',ready:true,closed:false,send:message=>messages.push(message)};
 source.resize=resize??(async({width,height})=>{source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.emit('invalidate','viewport');});control.attach(peer);t.after(()=>control.close());return {source,messages,calls,cdp,control,peer};
}
const request=(control,grant,extra={})=>({type:'ResizeViewport',requestId:1,width:320,height:240,sessionId:control.sessionId,pageEpoch:1,viewportVersion:1,lease:grant.lease,...extra});

test('Source viewport response follows the applied barrier and revokes the old lease',async t=>{
 const f=local(t),grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1}),gate=pending(),started=pending(),original=f.source.resize;f.source.resize=async size=>{started.resolve();await gate.promise;await original(size);};
 try{const resize=f.control.handle(f.peer,request(f.control,grant));await started.promise;assert.equal(f.messages.some(m=>m.type==='ViewportResized'),false);assert.equal(f.source.viewportVersion,1);gate.resolve();await resize;const result=f.messages.find(m=>m.type==='ViewportResized');assert.deepEqual(result,{type:'ViewportResized',requestId:1,changed:true,pageEpoch:1,viewportVersion:2,viewport:{cssWidth:320,cssHeight:240,deviceScaleFactor:1}});await f.control.tail;assert.equal(f.control.mode,'agent');assert.equal(f.control.lease,null);assert.equal(f.control.viewportPending,null);}finally{gate.resolve();}
});

test('equal dimensions are an authoritative queued no-op and replay IDs are refused',async t=>{
 const f=local(t);let calls=0;f.source.resize=()=>{calls++;};const grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1});const message=request(f.control,grant,{width:100,height:100});await f.control.handle(f.peer,message);assert.equal(f.messages.at(-1).changed,false);assert.equal(calls,0);assert.equal(f.control.mode,'human');assert.equal(f.control.lease,grant.lease);await f.control.handle(f.peer,message);assert.deepEqual(f.messages.at(-1),{type:'ViewportResizeDenied',requestId:1,code:'STALE_VIEWPORT_REQUEST',outcome:'not-applied'});f.control.detach(f.peer.id);assert.equal(f.control.viewportRequests.size,0);
});

test('invalid schema, unsupported capability and stale tags cause no resize invocation',async t=>{
 const f=local(t);let calls=0;f.source.resize=()=>{calls++;};const grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1});
 const cases=[[{width:0},'INVALID_VIEWPORT_REQUEST'],[{height:4097},'INVALID_VIEWPORT_REQUEST'],[{width:1.5},'INVALID_VIEWPORT_REQUEST'],[{deviceScaleFactor:2},'INVALID_VIEWPORT_REQUEST'],[{requestId:'private'},'INVALID_VIEWPORT_REQUEST'],[{sessionId:'old'},'STALE_SESSION'],[{pageEpoch:2},'STALE_EPOCH'],[{viewportVersion:2},'STALE_VIEWPORT'],[{lease:'wrong'},'STALE_LEASE']];
 for(const [extra,code]of cases){await f.control.handle(f.peer,request(f.control,grant,extra));assert.equal(f.messages.at(-1).type,'ViewportResizeDenied');assert.equal(f.messages.at(-1).code,code);assert.equal(f.messages.at(-1).outcome,'not-applied');assert.ok(!JSON.stringify(f.messages.at(-1)).includes('private'));}f.source.resize=undefined;await f.control.handle(f.peer,request(f.control,grant));assert.equal(f.messages.at(-1).code,'UNSUPPORTED_VIEWPORT');assert.equal(calls,0);
});

test('queued viewport changes wait for prior input and revalidate revocation before dispatch',async t=>{
 const f=local(t),grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1}),gate=pending(),started=pending();let calls=0;f.source.resize=()=>{calls++;};f.cdp.send=async(method)=>{if(method==='Input.insertText'){started.resolve();await gate.promise;}};
 try{const input=f.control.input(f.peer.id,{...grant,seq:1,event:{kind:'text',text:'inflight'}});await started.promise;const resize=f.control.handle(f.peer,request(f.control,grant));await f.control.handle(f.peer,request(f.control,grant,{requestId:2}));assert.equal(f.messages.at(-1).code,'VIEWPORT_BUSY');assert.equal(calls,0);const revoke=f.control.revoke();gate.resolve();await input;await resize;await revoke;assert.equal(calls,0);assert.equal(f.messages.filter(m=>m.type==='ViewportResizeDenied').at(-1).code,'STALE_LEASE');assert.equal(f.control.mode,'agent');}finally{gate.resolve();}
});

test('disconnect cannot release an unsettled resize admission and late completion does not regrant',async t=>{
 const f=local(t),grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1}),gate=pending(),started=pending(),original=f.source.resize;
 f.source.resize=async size=>{started.resolve();await gate.promise;await original(size);};try{const work=f.control.resizeViewport(f.peer.id,request(f.control,grant));await started.promise;const admitted=f.control.viewportPending;f.control.detach(f.peer.id);assert.equal(f.control.viewportPending,admitted);assert.equal(f.control.viewportRequests.size,0);assert.equal(f.control.mode,'handoff');assert.throws(()=>f.control.agent({kind:'text',text:'wait'}),e=>e.code==='AGENT_PAUSED');gate.resolve();await work;await f.control.tail;assert.equal(f.control.viewportPending,null);assert.equal(f.control.mode,'agent');assert.equal(f.control.holder,null);}finally{gate.resolve();}
});

for(const effect of ['throw','supersede'])test(`failure after entering Source resize (${effect}) reports unknown and hides diagnostics`,async t=>{
 const f=local(t),grant=await f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1});f.source.resize=async()=>{if(effect==='throw'){f.source.viewport.cssWidth=320;throw new Error('private-endpoint-key');}};await f.control.handle(f.peer,request(f.control,grant));assert.deepEqual(f.messages.find(m=>m.type==='ViewportResizeDenied'),{type:'ViewportResizeDenied',requestId:1,code:effect==='throw'?'VIEWPORT_RESIZE_FAILED':'VIEWPORT_SUPERSEDED',outcome:'unknown'});assert.ok(!JSON.stringify(f.messages).includes('private-endpoint-key'));await f.control.tail;assert.equal(f.control.mode,'agent');assert.equal(f.control.lease,null);
});

test('public controller uses actual HTTP/WebSocket capability, lease and applied reply',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t);let calls=0;h.source.resize=async({width,height})=>{calls++;h.source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};h.source.viewportVersion++;h.source.emit('invalidate','viewport');};const ticket=await h.issue('controller'),client=await h.connect(ticket),welcome=await client.wait(m=>m.type==='Welcome');assert.equal(welcome.viewportControl,true);client.ws.send(JSON.stringify({type:'AcquireControl',sessionId:welcome.sessionId,pageEpoch:1,viewportVersion:1}));const grant=await client.wait(m=>m.type==='ControlGranted');client.ws.send(JSON.stringify(request(h.source.control,grant)));const applied=await client.wait(m=>m.type==='ViewportResized');assert.equal(applied.viewportVersion,2);assert.equal(applied.viewport.cssWidth,320);assert.equal(calls,1);assert.equal(h.source.control.lease,null);
});

test('readonly public ticket cannot send viewport requests or advertise viewport control',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t);let calls=0;h.source.resize=async()=>{calls++;};const ticket=await h.issue(),client=await h.connect(ticket),welcome=await client.wait(m=>m.type==='Welcome');assert.equal(welcome.viewportControl,false);const closed=once(client.ws,'close');client.ws.send(JSON.stringify({type:'ResizeViewport',requestId:1,width:320,height:200,sessionId:welcome.sessionId,pageEpoch:1,viewportVersion:1,lease:'forged'}));assert.equal((await closed)[0],1008);assert.equal(calls,0);assert.equal(h.source.control.mode,'agent');
});
