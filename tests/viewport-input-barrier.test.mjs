import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease} from '../live/input.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(t){
 const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1},latest:{lastProcessedInputSeq:0},inputSeq:0}),calls=[],messages=[],cdp={send:async(method,params)=>calls.push({method,params}),detach:async()=>{}},control=new ControlLease(source,cdp),peer={id:'peer',ready:true,closed:false,send:m=>messages.push(m)};
 let resizes=0,captures=0;source.requestCapture=()=>captures++;source.resize=async({width,height})=>{resizes++;assert.equal(control.keys.size,0);assert.equal(control.buttons.size,0);source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.emit('invalidate','viewport');};control.attach(peer);t.after(()=>control.close());return{source,control,peer,cdp,calls,messages,get resizes(){return resizes;},get captures(){return captures;}};
}
const acquire=f=>f.control.acquire(f.peer.id,{sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1});
const resize=(f,grant,extra={})=>({type:'ResizeViewport',requestId:1,width:320,height:240,sessionId:f.control.sessionId,pageEpoch:1,viewportVersion:1,lease:grant.lease,...extra});
async function hold(f,grant){for(const event of [{kind:'key',type:'keyDown',key:'a',code:'KeyA'},{kind:'mouse',type:'mousePressed',x:20,y:30,button:'left',buttons:1,clickCount:1},{kind:'composition',phase:'update',text:'中'}])await f.control.input(f.peer.id,{...grant,seq:f.control.nextSeq,event});}

for(const changed of [false,true])test(`viewport ${changed?'change':'noop'} neutralizes held state before its reply`,async t=>{
 const f=fixture(t),grant=await acquire(f);await hold(f,grant);const nextSeq=f.control.nextSeq,version=f.control.version;f.calls.length=0;
 await f.control.handle(f.peer,resize(f,grant,changed?{}:{width:100,height:100}));
 const response=f.messages.find(m=>m.type==='ViewportResized');assert.equal(response.changed,changed);assert.equal(f.control.keys.size,0);assert.equal(f.control.buttons.size,0);assert.equal(f.control.compositionEvent,null);assert.equal(f.control.nextSeq,nextSeq);
 assert.ok(f.calls.some(c=>c.method==='Input.imeSetComposition'&&c.params.text===''));
 assert.ok(f.calls.some(c=>c.method==='Input.dispatchKeyEvent'&&c.params.code==='KeyA'&&c.params.type==='keyUp'));
 const move=f.calls.findIndex(c=>c.params.type==='mouseMoved'),up=f.calls.findIndex(c=>c.params.type==='mouseReleased');assert.ok(move>=0&&up>move);assert.equal(f.calls[up].params.x,-1);assert.equal(f.calls[up].params.y,-1);
 if(changed){await f.control.tail;assert.equal(f.resizes,1);assert.equal(f.control.mode,'agent');}
 else{assert.equal(f.resizes,0);assert.equal(f.control.mode,'human');assert.equal(f.control.lease,grant.lease);assert.equal(f.control.version,version);assert.equal(f.source.viewportVersion,1);assert.ok(f.captures>3);}
});

test('viewport neutralization waits for prior injected work and resize waits for neutralization',async t=>{
 const f=fixture(t),grant=await acquire(f),inputGate=deferred(),inputStarted=deferred(),cleanupGate=deferred(),cleanupStarted=deferred();let blocked=true;
 const send=f.cdp.send;f.cdp.send=async(method,params)=>{if(method==='Input.insertText'){inputStarted.resolve();await inputGate.promise;}if(method==='Input.imeSetComposition'&&blocked){blocked=false;cleanupStarted.resolve();await cleanupGate.promise;}return send(method,params);};
 try{const input=f.control.input(f.peer.id,{...grant,seq:1,event:{kind:'text',text:'prior'}});await inputStarted.promise;const work=f.control.handle(f.peer,resize(f,grant));await Promise.resolve();assert.equal(f.resizes,0);assert.equal(blocked,true);inputGate.resolve();await input;await cleanupStarted.promise;assert.equal(f.resizes,0);assert.equal(f.messages.some(m=>m.type==='ViewportResized'),false);cleanupGate.resolve();await work;assert.equal(f.resizes,1);}finally{inputGate.resolve();cleanupGate.resolve();}
});

test('revocation while neutralization is pending prevents any Source resize entry',async t=>{
 const f=fixture(t),grant=await acquire(f),gate=deferred(),started=deferred();let blocked=true;const send=f.cdp.send;
 f.cdp.send=async(method,params)=>{if(method==='Input.imeSetComposition'&&blocked){blocked=false;started.resolve();await gate.promise;}return send(method,params);};
 try{const work=f.control.handle(f.peer,resize(f,grant));await started.promise;const revoke=f.control.revoke();gate.resolve();await work;await revoke;assert.equal(f.resizes,0);const denial=f.messages.find(m=>m.type==='ViewportResizeDenied');assert.equal(denial.code,'STALE_LEASE');assert.equal(denial.outcome,'not-applied');assert.equal(f.control.mode,'agent');}finally{gate.resolve();}
});

test('neutralization failure retries held cleanup through revocation and reports fixed not-applied',async t=>{
 const f=fixture(t),grant=await acquire(f);await hold(f,grant);let failed=false,releases=0;const send=f.cdp.send;
 f.cdp.send=async(method,params)=>{if(method==='Input.dispatchKeyEvent'&&params.type==='keyUp'){releases++;if(!failed){failed=true;throw Error('private-endpoint-and-key');}}return send(method,params);};
 await f.control.handle(f.peer,resize(f,grant));await f.control.tail;assert.equal(f.resizes,0);assert.ok(releases>=2);assert.equal(f.control.keys.size,0);assert.equal(f.control.buttons.size,0);assert.equal(f.control.mode,'agent');assert.equal(f.control.lease,null);
 assert.deepEqual(f.messages.find(m=>m.type==='ViewportResizeDenied'),{type:'ViewportResizeDenied',requestId:1,code:'VIEWPORT_INPUT_RESET_FAILED',outcome:'not-applied'});assert.ok(!JSON.stringify(f.messages).includes('private-endpoint-and-key'));
});

test('noop input neutralization discards a previously started semantic feedback read',async t=>{
 const f=fixture(t),grant=await acquire(f),gate=deferred(),started=deferred();f.peer.feedback=true;let first=true;
 f.source.page={evaluate:async fn=>{if(fn.name==='readPublicEditor'&&first){first=false;started.resolve();await gate.promise;return{preview:'plain-text',editorId:'stale-editor',text:'stale'};}return null;}};
 try{const reading=f.control.readFeedback();await started.promise;await f.control.handle(f.peer,resize(f,grant,{width:100,height:100}));gate.resolve();await reading;assert.equal(f.messages.some(m=>m.type==='FeedbackState'),false);assert.equal(f.control.mode,'human');}finally{gate.resolve();}
});
