import test from 'node:test';import assert from 'node:assert/strict';
import {ClientMemory,memoryPolicy} from '../protocol/client-memory.mjs';
import {ClientMemory as ScannedMemory} from './fixtures/client-memory-scan.mjs';
// Recompute the new explicitly charged aggregate storage from the old full
// scan. The oracle has no incremental category/domain/backing counters.
class ScanReference extends ScannedMemory{
 constructor(policy){super(policy);this.resizableAtBirth=new WeakSet();}
 buffer(category,view,options){const b=ArrayBuffer.isView(view)?view.buffer:view;if(b.resizable)this.resizableAtBirth.add(b);return super.buffer(category,view,options);}
 totals(){const value=super.totals(),names=new Set();let mutable=0;for(const e of this.entries.values())names.add(e.category);for(const b of this.buffers.keys())if(this.resizableAtBirth.has(b))mutable++;
  const extra=names.size*160+mutable*128;value.aggregateIndexEstimateBytes=extra;value.ledgerIndexEstimateBytes+=extra;value.jsIndexEstimateBytes+=extra;value.categories.jsIndexEstimate+=extra;value.domains.js+=extra;value.residentEstimate+=extra;return value;}
}
const classes=[ScanReference,ClientMemory],policy=()=>({...memoryPolicy({profile:'compact'}),js:48*1024,wasm:64*1024,render:32*1024,pictures:16*1024,raw:16*1024,chunks:16*1024,total:128*1024});
const attempt=operation=>{try{const value=operation();return {ok:true,kind:typeof value};}catch(e){return {ok:false,code:e.code??null,message:e.message};}};
const numeric=m=>{const {accounting,...value}=m.snapshot();return value;};
function pair(makePolicy=policy){const memories=classes.map(C=>new C(makePolicy()));return {memories,equal(){assert.deepEqual(numeric(memories[1]),numeric(memories[0]));}};}
test('incremental ledger matches scan oracle across5120 deterministic buffer/resize/split/release operations',()=>{
 const p=pair(),leases=[[],[]],buffers=Array.from({length:16},(_,i)=>new ArrayBuffer(32+i*7)),cats=['raw','chunks','receive','passes','rasterWork','pictures','pictureDecode','presentation'];let seed=571;
 const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)%n;};
 for(let step=0;step<5120;step++){
  const operation=random(6),category=cats[random(cats.length)],index=random(16),bytes=random(4096),domain=['js','wasm','gpu','browser'][random(4)],meta=random(1024),slot=random(Math.max(leases[0].length,1));
  const results=p.memories.map((m,n)=>attempt(()=>{if(operation===0){leases[n].push(m.buffer(category,buffers[index],{metadataBytes:meta}));return;}if(operation===1){leases[n].push(m.reserve(category,bytes,domain,{metadataBytes:meta}));return;}const owner=leases[n][slot];if(!owner)return;if(operation===2)return owner();if(operation===3)return owner.resize(bytes);if(operation===4){const child=owner.split(category,bytes,domain,{metadataBytes:meta});leases[n].push(child);return;}return m.check();}));
  assert.deepEqual(results[1],results[0],`step${step}`);p.equal();
 }
 for(const owners of leases)for(const release of owners)release();p.equal();assert.equal(p.memories[1].snapshot().domains.js,0);
});
test('resizing current owner can be released by a trimmer without rollback resurrecting its counters',()=>{
 for(const fail of [false,true]){
  const results=classes.map(C=>{const m=new C({...policy(),wasm:1024,js:4096}),owner=m.reserve('work',256,'wasm'),remove=m.addTrimmer(()=>owner());if(fail)m.observed.wasmHeapBytes=2048;const result=attempt(()=>owner.resize(2048));const state=numeric(m);remove();assert.throws(()=>owner.resize(1),/Invalid/);return {result,state,final:numeric(m)};});assert.deepEqual(results[1],results[0]);assert.equal(results[1].state.owners,0);
 }
});
test('split rollback and nested trimmers never restore a parent already released during admission',()=>{
 for(const js of [1024,1100]){
  const results=classes.map(C=>{const m=new C({...policy(),js}),parent=m.reserve('work',512,'wasm'),remove=m.addTrimmer(()=>parent());let child;const result=attempt(()=>{child=parent.split('raw',256,'js');});const state=numeric(m);parent();child?.();remove();return {result,state,final:numeric(m)};});assert.deepEqual(results[1],results[0]);assert.equal(results[1].final.owners,0);
 }
 const results=classes.map(C=>{const m=new C({...policy(),js:3000}),optional=m.reserve('optional',1000);let nested;const remove=m.addTrimmer(()=>{optional();nested??=m.reserve('nested',128);});const result=attempt(()=>m.reserve('mandatory',3000));nested?.();remove();return {result,state:numeric(m)};});assert.deepEqual(results[1],results[0]);
});
test('unsafe-sized refused add/resize/metadata values cannot leave rounding residue in counters',()=>{
 const p=pair(),owners=p.memories.map(m=>[m.reserve('raw',17),m.reserve('small',7,'js',{metadataBytes:11})]);
 for(const op of [(m,n)=>m.reserve('raw',Number.MAX_SAFE_INTEGER),(m,n)=>owners[n][0].resize(Number.MAX_SAFE_INTEGER),(m,n)=>m.reserve('hugeMeta',0,'wasm',{metadataBytes:Number.MAX_SAFE_INTEGER})]){const r=p.memories.map((m,n)=>attempt(()=>op(m,n)));assert.deepEqual(r[1],r[0]);p.equal();}
 owners.forEach(values=>values.forEach(release=>release()));p.equal();assert.equal(p.memories[1].snapshot().domains.js,0);
});
test('resizable backing growth/shrink is reconciled on every check with original declared owner bytes',()=>{
 const p=pair(()=>({...policy(),js:4096})),buffer=new ArrayBuffer(32,{maxByteLength:4096}),owners=p.memories.map(m=>m.buffer('raw',buffer));p.equal();
 for(const bytes of [2048,4096,16]){buffer.resize(bytes);const results=p.memories.map(m=>attempt(()=>m.check()));assert.deepEqual(results[1],results[0]);p.equal();assert.equal(p.memories[1].snapshot().jsBufferBytes,bytes);assert.equal(p.memories[1].snapshot().categories.raw,32);}
 owners.forEach(release=>release());p.equal();
});
test('detached fixed backing is reconciled before pressure instead of spuriously evicting or rejecting',()=>{
 const p=pair(()=>({...policy(),js:2600})),buffer=new ArrayBuffer(512),owners=p.memories.map(m=>m.buffer('raw',buffer));structuredClone(buffer,{transfer:[buffer]});const another=new ArrayBuffer(1024);const next=p.memories.map(m=>m.buffer('raw',another));p.equal();assert.equal(p.memories[1].stats.pressureEvents,0);owners.forEach(release=>release());next.forEach(release=>release());p.equal();
});
test('unannounced fixed detach can only overestimate admission peaks;public snapshots reconcile actual storage',()=>{
 const m=new ClientMemory({...policy(),js:4096}),buffer=new ArrayBuffer(512),a=m.buffer('raw',buffer);structuredClone(buffer,{transfer:[buffer]});const b=m.buffer('raw',new ArrayBuffer(1024));assert.equal(m.stats.peakJsBufferBytes,1536);assert.equal(m.snapshot().jsBufferBytes,1024);assert.match(m.snapshot().accounting,/upper bounds/);a();b();assert.equal(m.snapshot().jsBufferBytes,0);
});
test('normal admission does not traverse live entries or fixed backings;reporting still reconciles lengths',()=>{
 const memory=new ClientMemory(memoryPolicy({profile:'compact'})),owners=[];let scanned=0;for(const [object,name]of [[memory.entries,'values'],[memory.buffers,'values'],[memory.buffers,'keys']]){const original=object[name].bind(object);object[name]=function*(){for(const value of original()){scanned++;yield value;}};}
 for(let i=0;i<2048;i++)owners.push(memory.buffer('chunks',new ArrayBuffer(60),{metadataBytes:640}));assert.equal(scanned,0);assert.equal(memory.snapshot().owners,2048);assert.ok(scanned>=2048);owners.forEach(release=>release());assert.equal(memory.snapshot().domains.js,0);
});
test('zero-byte category owners retain aggregate metadata;prototype-like names do not corrupt totals',()=>{
 const m=new ClientMemory(),a=m.reserve('raw',0),b=m.reserve('raw',0);assert.equal(m.snapshot().aggregateIndexEstimateBytes,160);a();assert.equal(m.snapshot().categories.raw,0);assert.equal(m.snapshot().aggregateIndexEstimateBytes,160);b();assert.equal(m.snapshot().aggregateIndexEstimateBytes,0);const x=m.reserve('__proto__',7),y=m.reserve('constructor',9);assert.equal(m.snapshot().categories.__proto__,7);assert.equal(m.snapshot().categories.constructor,9);x();y();assert.equal(m.snapshot().domains.js,0);
});
