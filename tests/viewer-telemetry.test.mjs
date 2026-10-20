import test from 'node:test';
import assert from 'node:assert/strict';
let api;try{api=await import('../sdk/viewer-telemetry.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;api={};}
const grant='vgr_00000000-0000-0000-0000-000000000001';
function clock(){let time=0,id=0;const tasks=new Map(),old=[];return {now:()=>time,setTimeout(fn,ms){const n=++id;tasks.set(n,{fn,at:time+ms});return n;},clearTimeout(n){const task=tasks.get(n);if(task)old.push(task.fn);tasks.delete(n);},advance(ms){time+=ms;for(const [n,task] of [...tasks])if(task.at<=time){tasks.delete(n);task.fn();}},get pending(){return tasks.size;},old};}
function harness(t){const timer=clock(),events=[],collector=new api.ViewerTelemetry({notify:(name,value)=>events.push({name,value,at:timer.now()}),now:timer.now,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout});t.after(()=>collector.close());return {timer,events,collector};}
function record(extra={}){return {connectionGeneration:1,worker:true,frame:{frameId:1,pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640},scene:{private:'private-source-secret'},native:{producer:'private-producer'}},result:{renderMs:2,receivedBytes:1234,resourceBytes:222,resources:3,presentation:{mode:'cpu-2d',private:'private-device'},memory:{residentEstimate:400,domains:{gpu:10},observed:{wasmHeapBytes:128,gpuCacheBytes:20}},native:{private:'private-native'},requiredResources:['private-resource']},...extra};}
function start(c){c.begin('renderer-init');assert.equal(c.bind({connectionGeneration:1,grantId:grant}),true);}

test('finite telemetry schemas reject unknown fields, accessors, inconsistent empty states and nonfinite values',()=>{
 assert.equal(typeof api.emptyViewerPerformance,'function');const empty=api.emptyViewerPerformance();assert.ok(Object.isFrozen(empty));assert.deepEqual(api.viewerPerformanceSnapshot({...empty}),empty);
 let getter=false;for(const value of [{...empty,key:'private'},{...empty,frameId:1},{...empty,receivedBytes:NaN},Object.defineProperty({...empty},'frameId',{get(){getter=true;return null;}})])assert.throws(()=>api.viewerPerformanceSnapshot(value),e=>e.code==='CHANNEL_PROTOCOL');assert.equal(getter,false);
});
test('first frame is bound to verified grant/connection and strips full scenes, source identity and diagnostics',t=>{
 const {collector:c,timer,events}=harness(t);c.begin('renderer-init');timer.advance(30);c.bind({connectionGeneration:1,grantId:grant});timer.advance(20);assert.equal(c.record(record()),true);
 const first=c.firstFrame;assert.equal(first.stage,'scene-submitted');assert.equal(first.clock,'viewer-ui-receipt');assert.equal(first.startPhase,'renderer-init');assert.equal(first.connectToReceiptMs,50);assert.equal(first.connectionGeneration,1);assert.ok(Object.isFrozen(first));assert.equal(c.envelope('first-frame').grantId,grant);assert.equal(events.filter(e=>e.name==='first-frame').length,1);assert.doesNotMatch(JSON.stringify(events),/private|sessionId|peerId|ticket|sourceKey/);assert.ok(JSON.stringify(c.performance).length<2048);
});
test('one latest snapshot and one timer coalesce a high frame rate to at most four samples per second',t=>{
 const {collector:c,timer,events}=harness(t);start(c);for(let i=1;i<=1000;i++){c.record(record({frame:{...record().frame,frameId:i}}));timer.advance(1);assert.ok(timer.pending<=1);}const samples=events.filter(e=>e.name==='performance');assert.ok(samples.length<=5);for(let i=1;i<samples.length;i++)assert.ok(samples[i].at-samples[i-1].at>=250);assert.equal(c.performance.framesSubmitted,1000);assert.equal(events.filter(e=>e.name==='first-frame').length,1);c.reset();assert.equal(timer.pending,0);assert.deepEqual(c.performance,api.emptyViewerPerformance());assert.equal(c.firstFrame,null);
});
test('performance cadence survives rapid reconnects and an old cleared timer cannot replace a new timer',t=>{
 const {collector:c,timer,events}=harness(t);start(c);c.record(record());timer.advance(10);c.begin('connection-attempt');c.bind({connectionGeneration:2,grantId:grant.replace(/1$/,'2')});c.record(record({connectionGeneration:2}));const live=timer.pending;for(const fn of timer.old)fn();assert.equal(timer.pending,live);assert.equal(events.filter(e=>e.name==='performance').length,1);timer.advance(240);assert.equal(c.performance.connectionGeneration,2);assert.equal(events.filter(e=>e.name==='performance').length,2);assert.equal(timer.pending,1);
});
test('old generations and stale frame namespaces cannot overwrite current metrics',t=>{
 const {collector:c}=harness(t);start(c);c.record(record());assert.equal(c.record(record()),false);assert.equal(c.record(record({connectionGeneration:0})),false);c.begin('connection-attempt');assert.equal(c.bind({connectionGeneration:1,grantId:grant}),false);assert.equal(c.bind({connectionGeneration:2,grantId:grant}),true);assert.equal(c.record(record({connectionGeneration:1})),false);
 assert.equal(c.record(record({connectionGeneration:2,frame:{...record().frame,pageEpoch:3,viewportVersion:2,frameId:10}})),true);assert.equal(c.record(record({connectionGeneration:2,frame:{...record().frame,pageEpoch:2,viewportVersion:2,frameId:99}})),false);assert.equal(c.record(record({connectionGeneration:2,frame:{...record().frame,pageEpoch:3,viewportVersion:1,frameId:99}})),false);assert.equal(c.record(record({connectionGeneration:2,frame:{...record().frame,pageEpoch:4,viewportVersion:2,frameId:1}})),true);
});
test('missing or invalid optional measurements remain null and estimates are explicitly labelled',t=>{
 const {collector:c}=harness(t);start(c);c.record(record({result:{presentation:{mode:'cpu-2d'},renderMs:Infinity,receivedBytes:-1}}));const p=c.performance;assert.equal(p.renderMs,null);assert.equal(p.receivedBytes,null);assert.equal(p.resourceBytes,null);assert.equal(p.wasmHeapBytes,null);assert.equal(p.gpuEstimateBytes,null);assert.equal(p.residentEstimateBytes,null);assert.equal(p.memoryScope,'client-estimate');assert.equal(p.submittedFramesPerSecond,null);
});
test('raw metric accessors are not evaluated or retained',t=>{
 const {collector:c}=harness(t);start(c);let getter=false;const result=Object.defineProperty({presentation:{mode:'cpu-2d'}},'renderMs',{get(){getter=true;throw new Error('private');}});assert.equal(c.record(record({result})),true);assert.equal(getter,false);assert.equal(c.performance.renderMs,null);
});
test('idle samples report local receipt age and zero submitted throughput without claiming physical presentation',t=>{
 const {collector:c,timer}=harness(t);start(c);c.record(record());timer.advance(250);assert.equal(c.performance.lastFrameAgoMs,250);assert.equal(c.performance.submittedFramesPerSecond,0);assert.equal(c.performance.clock,'viewer-ui-receipt');assert.equal(c.performance.stage,'scene-submitted');assert.equal(c.performance.gpuEstimateBytes,20);
});
test('reentrant reset during first-frame delivery leaves no delayed publication or retained grant',t=>{
 const timer=clock(),events=[];let c;c=new api.ViewerTelemetry({notify:name=>{events.push(name);if(name==='first-frame')c.reset();},now:timer.now,setTimeout:timer.setTimeout,clearTimeout:timer.clearTimeout});t.after(()=>c.close());start(c);c.record(record());assert.deepEqual(events,['first-frame']);assert.equal(timer.pending,0);assert.equal(c.envelope('performance'),null);assert.equal(c.firstFrame,null);
});
test('cache updates require the current binding and cannot change frame/namespace or synthesize first frame',t=>{
 const {collector:c,timer,events}=harness(t);start(c);assert.equal(c.update(1,{resourceBytes:1}),false);c.record(record());assert.equal(c.update(0,{resourceBytes:999}),false);assert.equal(c.update(1,{resourceBytes:100,resources:2,memory:{observed:{wasmHeapBytes:64},residentEstimate:200}}),true);timer.advance(250);assert.equal(c.performance.resourceBytes,100);assert.equal(c.performance.resourceCount,2);assert.equal(c.performance.wasmHeapBytes,64);assert.equal(c.performance.frameId,1);assert.equal(events.filter(e=>e.name==='first-frame').length,1);
});
test('close clears one timer permanently and malformed bindings allocate no work',t=>{
 const {collector:c,timer}=harness(t);c.begin('renderer-init');for(const binding of [{connectionGeneration:1,grantId:'private'},{connectionGeneration:NaN,grantId:grant},{connectionGeneration:1,grantId:grant,key:'private'}])assert.equal(c.bind(binding),false);assert.equal(timer.pending,0);start(c);c.record(record());c.close();timer.advance(10000);assert.equal(timer.pending,0);assert.equal(c.bind({connectionGeneration:2,grantId:grant}),false);assert.equal(c.record(record()),false);
});
