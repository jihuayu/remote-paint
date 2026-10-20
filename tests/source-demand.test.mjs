import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceDemand} from '../live/source-demand.mjs';

test('display,observation,recording and page-run consumers keep independent clock/encoding demand',()=>{
 const changes=[],d=new SourceDemand({onChange:()=>changes.push(d.snapshot())});
 const page=d.acquirePageRun();assert.deepEqual(d.snapshot(),{display:0,observation:0,recording:0,pageRun:1,encoding:0,clock:1,closed:false,maxPageRuns:128});
 d.setStreams({observation:1,recording:1});assert.equal(d.display,0);assert.equal(d.encoding,2);assert.equal(d.clock,3);
 d.setDisplay(2);page();assert.equal(d.encoding,4);assert.equal(d.clock,4);assert.equal(d.pageRuns,0);
 d.setDisplay(0);assert.equal(d.encoding,2);d.setStreams({});assert.equal(d.clock,0);assert.equal(changes.length,6);
});
test('invalid aggregate updates are atomic and cannot remove another consumer',()=>{
 const d=new SourceDemand();d.setStreams({display:2,observation:1});const expected=d.snapshot();
 for(const value of [null,[],{display:-1},{display:1.5},{observation:Infinity},{recording:Number.MAX_SAFE_INTEGER},{display:1024,recording:1},{unknown:1}]){assert.throws(()=>d.setStreams(value));assert.deepEqual(d.snapshot(),expected);}
 assert.equal(d.setStreams({display:2,observation:1}),false);assert.equal(Object.isFrozen(d.snapshot()),true);
});
test('releasing one lease twice never releases another page-run or a stream',()=>{
 const d=new SourceDemand();d.setDisplay(1);const first=d.acquirePageRun(),second=d.acquirePageRun();assert.equal(first(),true);assert.equal(first(),false);assert.equal(d.pageRuns,1);assert.equal(d.clock,2);second();assert.equal(d.clock,1);d.close();assert.equal(second(),false);
});
test('page-run capacity rejects before admission and recovers after actual release',()=>{
 const d=new SourceDemand({maxPageRuns:2}),first=d.acquirePageRun(),second=d.acquirePageRun();assert.throws(()=>d.acquirePageRun(),{code:'PAGE_RUN_LIMIT'});assert.equal(d.pageRuns,2);first();const third=d.acquirePageRun();assert.equal(d.pageRuns,2);second();third();assert.equal(d.clock,0);
});
test('AbortSignal ends only its own lease and already-aborted requests never consume capacity',()=>{
 const d=new SourceDemand({maxPageRuns:2}),abort=new AbortController(),other=d.acquirePageRun();abort.abort();assert.throws(()=>d.acquirePageRun({signal:abort.signal}),{name:'AbortError'});assert.equal(d.pageRuns,1);
 const live=new AbortController(),release=d.acquirePageRun({signal:live.signal});live.abort();assert.equal(d.pageRuns,1);assert.equal(release(),false);other();assert.equal(d.clock,0);assert.throws(()=>d.acquirePageRun({signal:{}}),TypeError);
});
test('closing revokes every lease,clears abort listeners and fences late callbacks',()=>{
 let changes=0;const d=new SourceDemand({onChange:()=>changes++}),signals=Array.from({length:4},()=>new AbortController()),releases=signals.map(controller=>d.acquirePageRun({signal:controller.signal}));d.setStreams({display:1,observation:1,recording:1});d.close();const after=changes;
 assert.equal(d.clock,0);assert.equal(d.encoding,0);assert.equal(d.pageRuns,0);assert.equal(d.closed,true);for(const controller of signals)controller.abort();for(const release of releases)assert.equal(release(),false);d.close();assert.equal(d.setStreams({display:1}),false);assert.equal(changes,after);assert.throws(()=>d.acquirePageRun(),/closed/);
});
test('repeated page-run lifetimes do not accumulate registry records or notifications',()=>{
 let changes=0;const d=new SourceDemand({onChange:()=>changes++});for(let n=0;n<4096;n++){const release=d.acquirePageRun();assert.equal(d.pageRuns,1);release();assert.equal(d.pageRuns,0);}assert.equal(changes,8192);assert.equal(d.clock,0);d.close();
});
test('stream-kind changes with the same total retain their identities without changing encoding need',()=>{
 const d=new SourceDemand();d.setStreams({display:1});d.setStreams({recording:1});assert.equal(d.display,0);assert.equal(d.encoding,1);assert.equal(d.snapshot().recording,1);d.setStreams({observation:1});assert.equal(d.snapshot().recording,0);assert.equal(d.snapshot().observation,1);assert.equal(d.encoding,1);
});
