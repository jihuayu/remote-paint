import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {instrumentFrameAgeWorker} from './frame-age-observer.mjs';
import {ViewerFrameConnection} from '../sdk/viewer-frame.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {runtime,workerSource,wasmSha256} from './fixtures/viewer-runtime-harness.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('Runtime condition deadline');}

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} Viewer uses public tickets for frames, refresh, disconnect and resume fencing`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),r=runtime(workerMode);t.after(r.disconnect);let calls=0;
 let getterRead=false;assert.throws(()=>r.window.remotePaintViewer.connect(Object.defineProperty({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly'},'getTicket',{enumerable:true,get(){getterRead=true;return()=>h.issue();}})),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(getterRead,false);
 const options={gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async request=>{calls++;if(request.previousGrantId){const response=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{ttlSeconds:1}});assert.equal(response.status,200);return response.data;}return h.issue('readonly',{ttlSeconds:1});}};
 r.window.remotePaintViewer.connect(options);await until(()=>r.window.remotePaintResult?.frameId===1).catch(()=>assert.fail(JSON.stringify({error:r.document.getElementById('error').textContent,state:r.window.remotePaintConnection,lifecycle:r.window.remotePaintLifecycle})));assert.equal(r.window.remotePaintConnection.state,'connected');assert.equal(r.window.remotePaintConnection.role,'readonly');assert.ok(r.stats.draws>0);
 await until(()=>calls>=2&&r.stats.events.filter(e=>e.state==='connected').length>=2);assert.equal(r.window.remotePaintConnection.sessionId,h.sessionId);assert.ok(!JSON.stringify(r.stats.events).includes(h.transport.key));
 r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);const count=r.stats.sockets.length;
 r.document.dispatchEvent({type:'resume'});r.window.dispatchEvent({type:'pageshow'});r.window.dispatchEvent({type:'online'});await delay(30);assert.equal(r.stats.sockets.length,count);assert.equal(r.window.remotePaintViewer.state.state,'paused');
 r.window.remotePaintViewer.connect(options);await until(()=>r.stats.sockets.length>count&&r.window.remotePaintResult?.frameId===1);r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.ok(r.stats.peak<=1,'one renderer per Viewer lifecycle');
});

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} Viewer discards late callback access after disconnect`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),r=runtime(workerMode),gate=pending(),started=pending();t.after(r.disconnect);
 r.window.remotePaintViewer.connect({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async()=>{started.resolve();await gate.promise;return h.issue();}});
 await started.promise;r.disconnect();gate.resolve();await delay(40);assert.equal(r.stats.sockets.length,0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.equal(h.resolutions.length,0);
});

for(const workerMode of [false,true])test(`public ${workerMode?'Worker':'main'} boot waits for metadata and authorization without private key fallback`,{skip:!sessionStoreSupported},async t=>{
 const build='b'.repeat(64),h=await fixture(t,{wasmSha256,viewerBuild:build}),gate=pending(),r=runtime(workerMode,{publicMode:true,viewerBuild:build,hash:'#key=private-must-be-ignored',configFetch:async()=>gate.promise});t.after(r.disconnect);let tickets=0;
 const options={gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async()=>{tickets++;return h.issue();}};
 assert.throws(()=>r.window.remotePaintViewer.connect(options),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(r.window.remotePaintViewer.state.state,'waiting');
 gate.resolve(new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:h.base,allowedParentOrigins:[audience],viewerBuild:build}),{headers:{'content-type':'application/json'}}));
 const config=await r.window.remotePaintViewer.ready;assert.equal(config.gatewayOrigin,h.base);assert.ok(Object.isFrozen(config));
 for(const event of ['pageshow','online'])r.window.dispatchEvent({type:event});r.document.dispatchEvent({type:'resume'});await delay(20);
 assert.equal(tickets,0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.equal(r.stats.sockets.length,0);assert.deepEqual(r.stats.fetches,[audience+'/viewer-config']);assert.equal(h.resolutions.length,0);
 assert.throws(()=>r.window.remotePaintViewer.connect({...options,gatewayOrigin:'https://wrong-gateway.example'}),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(tickets,0);
 r.window.remotePaintViewer.connect(options);await until(()=>r.window.remotePaintResult?.frameId===1);assert.equal(r.window.remotePaintConnection.state,'connected');assert.equal(tickets,1);assert.ok(!r.stats.fetches.some(url=>url.includes('/session-config')));r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
});

test('public metadata build mismatch leaves the saved entry frozen with no private connection attempt',async t=>{
 const r=runtime(false,{publicMode:true,viewerBuild:'b'.repeat(64),hash:'#key=private-must-be-ignored',configFetch:async()=>new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:'https://gateway.example',allowedParentOrigins:[audience],viewerBuild:'c'.repeat(64)}),{headers:{'content-type':'application/json'}})});t.after(r.disconnect);
 await assert.rejects(r.window.remotePaintViewer.ready,e=>e.code==='VIEWER_CONFIG_INVALID');r.window.dispatchEvent({type:'online'});r.document.dispatchEvent({type:'resume'});await delay(20);assert.equal(r.stats.live.size,0);assert.equal(r.stats.sockets.length,0);assert.equal(r.window.remotePaintViewer.state.state,'failed');assert.equal(r.window.remotePaintViewer.state.code,'VIEWER_CONFIG_INVALID');assert.deepEqual(r.stats.fetches,[audience+'/viewer-config']);
});

test('current frame-age instrumented Worker reaches a real Node frame after the connection refactor',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),workerTemplate=instrumentFrameAgeWorker(workerSource,[[1,1]]),r=runtime(true,{workerTemplate});t.after(r.disconnect);
 r.window.remotePaintViewer.connect({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:()=>h.issue()});await until(()=>r.window.remotePaintResult?.frameId===1).catch(()=>assert.fail(JSON.stringify({socketSetupErrors:r.stats.socketSetupErrors,state:r.window.remotePaintConnection})));
 assert.deepEqual(r.stats.socketSetupErrors,[]);r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);
});

for(const workerMode of [false,true])test(`revoked ${workerMode?'Worker':'main'} public access cannot mint again on online/resume`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),r=runtime(workerMode);t.after(r.disconnect);let calls=0,grant;
 r.window.remotePaintViewer.connect({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async()=>{calls++;grant=await h.issue();return grant;}});await until(()=>r.window.remotePaintResult?.frameId===1);
 assert.equal((await h.api(h.tickets+'/'+grant.grantId,{method:'DELETE'})).status,200);await until(()=>r.window.remotePaintConnection?.state==='failed');
 r.window.dispatchEvent({type:'online'});r.document.dispatchEvent({type:'resume'});r.window.dispatchEvent({type:'pageshow'});await delay(100);
 assert.equal(calls,1);assert.equal(r.window.remotePaintConnection.state,'failed');assert.equal(r.window.remotePaintConnection.code,'VIEWER_ACCESS_ENDED');assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
});

function framed(t,h,workerMode,getTicket){
 const parentWindow={},parentOrigin='https://host.example',build='b'.repeat(64),r=runtime(workerMode,{publicMode:true,viewerBuild:build,parentWindow,configFetch:async()=>new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:h.base,allowedParentOrigins:[parentOrigin],viewerBuild:build}),{headers:{'content-type':'application/json'}})});
 r.window.postMessage=(data,targetOrigin,ports)=>{assert.equal(targetOrigin,audience);const transferred=structuredClone({data,ports},{transfer:ports});queueMicrotask(()=>r.window.dispatchEvent({type:'message',...transferred,origin:parentOrigin,source:parentWindow}));};
 const client=new ViewerFrameConnection({frameWindow:r.window,frameOrigin:audience,gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket});t.after(()=>{client.close();r.window.dispatchEvent({type:'pagehide',persisted:false});});return {r,client};
}

for(const workerMode of [false,true])test(`authenticated parent port drives actual ${workerMode?'Worker':'main'} frames, refresh and revocation without reauthorizing on resume`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)});let calls=0,lastGrant;
 const {r,client}=framed(t,h,workerMode,async request=>{calls++;if(request.previousGrantId){const response=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{ttlSeconds:1}});if(response.status===200){lastGrant=response.data;return lastGrant;}}lastGrant=await h.issue('readonly',{ttlSeconds:1});return lastGrant;});
 await client.ready;assert.equal(calls,0);assert.equal((await client.connect()).state,'connected');await until(()=>r.window.remotePaintResult?.frameId===1);await until(()=>calls>=2&&r.stats.events.filter(e=>e.state==='connected').length>=2);assert.equal(client.state.sessionId,h.sessionId);assert.ok(r.stats.draws>0);
 await h.api(h.tickets+'/'+lastGrant.grantId,{method:'DELETE'});await until(()=>client.state.state==='failed');assert.equal(client.state.code,'VIEWER_ACCESS_ENDED');const before=calls;r.window.dispatchEvent({type:'online'});r.document.dispatchEvent({type:'resume'});await delay(100);assert.equal(calls,before);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
 assert.equal((await client.connect()).state,'connected');await until(()=>r.window.remotePaintResult?.frameId===1);client.close();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
});

for(const workerMode of [false,true])test(`authenticated parent disconnect fences late ticket access in the ${workerMode?'Worker':'main'} path`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256,viewerBuild:'b'.repeat(64)}),gate=pending(),started=pending();let calls=0;
 const {r,client}=framed(t,h,workerMode,async()=>{calls++;started.resolve();await gate.promise;return h.issue();});const connecting=client.connect(),rejected=assert.rejects(connecting,e=>e.code==='CHANNEL_ABORTED');await started.promise;await client.disconnect();await rejected;assert.equal(h.resolutions.length,0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);gate.resolve();await delay(30);assert.equal(h.resolutions.length,0);await client.connect();await until(()=>r.window.remotePaintResult?.frameId===1);assert.equal(calls,2);await client.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
});
