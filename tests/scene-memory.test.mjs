import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientMemory,MemoryLimitError,estimateJsMetadata,memoryPolicy} from '../protocol/client-memory.mjs';
import {LiveFrameGate,makeDelta} from '../protocol/live-wire.mjs';
import {snapshot,frame,payload,hash} from './live-helpers.mjs';

function setup(){const memory=new ClientMemory(),gate=new LiveFrameGate({memory}),scene=snapshot();gate.put(hash,payload);return {memory,gate,scene};}
test('metadata traversal counts shared objects once and bounds depth, entries and retained strings',()=>{
 const child={label:'geometry',position:[1,2,3]},shared=estimateJsMetadata({a:child,b:child}),copies=estimateJsMetadata({a:child,b:{label:'geometry',position:[1,2,3]}});
 assert.ok(copies>shared);assert.ok(estimateJsMetadata({text:'x'.repeat(1000)})>estimateJsMetadata({text:'x'}));
 assert.throws(()=>estimateJsMetadata({text:'x'.repeat(1000)},{maxBytes:1024}),MemoryLimitError);
 assert.throws(()=>estimateJsMetadata([1,2,3,4],{maxNodes:4}),/traversal/);
 let deep={};for(let i=0;i<70;i++)deep={next:deep};assert.throws(()=>estimateJsMetadata(deep),/traversal/);
 assert.throws(()=>estimateJsMetadata({binary:new Uint8Array(1024)}),/JSON-like/);
});
test('staged and committed scene metadata own budget until replacement or recovery',()=>{
 const {memory,gate,scene}=setup();gate.stage(frame(scene,1));const first=memory.snapshot().categories.sceneMetadata;assert.ok(first>0);gate.commit(1,1);assert.equal(memory.snapshot().categories.sceneMetadata,first);
 const next=snapshot({translation:10});gate.stage(frame(next,2,1,{scene:undefined,delta:makeDelta(scene.scene,next.scene)}));assert.ok(memory.snapshot().categories.sceneMetadata>first);
 const both=memory.snapshot().categories.sceneMetadata;assert.throws(()=>gate.commit(1,2,()=>{throw new Error('decode failed');}),/decode failed/);assert.equal(memory.snapshot().categories.sceneMetadata,both);assert.equal(memory.snapshot().categories.inflightRaw,undefined);
 gate.recover();assert.equal(memory.snapshot().categories.sceneMetadata,first);assert.equal(gate.committed.frameId,1);gate.clear();assert.equal(memory.snapshot().domains.js,0);
});
test('oversized retained metadata fails admission without changing the committed frame or its owners',()=>{
 const memory=new ClientMemory({...memoryPolicy(),js:payload.buffer.byteLength+64*1024}),gate=new LiveFrameGate({memory}),scene=snapshot();gate.put(hash,payload);gate.stage(frame(scene,1));gate.commit(1,1);const before=memory.snapshot();
 assert.throws(()=>gate.stage(frame(scene,2,null,{extra:'x'.repeat(memory.policy.js)})),MemoryLimitError);assert.equal(gate.committed.frameId,1);assert.equal(gate.pending,null);assert.equal(memory.snapshot().owners,before.owners);assert.equal(memory.snapshot().categories.sceneMetadata,before.categories.sceneMetadata);
 gate.clear();assert.equal(memory.snapshot().owners,0);
});
test('clear during async display preserves actual buffer pins and scene ownership until the canceled display ends',async()=>{
 const {memory,gate,scene}=setup();gate.stage(frame(scene,1));let finish,resources;
 const task=gate.commitAsync(1,1,async(_frame,owned)=>{resources=owned;await new Promise(r=>finish=r);});
 await assert.rejects(gate.commitAsync(1,1),/display already running/);
 const bytes=memory.snapshot().jsBufferBytes;gate.clear();assert.equal(gate.resources.size,0);assert.equal(gate.pending,null);assert.equal(gate.committed,null);assert.equal(resources.get(hash),payload);assert.equal(memory.snapshot().jsBufferBytes,bytes);assert.ok(memory.snapshot().categories.inflightRaw>0);assert.ok(memory.snapshot().categories.sceneMetadata>0);
 finish();assert.equal(await task,null);assert.equal(gate.committed,null);assert.equal(memory.snapshot().owners,0);assert.equal(memory.snapshot().domains.js,0);
});

test('a cleared generation cannot overwrite a newer committed frame after its display resumes',async()=>{
 const {memory,gate,scene}=setup();gate.stage(frame(scene,1));let finish;const old=gate.commitAsync(1,1,()=>new Promise(r=>finish=r));gate.clear();gate.put(hash,payload);gate.stage(frame(scene,2));gate.commit(1,2);const current=memory.snapshot().categories.sceneMetadata;finish();assert.equal(await old,null);assert.equal(gate.committed.frameId,2);assert.ok(memory.snapshot().categories.sceneMetadata<current);gate.clear();assert.equal(memory.snapshot().owners,0);
});
test('a display rejected after clear releases pinned raw bytes and metadata without restoring dependencies',async()=>{
 const {memory,gate,scene}=setup();gate.stage(frame(scene,1));let fail;const old=gate.commitAsync(1,1,()=>new Promise((_resolve,reject)=>fail=reject));gate.clear();fail(new Error('renderer was disposed'));await assert.rejects(old,/disposed/);assert.equal(gate.committed,null);assert.equal(memory.snapshot().owners,0);assert.equal(memory.snapshot().jsBufferBytes,0);
});
test('copy estimates expand shared graph aliases and reject cycles before JSON allocation',()=>{
 const shared={long:'x'.repeat(1000)},graph={a:shared,b:shared};assert.ok(estimateJsMetadata(graph,{shared:false})>estimateJsMetadata(graph));const cycle={};cycle.self=cycle;assert.throws(()=>estimateJsMetadata(cycle,{shared:false}),/Cyclic/);
});
test('negotiated resource memory is mandatory, dependency-complete and immutable until raw cache release',()=>{
 const {gate,scene}=setup();gate.requireResourceMemory=true;assert.throws(()=>gate.stage(frame(scene,1)),/Missing complete/);
 const certificate={version:1,resources:{[hash]:{imageBytes:32,fontBytes:64}}};gate.stage(frame(scene,1,null,{resourceMemory:certificate}));gate.commit(1,1);
 assert.throws(()=>gate.stage(frame(scene,2,null,{resourceMemory:{version:1,resources:{}}})),/dependency/);
 assert.throws(()=>gate.stage(frame(scene,2,null,{resourceMemory:{version:1,resources:{[hash]:{imageBytes:0,fontBytes:0}}}})),/descriptor changed/);assert.equal(gate.committed.frameId,1);gate.clear();assert.equal(gate.bounds.size,0);
});
