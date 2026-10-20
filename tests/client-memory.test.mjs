import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ClientMemory,MemoryLimitError,memoryPolicy} from '../protocol/client-memory.mjs';
import {AssetCache} from '../protocol/asset-wire.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('buffer ownership counts backing storage once across receive, assembly and raw cache',()=>{
 const memory=new ClientMemory(),buffer=new Uint8Array(1024),receive=memory.buffer('receive',buffer),raw=memory.buffer('raw',buffer.subarray(44));
 assert.equal(memory.snapshot().jsBufferBytes,1024);assert.equal(memory.snapshot().referencedJsBytes,2048);
 receive();receive();assert.equal(memory.snapshot().jsBufferBytes,1024);raw();assert.equal(memory.snapshot().jsBufferBytes,0);assert.equal(memory.snapshot().owners,0);
});
test('Wasm heap/cache and GPU allocation/cache views are not added twice; limits are transactional',()=>{
 const policy={...memoryPolicy(),js:4096,total:16384,wasm:8192,gpu:8192,render:8192},memory=new ClientMemory(policy);
 memory.observe({HEAPU8:new Uint8Array(8192),getDecodeCacheUsedBytes:()=>512},{getResourceCacheUsageBytes:()=>4096});
 const wasm=memory.reserve('passes',2048,'wasm'),gpu=memory.reserve('rasters',2048,'gpu');
 assert.equal(memory.snapshot().residentEstimate,12288+memory.snapshot().jsIndexEstimateBytes);
 const bytes=memory.reserve('readback',1024);assert.throws(()=>bytes.resize(8192),MemoryLimitError);assert.equal(memory.snapshot().domains.js,1024+memory.snapshot().jsIndexEstimateBytes);
 bytes();wasm();gpu();assert.equal(memory.snapshot().owners,0);
});
test('pressure evicts optional owners before refusing a mandatory allocation',()=>{
 const memory=new ClientMemory({...memoryPolicy(),js:2048}),optional=memory.buffer('chunks',new ArrayBuffer(768));let trims=0;
 memory.addTrimmer(()=>{optional();trims++;});const raw=memory.buffer('raw',new ArrayBuffer(768));assert.equal(trims,1);assert.equal(memory.snapshot().jsBufferBytes,768);
 assert.throws(()=>memory.buffer('raw',new ArrayBuffer(2048)),MemoryLimitError);assert.equal(memory.snapshot().jsBufferBytes,768);raw();
});
test('assembly adoption, cache release and connection teardown return all buffer ownership',()=>{
 const memory=new ClientMemory(),assets=new AssetCache({memory}),gate=new LiveFrameGate({memory}),payload=Uint8Array.from(Buffer.from('skiapict-test-resource-long-enough')),id=hash(payload);
 assets.put(id,payload);const manifest={id,bytes:payload.length,chunks:[{id,kind:'skp'}]},assembled=assets.assemble(manifest);
 gate.put(id,assembled);assets.releaseAssembly(assembled);assert.equal(memory.snapshot().jsBufferBytes,payload.length*2);
 gate.committed={requiredResources:[id]};assert.equal(gate.release(id),false);assert.equal(gate.resources.size,1,'live dependencies must stay pinned');
 gate.clear();assets.dispose();assert.equal(memory.snapshot().jsBufferBytes,0);assert.equal(memory.snapshot().owners,0);assert.equal(memory.trimmers.size,0);
});
test('chunk pressure produces a missing dependency, then a complete resource can be reassembled',()=>{
 const memory=new ClientMemory(),assets=new AssetCache({memory,byteLimit:64});
 const original=Uint8Array.from(Buffer.from('skiapict-original-resource-long-enough')),other=new Uint8Array(60).fill(5),id=hash(original),manifest={id,bytes:original.length,chunks:[{id,kind:'skp'}]};
 assets.put(id,original);assets.put(hash(other),other);assert.equal(assets.assemble(manifest),null);assert.equal(assets.stats.evictions,1);
 assets.clear();assets.put(id,original);const restored=assets.assemble(manifest);assert.deepEqual(restored,original);assets.releaseAssembly(restored);assets.dispose();assert.equal(memory.snapshot().owners,0);
});
test('actual Wasm arena growth is a restart condition, not pretend memory returned by cache eviction',()=>{
 const memory=new ClientMemory({...memoryPolicy(),wasm:1024});let trimmed=0;memory.addTrimmer(()=>trimmed++);
 assert.throws(()=>memory.observe({HEAPU8:new Uint8Array(2048)}),/runtime restart required/);assert.equal(trimmed,1);assert.equal(memory.snapshot().observed.wasmHeapBytes,2048);
 assert.equal(memoryPolicy({deviceMemory:4}).profile,'compact');assert.equal(memoryPolicy({deviceMemory:8}).profile,'standard');assert.throws(()=>memoryPolicy({profile:'unbounded'}),/profile/);
});

test('retired Wasm instances remain in the combined budget until garbage collection',()=>{
 const memory=new ClientMemory({...memoryPolicy(),wasm:8192,total:16384}),first={HEAPU8:new Uint8Array(8192)},second={HEAPU8:new Uint8Array(8192)};
 memory.retire(first);memory.retire(second);assert.equal(memory.snapshot().retiredWasmBytes,16384);
 assert.throws(()=>memory.observe({HEAPU8:new Uint8Array(4096)}),/combined resident/);assert.equal(memory.snapshot().retiredArenaCount,2);
});

test('tiny chunks cannot evade the JS budget through hash/map/owner overhead',()=>{
 const memory=new ClientMemory({...memoryPolicy(),js:64*1024}),assets=new AssetCache({memory});
 for(let i=0;i<100;i++){const payload=new Uint8Array([i]);assets.put(hash(payload),payload);}
 const snapshot=memory.snapshot();assert.ok(snapshot.jsBufferBytes<100);assert.ok(snapshot.jsIndexEstimateBytes>snapshot.jsBufferBytes*100);assert.ok(snapshot.domains.js<=memory.policy.js);assert.ok(assets.stats.evictions>0);assert.ok(snapshot.stats.pressureEvents>0);
 assets.dispose();assert.equal(memory.snapshot().domains.js,0);assert.equal(memory.snapshot().jsIndexEstimateBytes,0);
});
test('mandatory raw indexes are budgeted and pressure never drops their pinned buffers',()=>{
 const memory=new ClientMemory({...memoryPolicy(),js:16*1024}),gate=new LiveFrameGate({memory});let refused=false;
 for(let i=0;i<32;i++){const payload=new Uint8Array(32).fill(i),id=hash(payload);try{gate.put(id,payload);}catch(error){assert.ok(error instanceof MemoryLimitError);refused=true;break;}gate.committed={requiredResources:[...gate.resources.keys()]};}
 assert.ok(refused);assert.ok(gate.resources.size>0);assert.ok(memory.snapshot().jsBufferBytes<1024);assert.ok(memory.snapshot().domains.js<=memory.policy.js);
 for(const id of gate.resources.keys())assert.equal(gate.release(id),false);gate.clear();assert.equal(memory.snapshot().domains.js,0);
});
test('shared backing buffers deduplicate storage but retain each independent owner index estimate',()=>{
 const memory=new ClientMemory(),buffer=new ArrayBuffer(1024),a=memory.buffer('raw',buffer,{metadataBytes:512}),b=memory.buffer('chunks',buffer,{metadataBytes:640});
 assert.equal(memory.snapshot().jsBufferBytes,1024);assert.equal(memory.snapshot().ownerMetadataBytes,1152);a();assert.equal(memory.snapshot().ownerMetadataBytes,640);assert.equal(memory.snapshot().jsBufferBytes,1024);b();assert.equal(memory.snapshot().domains.js,0);
 assert.throws(()=>memory.reserve('bad',1,'wasm',{metadataBytes:-1}),/Invalid memory/);
});
test('decode work splits ownership without dropping the preflight headroom or bypassing cache caps',()=>{
 const memory=new ClientMemory({...memoryPolicy(),wasm:8192,pictures:2048}),work=memory.reserve('pictureDecode',4096,'wasm'),picture=work.split('pictures',2048);
 assert.equal(memory.snapshot().domains.wasm,4096);assert.equal(memory.snapshot().decodeHeadroomBytes,4096);assert.equal(memory.snapshot().categories.pictureDecode,2048);
 assert.throws(()=>work.split('pictures',512),MemoryLimitError);assert.equal(memory.snapshot().domains.wasm,4096);assert.equal(memory.snapshot().categories.pictureDecode,2048);
 memory.observeWasm({HEAPU8:new Uint8Array(4096)});assert.throws(()=>memory.reserve('rasterWork',1,'wasm'),/headroom/);picture();work();assert.equal(memory.snapshot().owners,0);assert.equal(memory.snapshot().decodeHeadroomBytes,0);
});
test('actual Skia GPU cache usage cannot exceed the GPU profile while texture estimates are small',()=>{
 const memory=new ClientMemory({...memoryPolicy(),gpu:1024});assert.throws(()=>memory.observe({HEAPU8:new Uint8Array(8192)},{getResourceCacheUsageBytes:()=>2048}),/GPU cache\/texture/);assert.equal(memory.snapshot().observed.gpuCacheBytes,2048);
});
