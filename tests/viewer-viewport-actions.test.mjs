import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerControlActions} from '../sdk/viewer-control.mjs';
import {createViewer} from '../sdk/viewer.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
import {wasmSha256} from './fixtures/viewer-runtime-harness.mjs';
import {dom} from './fixtures/viewer-dom-harness.mjs';
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(5);}assert.fail('Viewport action condition deadline');}
async function mounted(t,{workerMode=false,role='controller'}={}){
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)});h.source.resize=async({width,height})=>{h.source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};h.source.viewportVersion++;h.source.emit('invalidate','viewport');};
 const d=dom(h,{workerMode,realInput:true}),viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,role,getTicket:()=>h.issue(role)});t.after(()=>viewer.destroy());await viewer.connect();await until(()=>d.runtimes.at(-1).window.remotePaintResult?.frameId===1);if(role==='controller')await until(()=>viewer.control.mode==='agent');
 const runtime=d.runtimes.at(-1);return {h,d,viewer,child:runtime.window.remotePaintViewer,input:runtime.stats.input};
}
const key={kind:'key',type:'keyDown',key:'a',code:'KeyA',text:'a'};

for(const workerMode of [false,true])test(`viewport action ${workerMode?'Worker':'main'} waits for correlated Source outcome across legitimate epoch changes`,{skip:!sessionStoreSupported},async t=>{
 const f=await mounted(t,{workerMode}),{h,child,input}=f;await f.viewer.takeControl();const gate=pending(),started=pending(),resize=h.source.resize;
 h.source.resize=async size=>{await resize(size);started.resolve();await gate.promise;};
 try{let settled=false;const operation=child.resizeViewport({width:320,height:240}).then(value=>{settled=true;return value;});await started.promise;await until(()=>input.controlViewportVersion===2);assert.equal(settled,false);assert.equal(input.active,false);await assert.rejects(child.takeControl(),e=>e.code==='VIEWER_CONTROL_BUSY');await assert.rejects(child.releaseControl(),e=>e.code==='VIEWER_CONTROL_BUSY');await assert.rejects(child.resizeViewport({width:400,height:300}),e=>e.code==='VIEWER_CONTROL_BUSY'&&e.outcome==='not-applied');gate.resolve();const result=await operation;
  assert.deepEqual(result,{scope:'viewport',changed:true,width:320,height:240,pageEpoch:1,viewportVersion:2});assert.ok(Object.isFrozen(result));assert.equal(Object.keys(result).length,6);assert.equal(input.frame.viewportVersion,1);assert.equal(input.active,false);assert.equal(f.viewer.state.state,'connected');assert.ok(!JSON.stringify(result).includes(h.source.control.sessionId));
 }finally{gate.resolve();}
});

test('noop action returns Source acknowledgement while retaining lease and waiting for fresh renewal',{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t,{workerMode:true}),grant=await viewer.takeControl();input.push(key);await until(()=>h.source.control.keys.size===1);const result=await child.resizeViewport({width:100,height:100});assert.deepEqual(result,{scope:'viewport',changed:false,width:100,height:100,pageEpoch:1,viewportVersion:1});await until(()=>input.active);assert.equal(h.source.control.lease,grant.lease);assert.equal(h.source.control.keys.size,0);assert.equal(viewer.state.state,'connected');
});

test('viewport action preflight is finite, side effect free, and refuses readonly or unsupported peers',{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t);await viewer.takeControl();const lease=h.source.control.lease,version=h.source.control.version,abort=new AbortController();abort.abort();let getter=false;
 for(const size of [null,{},[],{width:1.5,height:1},{width:1,height:4097},{width:1,height:1,deviceScaleFactor:1},Object.defineProperty({height:1},'width',{get(){getter=true;return 1;}})])await assert.rejects(child.resizeViewport(size),e=>e.code==='VIEWER_INVALID_CONFIG'&&e.outcome==='not-applied');
 for(const options of [{timeoutMs:1},{timeoutMs:10001},{signal:{}},{execute:true},Object.defineProperty({},'timeoutMs',{get(){getter=true;return 50;}})])await assert.rejects(child.resizeViewport({width:320,height:240},options),e=>e.code==='VIEWER_INVALID_CONFIG'&&e.outcome==='not-applied');
 await assert.rejects(child.resizeViewport({width:320,height:240},{signal:abort.signal}),e=>e.code==='CHANNEL_ABORTED'&&e.outcome==='not-applied');input.viewportEnabled=false;await assert.rejects(child.resizeViewport({width:320,height:240}),e=>e.code==='VIEWER_VIEWPORT_UNSUPPORTED'&&e.outcome==='not-applied');assert.equal(getter,false);assert.equal(h.source.control.lease,lease);assert.equal(h.source.control.version,version);assert.equal(input.active,true);assert.equal(h.source.control.viewportPending,null);
 const readonly=await mounted(t,{role:'readonly'});await assert.rejects(readonly.child.resizeViewport({width:320,height:240}),e=>e.code==='VIEWER_CONTROL_UNAVAILABLE'&&e.outcome==='not-applied');
});

test('not-applied Source denial releases the old lease and preserves the public connection',{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t);await viewer.takeControl();h.source.resize=undefined;await assert.rejects(child.resizeViewport({width:320,height:240}),e=>e.code==='VIEWER_VIEWPORT_UNSUPPORTED'&&e.outcome==='not-applied');await until(()=>h.source.control.mode==='agent');assert.equal(input.active,false);assert.equal(viewer.state.state,'connected');assert.equal(h.source.viewportVersion,1);assert.equal(h.source.control.lease,null);
});

test('unknown Source outcome closes the old connection without claiming rollback or leaking diagnostics',{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t,{workerMode:true});await viewer.takeControl();h.source.resize=async()=>{h.source.viewport.cssWidth=320;throw new Error('private-endpoint-key');};
 await assert.rejects(child.resizeViewport({width:320,height:240}),e=>e.code==='VIEWER_VIEWPORT_FAILED'&&e.outcome==='unknown'&&!e.message.includes('private'));await until(()=>viewer.state.state==='failed'&&h.transport.peers.size===0&&h.source.control.mode==='agent');assert.equal(h.source.viewport.cssWidth,320);assert.equal(input.active,false);assert.equal(input.viewportPending,null);
});

for(const phase of ['queued','entered'])for(const reason of ['abort','timeout'])test(`viewport action ${reason} while ${phase} keeps actual Source work fenced until settlement`,{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t,{workerMode:reason==='timeout'});await viewer.takeControl();const gate=pending(),started=pending(),send=h.source.control.cdp.send,resize=h.source.resize;let calls=0;
 h.source.control.cdp.send=async(method,params)=>{if(phase==='queued'&&method==='Input.dispatchKeyEvent'&&params.type==='keyDown'){started.resolve();await gate.promise;}return send(method,params);};
 h.source.resize=async size=>{calls++;if(phase==='entered'){await resize(size);started.resolve();await gate.promise;}else await resize(size);};
 try{if(phase==='queued'){input.push(key);await started.promise;}const abort=new AbortController(),operation=child.resizeViewport({width:320,height:240},{signal:abort.signal,timeoutMs:reason==='timeout'?50:5000}),rejected=assert.rejects(operation,e=>e.code===(reason==='abort'?'CHANNEL_ABORTED':'CHANNEL_TIMEOUT')&&e.outcome==='unknown');if(phase==='entered')await started.promise;else await until(()=>h.source.control.viewportPending);const admitted=h.source.control.viewportPending;if(reason==='abort')abort.abort();await rejected;await until(()=>viewer.state.state==='failed'&&h.transport.peers.size===0);assert.equal(h.source.control.viewportPending,admitted);assert.equal(h.source.control.mode,'handoff');assert.equal(input.active,false);assert.equal(calls,phase==='entered'?1:0);assert.throws(()=>h.source.control.agent({kind:'text',text:'wait'}),e=>e.code==='AGENT_PAUSED');gate.resolve();await until(()=>h.source.control.mode==='agent'&&h.source.control.viewportPending===null);assert.equal(calls,phase==='entered'?1:0);assert.equal(input.active,false);assert.equal(h.source.control.lease,null);
 }finally{gate.resolve();h.source.control.cdp.send=send;}
});

test('disconnect retires a pending viewport action with unknown outcome',{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child}=await mounted(t);await viewer.takeControl();const gate=pending(),started=pending();h.source.resize=async()=>{started.resolve();await gate.promise;throw new Error('late');};
 try{const operation=child.resizeViewport({width:320,height:240}),rejected=assert.rejects(operation,e=>e.outcome==='unknown'&&['CHANNEL_ABORTED','VIEWER_CONTROL_UNAVAILABLE'].includes(e.code));await started.promise;await viewer.disconnect();await rejected;assert.ok(h.source.control.viewportPending);gate.resolve();await until(()=>h.source.control.mode==='agent'&&h.source.control.viewportPending===null);}finally{gate.resolve();}
});

test('unexpected successful input result becomes a fixed unknown protocol error and interrupts once',async()=>{
 const frame={pageEpoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100}},interrupts=[],input={enabled:true,viewportEnabled:true,active:true,mode:'human',controlHolder:'p',peerId:'p',controlPageEpoch:1,controlViewportVersion:1,controlExpiresAt:Date.now()+30000,lease:'a'.repeat(48),feedbackEpoch:2,frame,resizeViewport:async()=>({type:'ViewportResized',requestId:1,changed:true,pageEpoch:1,viewportVersion:2,viewport:{cssWidth:320,cssHeight:240,deviceScaleFactor:1},private:'must-not-escape'})};
 const actions=new ViewerControlActions({input,available:()=>true,notify(){},interrupt:code=>interrupts.push(code)});await assert.rejects(actions.resizeViewport({width:320,height:240}),e=>e.code==='CHANNEL_PROTOCOL'&&e.outcome==='unknown'&&!e.message.includes('private'));assert.deepEqual(interrupts,['CHANNEL_PROTOCOL']);actions.close();
});

for(const workerMode of [false,true])test(`viewport action ${workerMode?'Worker':'main'} preserves protocol outcome through synchronous connection teardown`,{skip:!sessionStoreSupported},async t=>{
 const {h,viewer,child,input}=await mounted(t,{workerMode});await viewer.takeControl();const handle=h.source.control.handle;
 h.source.control.handle=async function(peer,message){if(message.type==='ResizeViewport'){peer.send({type:'ViewportResized',requestId:message.requestId+1,changed:true,pageEpoch:1,viewportVersion:2,viewport:{cssWidth:320,cssHeight:240,deviceScaleFactor:1}});return;}return handle.call(this,peer,message);};
 await assert.rejects(child.resizeViewport({width:320,height:240}),e=>e.code==='CHANNEL_PROTOCOL'&&e.outcome==='unknown');await until(()=>viewer.state.state==='failed'&&h.transport.peers.size===0&&h.source.control.mode==='agent');assert.equal(input.active,false);assert.equal(input.viewportPending,null);
});

test('an arbitrary input error cannot claim not-applied',async()=>{
 const frame={pageEpoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100}},interrupts=[],input={enabled:true,viewportEnabled:true,active:true,mode:'human',controlHolder:'p',peerId:'p',controlExpiresAt:Date.now()+30000,lease:'a'.repeat(48),feedbackEpoch:2,frame,resizeViewport:async()=>{throw Object.assign(new Error('private'),{code:'private-executor',outcome:'not-applied'});}};
 const actions=new ViewerControlActions({input,available:()=>true,notify(){},interrupt:code=>interrupts.push(code)});await assert.rejects(actions.resizeViewport({width:320,height:240}),e=>e.code==='VIEWER_VIEWPORT_FAILED'&&e.outcome==='unknown'&&!e.message.includes('private'));assert.deepEqual(interrupts,['VIEWER_VIEWPORT_FAILED']);actions.close();
});
