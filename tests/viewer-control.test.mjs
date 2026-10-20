import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createViewer} from '../sdk/viewer.mjs';
import {ViewerFrameConnection} from '../sdk/viewer-frame.mjs';
import {ViewerPort,readViewerHello} from '../sdk/viewer-channel.mjs';
import {emptyViewerControl,viewerControlState} from '../sdk/viewer-control.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
import {wasmSha256} from './fixtures/viewer-runtime-harness.mjs';
import {dom} from './fixtures/viewer-dom-harness.mjs';
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(5);}assert.fail('Public control condition deadline');}
async function mount(t,h,{workerMode=false,role='controller',onControl}={}){
 const d=dom(h,{workerMode,realInput:true}),states=[];let calls=0;
 const viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,role,getTicket:()=>{calls++;return h.issue(role);},onControl:value=>{states.push(value);onControl?.(value);}});t.after(()=>viewer.destroy());await viewer.connect();await until(()=>d.runtimes.at(-1).window.remotePaintResult?.frameId===1);if(role==='controller')await until(()=>viewer.control.mode!=='unavailable');return {d,viewer,states,calls:()=>calls,input:()=>d.runtimes.at(-1).stats.input};
}
const key=text=>({kind:'key',type:'keyDown',key:text,code:'Key'+text.toUpperCase(),text});

for(const workerMode of [false,true])test(`public ${workerMode?'Worker':'main'} takeover returns actual lease/fence and release awaits Source`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h,{workerMode}),grant=await f.viewer.takeControl();assert.ok(Object.isFrozen(grant));assert.equal(grant.held,true);assert.equal(h.source.control.mode,'human');assert.equal(grant.lease,h.source.control.lease);assert.equal(grant.fencingToken,h.source.control.version);assert.equal(grant.pageEpoch,h.source.pageEpoch);assert.equal(grant.expiresAt,h.source.control.expiresAt);assert.deepEqual(await f.viewer.takeControl(),grant);
 assert.throws(()=>h.source.control.agent({kind:'text',text:'blocked-agent'}),e=>e.code==='AGENT_PAUSED');f.input().push(key('x'));await until(()=>h.calls.some(call=>call.method==='Input.dispatchKeyEvent'&&call.params.text==='x'));await until(()=>f.input().pending.size===0);
 f.input().send({type:'RenewControl',...f.input().tags()});await delay(15);assert.equal(f.viewer.control.fencingToken,grant.fencingToken);
 const returned=await f.viewer.releaseControl();assert.equal(returned.mode,'agent');assert.equal(returned.held,false);assert.equal(returned.lease,null);assert.equal(h.source.control.mode,'agent');await h.source.control.agent({kind:'text',text:'resumed-agent'});assert.ok(h.calls.some(call=>call.params.text==='resumed-agent'));
 for(const state of f.states){assert.ok(Object.isFrozen(state));assert.ok(!JSON.stringify(state).includes(h.source.control.sessionId));assert.ok(!JSON.stringify(state).includes(h.transport.key));assert.equal(Object.keys(state).length,8);}await f.viewer.destroy();await until(()=>h.transport.peers.size===0);assert.equal(f.viewer.control.mode,'unavailable');assert.equal(f.input().active,false);assert.equal(f.input().pending.size,0);assert.equal(f.input().queue.length,0);
});

test('readonly component refuses control before any Source control request',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h,{role:'readonly'}),version=h.source.control.version;assert.deepEqual(f.viewer.control,emptyViewerControl());await assert.rejects(f.viewer.takeControl(),e=>e.code==='VIEWER_CONTROL_UNAVAILABLE');await assert.rejects(f.viewer.releaseControl(),e=>e.code==='VIEWER_CONTROL_UNAVAILABLE');assert.equal(h.source.control.version,version);assert.equal(h.source.control.mode,'agent');assert.equal(f.calls(),1);assert.equal(h.calls.length,0);
});

test('two public controllers expose only the holder lease and reject its stale token after handover',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),a=await mount(t,h),first=await a.viewer.takeControl(),b=await mount(t,h,{workerMode:true});assert.equal(b.viewer.control.holder,'other');assert.equal(b.viewer.control.lease,null);assert.equal(b.viewer.control.fencingToken,null);await assert.rejects(b.viewer.takeControl(),e=>e.code==='VIEWER_CONTROL_BUSY');await a.viewer.releaseControl();await until(()=>b.viewer.control.mode==='agent');const second=await b.viewer.takeControl();assert.ok(second.fencingToken>first.fencingToken);assert.notEqual(second.lease,first.lease);await until(()=>a.viewer.control.holder==='other');assert.equal(a.viewer.control.lease,null);
 const before=h.calls.length,sequence=h.source.inputSeq,r=a.d.runtimes.at(-1);r.stats.sockets.at(-1).send(JSON.stringify({type:'Input',sessionId:h.source.control.sessionId,pageEpoch:first.pageEpoch,viewportVersion:first.viewportVersion,lease:first.lease,seq:h.source.control.nextSeq,event:key('z')}));await delay(30);assert.equal(h.calls.length,before);assert.equal(h.source.inputSeq,sequence);assert.equal(h.source.control.lease,second.lease);await b.viewer.releaseControl();
});

test('takeover waits for existing managed Agent work and admits only one pending action',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h),gate=pending(),started=pending(),send=h.source.control.cdp.send;
 h.source.control.cdp.send=async(method,params)=>{if(params.text==='prior-agent'){started.resolve();await gate.promise;}return send(method,params);};
 try{
  const prior=h.source.control.agent({kind:'text',text:'prior-agent'});await started.promise;let settled=false;const taking=f.viewer.takeControl().then(value=>{settled=true;return value;});await until(()=>f.viewer.control.mode==='handoff');assert.equal(settled,false);assert.equal(f.viewer.control.held,false);assert.equal(f.viewer.control.lease,null);const version=h.source.control.version;await assert.rejects(f.viewer.takeControl(),e=>e.code==='VIEWER_CONTROL_BUSY');assert.equal(h.source.control.version,version);gate.resolve();await prior;const grant=await taking;assert.equal(grant.held,true);assert.equal(h.source.control.mode,'human');await f.viewer.releaseControl();
 }finally{gate.resolve();h.source.control.cdp.send=send;}
});

test('release waits for cleanup fence and stops local input before its confirmation',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h,{workerMode:true});await f.viewer.takeControl();const gate=pending(),started=pending(),send=h.source.control.cdp.send;
 h.source.control.cdp.send=async(method,params)=>{if(method==='Input.imeSetComposition'){started.resolve();await gate.promise;}return send(method,params);};
 try{
  let settled=false;const releasing=f.viewer.releaseControl().then(value=>{settled=true;return value;});await started.promise;await until(()=>f.viewer.control.mode==='handoff');assert.equal(settled,false);assert.equal(f.input().active,false);const count=h.calls.length;f.input().push(key('q'));await delay(15);assert.equal(h.calls.length,count);gate.resolve();const result=await releasing;assert.equal(result.mode,'agent');assert.equal(h.source.control.mode,'agent');
 }finally{gate.resolve();h.source.control.cdp.send=send;}
});

for(const reason of ['abort','timeout'])test(`interrupted takeover (${reason}) ends the old connection and fences a late grant`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h),gate=pending(),started=pending(),send=h.source.control.cdp.send;
 h.source.control.cdp.send=async(method,params)=>{if(params.text==='prior-agent'){started.resolve();await gate.promise;}return send(method,params);};
 try{
  const prior=h.source.control.agent({kind:'text',text:'prior-agent'});await started.promise;const controller=new AbortController(),taking=f.viewer.takeControl({signal:controller.signal,timeoutMs:reason==='timeout'?50:5000}),rejected=assert.rejects(taking,e=>e.code===(reason==='timeout'?'CHANNEL_TIMEOUT':'CHANNEL_ABORTED'));await until(()=>f.viewer.control.mode==='handoff');if(reason==='abort')controller.abort();await rejected;await until(()=>f.viewer.state.state==='failed');assert.equal(f.viewer.control.held,false);gate.resolve();await prior;await until(()=>h.transport.peers.size===0&&h.source.control.mode==='agent');assert.equal(f.states.some(state=>state.held),false);const before=f.calls();f.d.runtimes.at(-1).window.dispatchEvent({type:'online'});await delay(30);assert.equal(f.calls(),before);assert.equal(f.d.runtimes.at(-1).stats.live.size,0);
 }finally{gate.resolve();h.source.control.cdp.send=send;}
});

test('page invalidation retires the public lease and stale display cannot reacquire',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h);await f.viewer.takeControl();h.source.pageEpoch++;h.source.emit('invalidate');await until(()=>h.source.control.mode==='agent'&&f.viewer.control.mode==='agent');assert.equal(f.viewer.control.lease,null);assert.equal(f.viewer.control.fencingToken,null);assert.equal(f.viewer.control.pageEpoch,h.source.pageEpoch);await assert.rejects(f.viewer.takeControl(),e=>e.code==='VIEWER_CONTROL_STALE');assert.equal(h.source.control.mode,'agent');
});

for(const reason of ['abort','timeout'])test(`interrupted release (${reason}) closes the peer and keeps input stopped during cleanup`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h,{workerMode:true});await f.viewer.takeControl();const gate=pending(),started=pending(),send=h.source.control.cdp.send;
 h.source.control.cdp.send=async(method,params)=>{if(method==='Input.imeSetComposition'){started.resolve();await gate.promise;}return send(method,params);};
 try{const abort=new AbortController(),releasing=f.viewer.releaseControl({signal:abort.signal,timeoutMs:reason==='timeout'?50:5000}),rejected=assert.rejects(releasing,e=>e.code===(reason==='abort'?'CHANNEL_ABORTED':'CHANNEL_TIMEOUT'));await started.promise;if(reason==='abort')abort.abort();await rejected;await until(()=>f.viewer.state.state==='failed');assert.equal(f.viewer.control.held,false);assert.equal(f.input().active,false);gate.resolve();await until(()=>h.transport.peers.size===0&&h.source.control.mode==='agent');}finally{gate.resolve();h.source.control.cdp.send=send;}
});

test('destroy with a held lease stops renewal and retires repeated real input pipelines',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)});let previous=0;
 for(let i=0;i<4;i++){
  const f=await mount(t,h,{workerMode:i%2===1}),grant=await f.viewer.takeControl();assert.ok(grant.fencingToken>previous);previous=grant.fencingToken;await f.viewer.destroy();await until(()=>h.transport.peers.size===0&&h.source.control.mode==='agent');assert.equal(f.input().active,false);assert.equal(f.input().pending.size,0);assert.equal(f.input().queue.length,0);assert.equal(f.viewer.control.lease,null);assert.ok(f.d.runtimes.every(r=>r.stats.live.size===0&&r.stats.workers.size===0));assert.equal(f.d.owner.listenerCount(),0);
 }
});

test('a denied release ends the peer so an unconfirmed old lease cannot remain usable',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h);await f.viewer.takeControl();const valid=h.source.control.validLease;
 h.source.control.validLease=function(peer,message){if(message.type==='ReleaseControl')throw Object.assign(new Error('private-diagnostic'),{code:'STALE_LEASE'});return valid.call(this,peer,message);};
 try{await assert.rejects(f.viewer.releaseControl(),e=>e.code==='VIEWER_CONTROL_DENIED'&&!e.message.includes('private'));await until(()=>f.viewer.state.state==='failed'&&h.transport.peers.size===0&&h.source.control.mode==='agent');assert.equal(f.viewer.control.lease,null);assert.equal(f.input().active,false);}finally{h.source.control.validLease=valid;}
});

test('pre-cancelled control operations leave the connection and Source unchanged',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),f=await mount(t,h),abort=new AbortController();abort.abort();const version=h.source.control.version;await assert.rejects(f.viewer.takeControl({signal:abort.signal}),e=>e.code==='CHANNEL_ABORTED');await assert.rejects(f.viewer.takeControl({timeoutMs:1}),e=>e.code==='VIEWER_INVALID_CONFIG');await assert.rejects(f.viewer.takeControl({execute:'must-not-dispatch'}),e=>e.code==='VIEWER_INVALID_CONFIG');await assert.rejects(f.viewer.takeControl(Object.create(Object.assign(Object.create(null),{timeoutMs:50}))),e=>e.code==='VIEWER_INVALID_CONFIG');let getter=false;await assert.rejects(f.viewer.takeControl(Object.defineProperty({},'timeoutMs',{get(){getter=true;return 5000;}})),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(getter,false);assert.equal(f.viewer.state.state,'connected');assert.equal(h.source.control.version,version);assert.equal(f.calls(),1);
});

test('malformed or readonly lease events close the authenticated port before public delivery',async t=>{
 for(const value of [{...emptyViewerControl(),key:'must-not-escape'},{mode:'human',holder:'self',held:true,lease:'a'.repeat(48),fencingToken:1,expiresAt:Date.now()+30000,pageEpoch:1,viewportVersion:1}]){
  let peer;const received=[],frame=new ViewerFrameConnection({frameWindow:{postMessage(data,targetOrigin,ports){assert.equal(targetOrigin,audience);const channel=readViewerHello(data),transferred=structuredClone(ports,{transfer:ports});peer=new ViewerPort({port:transferred[0],channel,handle:()=>null});peer.notify('ready',{gatewayOrigin:'https://gateway.example',viewerBuild:'b'.repeat(64)});peer.notify('control',value);}},frameOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',role:'readonly',getTicket(){assert.fail('No ticket');},onControl:value=>received.push(value)});t.after(()=>{frame.close();peer?.close();});await frame.ready;await until(()=>frame.state.state==='closed');assert.equal(frame.state.code,'CHANNEL_PROTOCOL');assert.equal(received.length,0);assert.deepEqual(frame.control,emptyViewerControl());
 }
});

test('public lease schema accepts ordinary reordered objects and refuses token or identity leakage',()=>{
 assert.deepEqual(viewerControlState(Object.fromEntries(Object.entries(emptyViewerControl()).reverse())),emptyViewerControl());for(const extra of [{peerId:'private'},{sessionId:'private'},{ticket:'private'}])assert.throws(()=>viewerControlState({...emptyViewerControl(),...extra}),e=>e.code==='CHANNEL_PROTOCOL');assert.throws(()=>viewerControlState({...emptyViewerControl(),lease:'a'.repeat(48)}),e=>e.code==='CHANNEL_PROTOCOL');
});

test('a malformed successful control reply retires the port instead of leaving a usable connection',async t=>{
 let peer;const sessionId='ses_fixture',version='v1',ticket='vwt1.'+'a'.repeat(43),frame=new ViewerFrameConnection({frameWindow:{postMessage(data,targetOrigin,ports){assert.equal(targetOrigin,audience);const channel=readViewerHello(data),transferred=structuredClone(ports,{transfer:ports});peer=new ViewerPort({port:transferred[0],channel,handle:async method=>{if(method==='connect'){await peer.request('ticket',{reason:'connect',previousGrantId:null});peer.notify('state',{state:'connected',sessionId,role:'controller',version});return {accepted:true};}if(method==='take-control')return {...emptyViewerControl(),key:'private'};return null;}});peer.notify('ready',{gatewayOrigin:'https://gateway.example',viewerBuild:'b'.repeat(64)});}},frameOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId,role:'controller',getTicket:()=>({grantId:'vgr_00000000-0000-0000-0000-000000000000',sessionId,role:'controller',audience,version,ticket,streamPath:'/v1/viewer/stream?ticket='+ticket,expiresAt:new Date(Date.now()+30000).toISOString()})});t.after(()=>{frame.close();peer?.close();});await frame.connect();await assert.rejects(frame.takeControl(),e=>e.code==='CHANNEL_PROTOCOL');await until(()=>peer.closed);assert.equal(frame.state.state,'closed');assert.equal(frame.state.code,'CHANNEL_PROTOCOL');assert.equal(frame.control.held,false);
});
