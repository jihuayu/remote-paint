import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createViewer,ViewerChannelError} from '../sdk/viewer.mjs';
import {ViewerPort,readViewerHello} from '../sdk/viewer-channel.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
import {wasmSha256} from './fixtures/viewer-runtime-harness.mjs';
import {dom} from './fixtures/viewer-dom-harness.mjs';
async function until(check){for(let i=0;i<500;i++){if(check())return;await delay(5);}assert.fail('Component condition deadline');}
const options=(h,getTicket)=>({viewerOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,getTicket});
const resetEvents=r=>{r.window.dispatchEvent({type:'online'});r.window.dispatchEvent({type:'pageshow'});r.document.dispatchEvent({type:'resume'});};

for(const workerMode of [false,true])test(`DOM component owns actual ${workerMode?'Worker':'main'} connection, refresh, reload, pause and teardown`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h,{workerMode}),other=d.document.createElement('p');d.container.appendChild(other);let calls=0;const previous=[],states=[],errors=[];
 const viewer=createViewer(d.container,{...options(h,async request=>{calls++;previous.push(request.previousGrantId);if(request.previousGrantId){const response=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{ttlSeconds:1}});assert.equal(response.status,200);return response.data;}return h.issue('readonly',{ttlSeconds:1});}),onState:state=>states.push(state),onError:error=>errors.push(error.code)});t.after(()=>viewer.destroy());
 await viewer.ready;assert.equal(calls,0);assert.equal(viewer.state.state,'ready');const iframe=d.frame();assert.equal(iframe.src,audience+'/');assert.equal(iframe.referrerPolicy,'no-referrer');assert.equal(iframe.getAttribute('sandbox'),'allow-scripts allow-same-origin');assert.equal(iframe.title,'远程网页');assert.equal(viewer.element.style.width,'100%');assert.equal(viewer.element.style.height,'100%');
 assert.equal((await viewer.connect()).state,'connected');await until(()=>d.runtimes[0].window.remotePaintResult?.frameId===1);await until(()=>calls>=2);await until(()=>viewer.state.state==='connected');const before=calls,generation=viewer.state.generation;
 d.reload(iframe);await until(()=>d.runtimes.length===2&&viewer.state.generation>generation&&viewer.state.state==='connected');await until(()=>d.runtimes[1].window.remotePaintResult?.frameId===1);assert.ok(calls>before);assert.ok(previous.slice(1).every(value=>/^vgr_/.test(value)));assert.ok(d.runtimes.every(r=>r.stats.peak<=1));assert.equal(d.runtimes[0].stats.live.size,0);assert.equal(d.runtimes[0].stats.workers.size,0);
 await viewer.disconnect();await until(()=>h.transport.peers.size===0);const paused=calls;resetEvents(d.runtimes[1]);await delay(30);assert.equal(calls,paused);assert.equal(viewer.state.state,'paused');await viewer.connect();await until(()=>h.transport.peers.size===1);
 assert.ok(states.every(Object.isFrozen));assert.ok(!JSON.stringify(states).includes(h.transport.key));const destroying=viewer.destroy();assert.equal(viewer.destroy(),destroying);await destroying;await until(()=>h.transport.peers.size===0);assert.equal(viewer.state.state,'destroyed');assert.deepEqual(d.container.children,[other]);assert.equal(iframe.listenerCount(),0);assert.equal(d.owner.listenerCount(),0);assert.equal(d.observers.size,0);assert.ok(d.runtimes.every(r=>r.stats.live.size===0&&r.stats.workers.size===0));assert.deepEqual(errors,[]);await assert.rejects(viewer.connect(),e=>e.code==='VIEWER_CLOSED');
});

test('terminal public access failure stays latched across lifecycle events until explicit connect',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h);let calls=0,grant;const viewer=createViewer(d.container,options(h,async()=>{calls++;grant=await h.issue();return grant;}));t.after(()=>viewer.destroy());await viewer.connect();await until(()=>d.runtimes[0].window.remotePaintResult?.frameId===1);
 await h.api(h.tickets+'/'+grant.grantId,{method:'DELETE'});await until(()=>viewer.state.state==='failed');assert.equal(viewer.state.code,'VIEWER_ACCESS_ENDED');assert.equal(d.frame(),undefined);const before=calls;resetEvents(d.runtimes[0]);await delay(60);assert.equal(calls,before);assert.equal(d.runtimes[0].stats.live.size,0);await viewer.connect();assert.equal(calls,before+1);assert.equal(viewer.state.state,'connected');
});

test('reloading an unsettled callback cannot bypass its central admission slot',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h),gate=pending(),started=pending();let calls=0;const viewer=createViewer(d.container,options(h,async()=>{calls++;started.resolve();if(calls===1)await gate.promise;return h.issue();}));t.after(()=>{gate.resolve();return viewer.destroy();});const connect=viewer.connect();await started.promise;const old=d.frame();d.reload(old);await until(()=>d.runtimes.length===2);await delay(60);assert.equal(calls,1);assert.equal(d.runtimes[0].stats.sockets.length,0);gate.resolve();await connect;assert.equal(calls,2);await until(()=>d.runtimes[1].window.remotePaintResult?.frameId===1);assert.equal(d.runtimes[0].stats.live.size,0);
});

test('cancel and destroy fence late ticket completion without another callback',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h),gate=pending(),started=pending();let calls=0;const viewer=createViewer(d.container,options(h,async()=>{calls++;started.resolve();await gate.promise;return h.issue();}));t.after(()=>{gate.resolve();return viewer.destroy();});const abort=new AbortController(),connecting=viewer.connect({signal:abort.signal}),rejected=assert.rejects(connecting,e=>e.code==='CHANNEL_ABORTED');await started.promise;abort.abort();await rejected;await viewer.destroy();gate.resolve();await delay(30);assert.equal(calls,1);assert.equal(h.resolutions.length,0);assert.ok(d.runtimes.every(r=>r.stats.sockets.length===0&&r.stats.live.size===0));assert.equal(d.frame(),undefined);assert.equal(d.owner.listenerCount(),0);
});

test('missing frame load has a bounded failure and a fresh retry has its own deadline',async t=>{
 const d=dom({base:'https://gateway.example'},{autoLoad:false}),errors=[],viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){assert.fail('No ticket before metadata');},loadTimeoutMs:50,onError:e=>errors.push(e.code)});t.after(()=>viewer.destroy());const ready=assert.rejects(viewer.ready,e=>e.code==='CHANNEL_TIMEOUT');await delay(65);await ready;assert.equal(viewer.state.state,'failed');assert.equal(d.frame(),undefined);const connecting=assert.rejects(viewer.connect(),e=>e.code==='CHANNEL_TIMEOUT');await delay(65);await connecting;assert.deepEqual(errors,['CHANNEL_TIMEOUT','CHANNEL_TIMEOUT']);assert.equal(d.frames.length,2);assert.equal(d.frame(),undefined);
});

test('destroy while loading settles ready and removes only the owned host',async()=>{
 const d=dom({base:'https://gateway.example'},{autoLoad:false}),other=d.document.createElement('p');d.container.appendChild(other);const viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){assert.fail('No ticket');}});const ready=assert.rejects(viewer.ready,e=>e.code==='VIEWER_CLOSED');await viewer.destroy();await ready;assert.deepEqual(d.container.children,[other]);assert.equal(d.owner.listenerCount(),0);assert.equal(d.frames[0].listenerCount(),0);assert.equal(d.observers.size,0);
});

test('missing disconnect acknowledgements cannot extend disconnect or destroy indefinitely',async t=>{
 for(const action of ['disconnect','destroy']){
  const d=dom({base:'https://gateway.example'},{autoLoad:false}),gate=pending();let peer;const viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){assert.fail('No ticket');},disconnectTimeoutMs:50,destroyTimeoutMs:25});t.after(()=>{gate.resolve();peer?.close();return viewer.destroy();});
  d.frame().contentWindow={postMessage(data,targetOrigin,ports){assert.equal(targetOrigin,audience);const channel=readViewerHello(data),transferred=structuredClone(ports,{transfer:ports});peer=new ViewerPort({port:transferred[0],channel,handle:()=>gate.promise});peer.notify('ready',{gatewayOrigin:'https://gateway.example',viewerBuild:'b'.repeat(64)});}};d.frame().dispatchEvent({type:'load'});await viewer.ready;
  const start=performance.now(),work=viewer[action]();await delay(75);await work;assert.ok(performance.now()-start<500,'bounded parent wait');assert.equal(d.frame(),undefined);await until(()=>peer.closed);assert.equal(viewer.state.state,action==='destroy'?'destroyed':'paused');
 }
});

test('total connect deadline also covers an iframe that never loads',async t=>{
 const d=dom({base:'https://gateway.example'},{autoLoad:false}),viewer=createViewer(d.container,{viewerOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){assert.fail('No ticket');},connectTimeoutMs:50});t.after(()=>viewer.destroy());const connecting=assert.rejects(viewer.connect(),e=>e.code==='CHANNEL_TIMEOUT');await delay(65);await connecting;assert.equal(viewer.state.state,'failed');assert.equal(d.frame(),undefined);
});

test('host removal and pagehide dispose mounted component despite throwing listeners',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h);let count=0;
 for(const remove of [viewer=>viewer.element.remove(),()=>d.owner.dispatchEvent({type:'pagehide',persisted:false})]){
  const viewer=createViewer(d.container,options(h,()=>h.issue()));t.after(()=>viewer.destroy());viewer.on('state',()=>{count++;throw new Error('Application listener');});await viewer.connect();await until(()=>h.transport.peers.size===1);remove(viewer);await until(()=>viewer.state.state==='destroyed'&&h.transport.peers.size===0&&d.owner.listenerCount()===0);await viewer.destroy();assert.equal(d.frame(),undefined);assert.equal(d.observers.size,0);
 }assert.ok(count>2);
});

test('repeated mounts retire fixture DOM, renderer, Worker and transferred ports',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),d=dom(h,{workerMode:true});
 for(let i=0;i<8;i++){
  const viewer=createViewer(d.container,options(h,()=>h.issue()));t.after(()=>viewer.destroy());await viewer.connect();await until(()=>d.runtimes.at(-1).window.remotePaintResult?.frameId===1);await viewer.destroy();await until(()=>h.transport.peers.size===0);assert.equal(d.container.children.length,0);assert.equal(d.owner.listenerCount(),0);assert.equal(d.observers.size,0);assert.ok(d.frames.every(frame=>frame.listenerCount()===0));assert.ok(d.runtimes.every(r=>r.stats.live.size===0&&r.stats.workers.size===0));
 }
});

test('component validates origins and config before DOM effects or application accessors',()=>{
 const d=dom({base:'https://gateway.example'}),config={viewerOrigin:audience,gatewayOrigin:'https://gateway.example',sessionId:'ses_fixture',getTicket(){assert.fail('No ticket');}};let getter=false;
 for(const viewerOrigin of [audience+'/',audience+'/?ticket=secret','https://user:pass@embed.example','http://insecure.example','null'])assert.throws(()=>createViewer(d.container,{...config,viewerOrigin}),e=>e.code==='VIEWER_INVALID_CONFIG');
 assert.throws(()=>createViewer(d.container,{...config,apiKey:'backend-secret'}),e=>e.code==='VIEWER_INVALID_CONFIG');assert.throws(()=>createViewer(d.container,Object.defineProperty({...config},'getTicket',{get(){getter=true;return()=>{};}})),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(getter,false);assert.equal(d.frames.length,0);assert.equal(d.container.children.length,0);assert.equal(d.owner.listenerCount(),0);assert.equal(new ViewerChannelError('secret').code,'CHANNEL_HANDLER_FAILED');
});
