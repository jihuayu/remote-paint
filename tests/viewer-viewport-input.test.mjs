import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerInput} from '../viewer/input.mjs';
import {createViewer} from '../sdk/viewer.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
import {dom} from './fixtures/viewer-dom-harness.mjs';
import {wasmSha256} from './fixtures/viewer-runtime-harness.mjs';

const frame={pageEpoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1},lastProcessedInputSeq:0};
const grant={type:'ControlGranted',lease:'a'.repeat(48),feedbackEpoch:2,nextSeq:1,expiresAt:Date.now()+30000,pageEpoch:1,viewportVersion:1};
const applied=(extra={})=>({type:'ViewportResized',requestId:1,changed:true,pageEpoch:1,viewportVersion:2,viewport:{cssWidth:320,cssHeight:240,deviceScaleFactor:1},...extra});
function inputHarness(t,{capability=true}={}){
 const prior=globalThis.window;globalThis.window={addEventListener(){}};
 const element=()=>({addEventListener(){},blur(){},value:'',textContent:'',disabled:false});
 const sent=[],input=new ViewerInput({canvas:element(),proxy:element(),button:element(),label:element(),send:message=>sent.push(message)});
 input.welcome({input:true,inputFeedback:true,viewportControl:capability,sessionId:'s',peerId:'p'});input.display(frame);input.message(grant);
 t.after(()=>{input.reset();globalThis.window=prior;});return {input,sent};
}
const key={kind:'key',type:'keyDown',key:'a',code:'KeyA',text:'a'};
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(5);}assert.fail('Viewport input condition deadline');}

test('finite viewport admission rejects invalid data without getters or input side effects',async t=>{
 const {input,sent}=inputHarness(t);let getter=false;const bad=[null,[],{width:0,height:2},{width:2.5,height:2},{width:2,height:4097},{width:2,height:2,deviceScaleFactor:2},{width:2,height:2,[Symbol()]:1},Object.create({width:2,height:2}),Object.defineProperty({height:2},'width',{enumerable:true,get(){getter=true;return 2;}})];
 for(const value of bad)await assert.rejects(input.resizeViewport(value),e=>e.code==='INVALID_VIEWPORT_REQUEST'&&e.outcome==='not-applied');
 assert.equal(getter,false);assert.equal(sent.length,0);assert.equal(input.active,true);
 input.viewportEnabled=false;await assert.rejects(input.resizeViewport({width:2,height:2}),e=>e.code==='UNSUPPORTED_VIEWPORT'&&e.outcome==='not-applied');assert.equal(input.active,true);assert.equal(sent.length,0);
});

test('resize pauses old input, drops queued state and suppresses renewal grants through applied acknowledgement',async t=>{
 const {input,sent}=inputHarness(t);input.push(key);input.push(key);const next=input.nextSeq;
 const resizing=input.resizeViewport({width:320,height:240});assert.equal(input.active,false);assert.equal(input.pending.size,0);assert.equal(input.queue.length,0);
 assert.deepEqual(sent.at(-1),{type:'ResizeViewport',requestId:1,width:320,height:240,sessionId:'s',pageEpoch:1,viewportVersion:1,lease:grant.lease});
 assert.equal(input.requestControl(),false);assert.equal(input.releaseControl(),false);input.push(key);input.message(grant);input.message({type:'InputAck',seq:1,accepted:true});assert.equal(input.active,false);assert.equal(sent.filter(m=>m.type==='ReleaseControl').length,0);
 await assert.rejects(input.resizeViewport({width:400,height:300}),e=>e.code==='VIEWPORT_BUSY'&&e.outcome==='not-applied');
 input.message({type:'ControlState',mode:'handoff',holder:null,pageEpoch:1,viewportVersion:2});input.message(applied());const result=await resizing;
 assert.deepEqual(result,applied());assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.viewport));assert.equal(input.active,false);input.message(grant);assert.equal(input.active,false);assert.equal(input.requestControl(),false);
 input.message({type:'ControlState',mode:'agent',holder:null,pageEpoch:1,viewportVersion:2});input.display({...frame,viewportVersion:2,viewport:result.viewport});assert.equal(input.requestControl(),true);assert.equal(sent.at(-1).type,'AcquireControl');assert.ok(next>1);
});

test('authoritative noop retains the lease but waits for renewal and preserves the sent sequence floor',async t=>{
 const {input,sent}=inputHarness(t);input.push(key);input.push(key);const resizing=input.resizeViewport({width:100,height:100});input.message(grant);
 input.message(applied({changed:false,viewportVersion:1,viewport:frame.viewport}));const result=await resizing;assert.equal(result.changed,false);assert.equal(input.active,false);assert.deepEqual(sent.at(-1),{type:'RenewControl',sessionId:'s',pageEpoch:1,viewportVersion:1,lease:grant.lease});
 input.message(grant);assert.equal(input.active,true);input.push(key);assert.equal(sent.at(-1).seq,3);assert.equal(sent.filter(m=>m.type==='ReleaseControl').length,0);
});

for(const outcome of ['not-applied','unknown'])test(`a fixed Source denial (${outcome}) keeps input stopped and hides arbitrary diagnostics`,async t=>{
 const {input,sent}=inputHarness(t),resizing=input.resizeViewport({width:320,height:240}),rejected=assert.rejects(resizing,e=>e.code==='VIEWPORT_RESIZE_FAILED'&&e.outcome===outcome&&e.message==='VIEWPORT_RESIZE_FAILED');
 input.message({type:'ViewportResizeDenied',requestId:1,code:'VIEWPORT_RESIZE_FAILED',outcome});await rejected;input.message(grant);assert.equal(input.active,false);assert.equal(sent.filter(m=>m.type==='ReleaseControl').length,outcome==='not-applied'?1:0);
});

test('reset and welcome reject an in-flight resize as unknown and late old acknowledgements do not mutate state',async t=>{
 const {input}=inputHarness(t),resizing=input.resizeViewport({width:320,height:240}),rejected=assert.rejects(resizing,e=>e.code==='VIEWPORT_CONNECTION_LOST'&&e.outcome==='unknown');input.reset();await rejected;input.message(applied());input.message(grant);assert.equal(input.active,false);
 input.welcome({input:true,viewportControl:true,sessionId:'new',peerId:'new'});input.display(frame);input.message({...grant,lease:'b'.repeat(48)});assert.equal(input.active,true);assert.equal(input.viewportRequestId,0);
});

test('sending failure reports unknown and cannot leave a usable old lease',async t=>{
 const {input}=inputHarness(t);input.send=()=>{throw new Error('private-socket-error');};await assert.rejects(input.resizeViewport({width:320,height:240}),e=>e.code==='VIEWPORT_CONNECTION_LOST'&&e.outcome==='unknown'&&!e.message.includes('private'));assert.equal(input.active,false);assert.equal(input.viewportPending,null);input.message(grant);assert.equal(input.active,false);assert.equal(input.requestControl(),false);
});

test('a resumed noop uses the next request ID and a retired acknowledgement cannot settle it',async t=>{
 const {input,sent}=inputHarness(t),first=input.resizeViewport({width:100,height:100});input.message(applied({changed:false,viewportVersion:1,viewport:frame.viewport}));await first;input.message(grant);
 const second=input.resizeViewport({width:320,height:240});assert.equal(sent.at(-1).requestId,2);input.message(applied({requestId:1,changed:false,viewportVersion:1,viewport:frame.viewport}));assert.equal(input.viewportPending.requestId,2);input.message(applied({requestId:2}));assert.equal((await second).requestId,2);
});

test('matching malformed replies fail closed and unexpected or retired request IDs cannot settle a new request',async t=>{
 const {input}=inputHarness(t),resizing=input.resizeViewport({width:320,height:240}),rejected=assert.rejects(resizing,e=>e.code==='VIEWPORT_PROTOCOL'&&e.outcome==='unknown');
 assert.equal(input.message(applied({requestId:0})),true);assert.equal(input.viewportPending.requestId,1);
 assert.throws(()=>input.message(applied({viewport:{cssWidth:321,cssHeight:240,deviceScaleFactor:1}})),e=>e.code==='VIEWPORT_PROTOCOL');await rejected;assert.equal(input.active,false);input.message(grant);assert.equal(input.active,false);
});

for(const variant of ['extra','future','code','outcome','noop-version'])test(`viewport reply schema refuses ${variant}`,async t=>{
 const {input}=inputHarness(t),resizing=input.resizeViewport({width:320,height:240}),rejected=assert.rejects(resizing,e=>e.code==='VIEWPORT_PROTOCOL'&&e.outcome==='unknown');
 const message=variant==='extra'?applied({private:'no-leak'}):variant==='future'?applied({requestId:2}):variant==='code'?{type:'ViewportResizeDenied',requestId:1,code:'private-error',outcome:'not-applied'}:variant==='outcome'?{type:'ViewportResizeDenied',requestId:1,code:'VIEWPORT_BUSY',outcome:'success'}:applied({changed:false});
 assert.throws(()=>input.message(message),e=>e.code==='VIEWPORT_PROTOCOL'&&!e.message.includes('private'));await rejected;assert.equal(input.active,false);
});

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} viewport path uses actual Source acknowledgement and neutralizes held keys`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)});let resizeCalls=0;const gate=pending(),started=pending();
 h.source.resize=async({width,height})=>{resizeCalls++;started.resolve();await gate.promise;h.source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};h.source.viewportVersion++;h.source.emit('invalidate','viewport');};
 const d=dom(h,{workerMode,realInput:true}),viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,role:'controller',getTicket:()=>h.issue('controller')});t.after(()=>viewer.destroy());
 try{
  await viewer.connect();await until(()=>d.runtimes.at(-1).window.remotePaintResult?.frameId===1);await until(()=>viewer.control.mode==='agent');await viewer.takeControl();const input=d.runtimes.at(-1).stats.input,lease=h.source.control.lease;
  input.push(key);await until(()=>h.source.control.keys.size===1);const next=input.nextSeq,noop=input.resizeViewport({width:100,height:100});assert.equal(input.active,false);const unchanged=await noop;assert.equal(unchanged.changed,false);await until(()=>input.active);assert.equal(h.source.control.lease,lease);assert.equal(h.source.control.keys.size,0);assert.equal(input.nextSeq,next);assert.equal(resizeCalls,0);
  input.push(key);await until(()=>h.source.control.keys.size===1);let settled=false;const changing=input.resizeViewport({width:320,height:240}).then(value=>{settled=true;return value;});await started.promise;assert.equal(settled,false);assert.equal(input.active,false);assert.equal(h.source.control.keys.size,0);assert.equal(resizeCalls,1);gate.resolve();const changed=await changing;assert.equal(changed.changed,true);assert.equal(changed.viewportVersion,2);await until(()=>h.source.control.mode==='agent');assert.equal(input.active,false);assert.equal(input.requestControl(),false);assert.equal(h.source.control.lease,null);
  // DOM/CanvasKit and Source.resize/CDP are explicit fixtures. No new pixels
  // are claimed by this actual HTTP/WS/SQLite/ControlLease protocol proof.
 }finally{gate.resolve();await viewer.destroy();await until(()=>h.transport.peers.size===0);}
});

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} malformed viewport reply closes the old public connection`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)});h.source.resize=async()=>{};
 const handle=h.source.control.handle;h.source.control.handle=async function(peer,message){if(message.type==='ResizeViewport'){peer.send(applied({requestId:message.requestId+1}));return;}return handle.call(this,peer,message);};
 const d=dom(h,{workerMode,realInput:true}),viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,role:'controller',getTicket:()=>h.issue('controller')});t.after(()=>viewer.destroy());
 await viewer.connect();await until(()=>d.runtimes.at(-1).window.remotePaintResult?.frameId===1);await until(()=>viewer.control.mode==='agent');await viewer.takeControl();const input=d.runtimes.at(-1).stats.input;
 await assert.rejects(input.resizeViewport({width:320,height:240}),e=>e.code==='VIEWPORT_PROTOCOL'&&e.outcome==='unknown');await until(()=>h.transport.peers.size===0&&h.source.control.mode==='agent');await until(()=>viewer.state.state==='failed');assert.equal(input.active,false);assert.equal(input.viewportPending,null);assert.equal(h.source.control.lease,null);assert.ok(d.runtimes.every(r=>r.stats.live.size===0&&r.stats.workers.size===0));
});

test('paired ControlLink admits viewport replies through its bounded control parser',async()=>{
 const source=await readFile(new URL('../viewer/control-channel.mjs',import.meta.url),'utf8'),received=[],errors=[],sockets=[];
 class Socket {constructor(){this.readyState=1;sockets.push(this);}send(){}close(code){this.closed=code;}}
 const realm={URL,WebSocket:Socket,TextEncoder,parseMetadataJson:text=>({value:JSON.parse(text)})};runInNewContext(source.replace(/^import .*;\n/gm,'').replace('export class ControlLink','globalThis.ControlLink=class ControlLink'),realm);
 const link=new realm.ControlLink({onMessage:m=>received.push(m),onError:e=>errors.push(e),onClose(){}});link.open('ws://fixture/stream',{control:{ticket:'a'.repeat(64)},peerId:'p',sessionId:'s'});const ws=sockets[0];
 ws.onmessage({data:JSON.stringify({type:'ControlWelcome',protocol:4,peerId:'p',sessionId:'s'})});for(const message of [applied(),{type:'ViewportResizeDenied',requestId:2,code:'VIEWPORT_BUSY',outcome:'not-applied'}])ws.onmessage({data:JSON.stringify(message)});
 assert.equal(received.length,2);assert.deepEqual(errors,[]);assert.equal(ws.closed,undefined);link.reset();
});
