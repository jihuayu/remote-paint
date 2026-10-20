import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ViewerFrameConnection} from '../sdk/viewer-frame.mjs';
import {ViewerPort} from '../sdk/viewer-channel.mjs';
import {emptyViewerPerformance} from '../sdk/viewer-telemetry.mjs';
const origin='https://viewer.example',gateway='https://gateway.example',sessionId='ses_fixture';
async function until(check){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Host telemetry deadline');}
const performanceSnapshot=(extra={})=>({...emptyViewerPerformance(),stage:'scene-submitted',connectionGeneration:1,frameId:1,pageEpoch:1,viewportVersion:1,width:640,height:480,worker:true,presentation:'cpu-2d',framesSubmitted:1,lastFrameAgoMs:0,...extra});
const firstSnapshot=(extra={})=>({scope:'viewer',stage:'scene-submitted',clock:'viewer-ui-receipt',connectionGeneration:1,frameId:1,pageEpoch:1,viewportVersion:1,width:640,height:480,worker:true,presentation:'cpu-2d',startPhase:'renderer-init',connectToReceiptMs:10,...extra});
function fixture(t,options={}){
 let peer,grant;const samples=[],firsts=[],states=[],errors=[];
 const frame=new ViewerFrameConnection({frameOrigin:origin,gatewayOrigin:gateway,sessionId,role:'readonly',getTicket:()=>{const ticket='vwt1.'+'a'.repeat(43);grant={grantId:'vgr_'+randomUUID(),sessionId,version:'v1',role:'readonly',audience:origin,expiresAt:new Date(Date.now()+60000).toISOString(),ticket,streamPath:'/v1/viewer/stream?ticket='+ticket};return grant;},onState:s=>states.push(s),onError:e=>errors.push(e),onPerformance:s=>samples.push(s),onFirstFrame:s=>firsts.push(s),...options,frameWindow:{postMessage(text,targetOrigin,ports){assert.equal(targetOrigin,origin);const hello=JSON.parse(text);peer=new ViewerPort({port:ports[0],channel:hello.channel,handle:async method=>{if(method==='connect'){await peer.request('ticket',{reason:'connect',previousGrantId:null});peer.notify('state',{state:'connected',sessionId,role:'readonly',version:'v1'});return {accepted:true};}if(method==='disconnect'){peer.notify('state',{state:'paused',sessionId,role:'readonly',version:'v1'});return {disconnected:true};}throw new Error('Unexpected method');}});queueMicrotask(()=>peer.notify('ready',{gatewayOrigin:gateway,viewerBuild:'b'.repeat(64)}));}}});
 t.after(()=>{frame.close();peer.close();});return {frame,peer,samples,firsts,states,errors,get grant(){return grant;},emit(name,snapshot,grantId=grant?.grantId){peer.notify(name,{grantId,snapshot});}};
}
test('Frame telemetry accepts finite current issued-grant snapshots for readonly display without private transport identity',async t=>{
 const f=fixture(t);await f.frame.ready;assert.equal(f.frame.performance.stage,'unavailable');assert.equal(f.frame.firstFrame,null);await f.frame.connect();f.emit('first-frame',firstSnapshot());f.emit('performance',performanceSnapshot());await until(()=>f.samples.some(s=>s.stage==='scene-submitted'));
 assert.equal(f.firsts.length,1);assert.deepEqual(f.frame.firstFrame,firstSnapshot());assert.ok(Object.isFrozen(f.frame.firstFrame));assert.ok(Object.isFrozen(f.frame.performance));assert.equal(f.frame.performance.frameId,1);assert.doesNotMatch(JSON.stringify([f.frame.performance,f.frame.firstFrame]),/grantId|ticket|sessionId|peerId|private/);
});
test('Frame ignores valid telemetry before ticket issuance, from another grant, and from retired frame namespaces',async t=>{
 const f=fixture(t);await f.frame.ready;f.emit('performance',performanceSnapshot(),'vgr_'+randomUUID());await delay(10);assert.equal(f.frame.performance.stage,'unavailable');await f.frame.connect();f.emit('performance',performanceSnapshot({connectionGeneration:2,frameId:10,pageEpoch:2}));await until(()=>f.frame.performance.frameId===10);const accepted=f.frame.performance;
 for(const [snapshot,grantId]of [[performanceSnapshot({connectionGeneration:99}), 'vgr_'+randomUUID()],[performanceSnapshot({connectionGeneration:1}),f.grant.grantId],[performanceSnapshot({connectionGeneration:2,frameId:99,pageEpoch:1}),f.grant.grantId],[performanceSnapshot({connectionGeneration:2,frameId:9,pageEpoch:2}),f.grant.grantId]])f.emit('performance',snapshot,grantId);
 await delay(20);assert.equal(f.frame.performance,accepted);assert.equal(f.frame.state.state,'connected');
});
test('Frame accepts idle samples of one frame, but drops decreasing submitted counts and duplicate first-frame events',async t=>{
 const f=fixture(t);await f.frame.connect();f.emit('first-frame',firstSnapshot());f.emit('performance',performanceSnapshot({framesSubmitted:3}));await until(()=>f.frame.performance.framesSubmitted===3);f.emit('performance',performanceSnapshot({framesSubmitted:3,lastFrameAgoMs:250,submittedFramesPerSecond:0}));f.emit('first-frame',firstSnapshot());await until(()=>f.frame.performance.lastFrameAgoMs===250);f.emit('performance',performanceSnapshot({framesSubmitted:2}));await delay(10);assert.equal(f.firsts.length,1);assert.equal(f.frame.performance.framesSubmitted,3);assert.equal(f.frame.performance.lastFrameAgoMs,250);
});
test('Frame resets on reconnect/disconnect/close and accepts first frame only for a newer generation of its new grant',async t=>{
 const f=fixture(t);await f.frame.connect();const old=f.grant.grantId;f.emit('first-frame',firstSnapshot());f.emit('performance',performanceSnapshot());await until(()=>f.frame.firstFrame);await f.frame.disconnect();assert.equal(f.frame.firstFrame,null);assert.equal(f.frame.performance.stage,'unavailable');await f.frame.connect();f.emit('performance',performanceSnapshot({connectionGeneration:2}),old);f.emit('first-frame',firstSnapshot());await delay(10);assert.equal(f.frame.firstFrame,null);f.emit('first-frame',firstSnapshot({connectionGeneration:2}));f.emit('performance',performanceSnapshot({connectionGeneration:2}));await until(()=>f.frame.firstFrame?.connectionGeneration===2);assert.equal(f.firsts.length,2);f.frame.close();assert.equal(f.frame.firstFrame,null);assert.equal(f.frame.performance.stage,'unavailable');
});
test('Frame validates every finite envelope and closes malformed/extra/nonfinite/current or old-grant telemetry',async t=>{
 for(const value of [{grantId:'private',snapshot:performanceSnapshot()},{grantId:'vgr_'+randomUUID(),snapshot:{...performanceSnapshot(),scene:{private:true}}},{grantId:'vgr_'+randomUUID(),snapshot:performanceSnapshot({lastFrameAgoMs:Infinity})},{grantId:'vgr_'+randomUUID(),snapshot:performanceSnapshot(),private:'secret'}]){
  const f=fixture(t);await f.frame.connect();f.peer.notify('performance',value);await until(()=>f.frame.state.state==='closed');assert.equal(f.frame.state.code,'CHANNEL_PROTOCOL');assert.equal(f.frame.performance.stage,'unavailable');assert.ok(f.errors.every(e=>e.message==='Viewer channel unavailable'));
 }
});
test('Frame reentrant first-frame callback may close without delivering queued performance',async t=>{
 let frame;const f=fixture(t,{onFirstFrame:()=>frame.close()});frame=f.frame;await frame.connect();f.emit('first-frame',firstSnapshot());f.emit('performance',performanceSnapshot());await until(()=>frame.state.state==='closed');assert.equal(frame.firstFrame,null);assert.equal(frame.performance.stage,'unavailable');assert.ok(!f.samples.some(s=>s.stage==='scene-submitted'));
});
