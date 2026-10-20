import test from 'node:test';
import assert from 'node:assert/strict';
import {RendererRuntime} from '../viewer/renderer-runtime.mjs';
import {ClientMemory,memoryPolicy,MemoryLimitError} from '../protocol/client-memory.mjs';

// Minimal CanvasKit/DOM fixtures. These contracts check actual runtime/ledger
// admission, factory invocation and failure ownership;not browser allocation.
const KiB=1024;
function kit(bytes=16*KiB){return {HEAPU8:new Uint8Array(bytes),wasmBinary:new ArrayBuffer(256),setDecodeCacheLimitBytes(){},getDecodeCacheUsedBytes(){return 0;}};}
function setup({total=256*KiB,wasm=128*KiB,factory}={}){
 const memory=new ClientMemory({...memoryPolicy({profile:'compact'}),total,wasm,js:64*KiB});
 const modules=[kit()];let canvasCalls=0,contextAvailable=true;
 const canvas={width:1,height:1,getContext(type){canvasCalls++;return contextAvailable&&type==='2d'?{}:null;}};
 let calls=0;
 const runtime=new RendererRuntime(modules[0],canvas,{memory,gpu:false,wasmBinary:new ArrayBuffer(256),factory:async options=>{calls++;const next=factory?await factory(options):kit();modules.push(next);return next;}});
 return {memory,runtime,canvas,modules,get calls(){return calls;},get canvasCalls(){return canvasCalls;},hideContext(){contextAvailable=false;}};
}
const noInitCharge=memory=>assert.equal(memory.snapshot().categories.wasmInitialization??0,0);

test('rotation refuses a new factory invocation when retired plus initial heap cannot fit',async()=>{
 const s=setup({total:40*KiB,wasm:32*KiB});
 await s.runtime.recycle();assert.equal(s.calls,1);
 await assert.rejects(s.runtime.recycle(),error=>error instanceof MemoryLimitError&&error.reason==='combined resident estimate');
 assert.equal(s.calls,1,'Do not instantiate an arena that cannot fit');
 assert.equal(s.memory.snapshot().retiredArenaCount,2);noInitCharge(s.memory);
 s.runtime.dispose();assert.equal(s.memory.snapshot().owners,0);
});

test('factory rejection releases admission and keeps old arena charged before explicit retry',async()=>{
 let reject=true;const s=setup({factory:async()=>{if(reject)throw new Error('fixture-init-failure');return kit();}});
 await assert.rejects(s.runtime.recycle(),/fixture-init-failure/);noInitCharge(s.memory);
 assert.equal(s.memory.snapshot().retiredArenaCount,1);
 reject=false;await s.runtime.recycle();assert.equal(s.calls,2);noInitCharge(s.memory);
 s.runtime.dispose();assert.equal(s.memory.snapshot().owners,0);assert.equal(s.memory.snapshot().retiredArenaCount,2);
});

test('a factory returning a larger heap is checked and its failed backing remains charged',async()=>{
 const s=setup({wasm:48*KiB,factory:async()=>kit(64*KiB)});
 await assert.rejects(s.runtime.recycle(),MemoryLimitError);
 assert.equal(s.calls,1);assert.equal(s.canvasCalls,1,'Reject actual heap growth before constructing presenter');
 assert.equal(s.memory.snapshot().retiredArenaCount,2);assert.equal(s.memory.snapshot().retiredWasmBytes,80*KiB);noInitCharge(s.memory);
 s.runtime.dispose();assert.equal(s.memory.snapshot().owners,0);
});

test('presenter construction failure retires the newly created arena and releases admission',async()=>{
 const s=setup();s.hideContext();
 await assert.rejects(s.runtime.recycle(),/Cannot allocate Viewer canvas/);
 assert.equal(s.memory.snapshot().retiredArenaCount,2);assert.equal(s.memory.snapshot().retiredWasmBytes,32*KiB);noInitCharge(s.memory);
 s.runtime.dispose();assert.equal(s.memory.snapshot().owners,0);
});

test('disposal during initialization keeps admission until settlement and creates no new presenter',async()=>{
 let finish;const s=setup({factory:()=>new Promise(resolve=>{finish=()=>resolve(kit());})});
 const pending=s.runtime.recycle();await Promise.resolve();assert.equal(s.calls,1);
 assert.equal(s.memory.snapshot().categories.wasmInitialization,16*KiB);
 s.runtime.dispose();assert.equal(s.memory.snapshot().categories.wasmInitialization,16*KiB);
 finish();await assert.rejects(pending,/disposed/);
 assert.equal(s.canvasCalls,1);assert.equal(s.canvas.width,0);assert.equal(s.memory.snapshot().owners,0);
 assert.equal(s.memory.snapshot().retiredArenaCount,2);noInitCharge(s.memory);
});

test('overlapping recycle callers share one admitted actual initialization',async()=>{
 let finish;const s=setup({factory:()=>new Promise(resolve=>{finish=()=>resolve(kit());})});
 const a=s.runtime.recycle(),b=s.runtime.recycle();await Promise.resolve();assert.equal(s.calls,1);
 assert.equal(s.memory.snapshot().categories.wasmInitialization,16*KiB);
 finish();await Promise.all([a,b]);assert.equal(s.calls,1);noInitCharge(s.memory);
 s.runtime.dispose();assert.equal(s.memory.snapshot().owners,0);
});
