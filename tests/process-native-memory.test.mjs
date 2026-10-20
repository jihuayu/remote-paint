import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createNativeProcessMemorySampler,decodeNativeMemoryReply,NATIVE_MEMORY_LIMITS} from './process-native-memory.mjs';
const native={skip:process.platform!=='darwin'},own=[{id:process.pid,type:'test-node'}],fixture=fileURLToPath(new URL('./fixtures/native-memory-child.mjs',import.meta.url));
const launch=mode=>()=>spawn(process.execPath,[fixture,mode],{stdio:['pipe','pipe','pipe']});
const receive=async(child,event)=>{for(;;){const[m]=await once(child,'message');if(m.event===event)return m;}};
async function stop(child){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGKILL');await done;}}
test('native sampler reads actual RSS/virtual/physical footprint repeatedly through one owned persistent helper',native,async t=>{
 const s=await createNativeProcessMemorySampler(),helper=s.child.pid;try{
  const rows=[];for(let n=0;n<10;n++){const value=await s.sample(own);assert.equal(value.sampling.helperPid,helper);assert.equal(value.sampling.requestId,n+1);assert.ok(value.sampling.elapsedMs<5000);const p=value.processes[0];assert.equal(p.pid,process.pid);assert.equal(p.identity.uid,process.getuid());assert.ok(p.rssBytes>0&&p.physicalFootprintBytes>0&&p.virtualBytes>=p.rssBytes);assert.equal(p.bytes,p.rssBytes);assert.equal(p.pssBytes,undefined);rows.push(p);}
  assert.ok(rows.every(p=>p.identity.startSeconds===rows[0].identity.startSeconds&&p.identity.startMicroseconds===rows[0].identity.startMicroseconds));t.diagnostic(JSON.stringify({scope:'ActualDarwinlibproc',helper,sample:rows[0]}));
 }finally{const end=await s.close();assert.equal(end.exited,true);assert.equal(end.exitCode,0);}
});
test('actual touched 64MiB child allocation increases native RSS and physical footprint without inventing release semantics',native,async t=>{
 const child=fork(fixture,['allocate'],{execArgv:['--expose-gc'],stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready'),s=await createNativeProcessMemorySampler();try{
  await ready;const info=[{id:child.pid,type:'allocation-child'}],before=(await s.sample(info)).processes[0],allocated=receive(child,'allocated');child.send('allocate');const nativeChild=await allocated,after=(await s.sample([{...info[0],identity:before.identity}])).processes[0];
  const rssGrowth=after.rssBytes-before.rssBytes,footprintGrowth=after.physicalFootprintBytes-before.physicalFootprintBytes;assert.ok(rssGrowth>=48*1024*1024,JSON.stringify({before,after}));assert.ok(footprintGrowth>=48*1024*1024);assert.ok(Math.abs(after.rssBytes-nativeChild.rssBytes)<8*1024*1024);assert.equal(after.identity.ppid,process.pid);
  const released=receive(child,'released');child.send('release');await released;const final=(await s.sample(info)).processes[0];assert.ok(final.rssBytes>=0);t.diagnostic(JSON.stringify({scope:'Actual64MiBdirtyallocation;releaseRSSnotpromised',before,after,final,rssGrowth,footprintGrowth}));
 }finally{await stop(child);await s.close();}
});
test('terminated target is a failed fresh batch and never becomes a zero or a cached positive row',native,async()=>{
 const child=fork(fixture,['allocate'],{stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready'),s=await createNativeProcessMemorySampler();try{
  await ready;const original=(await s.sample([{id:child.pid,type:'child'}])).processes[0];await stop(child);
  await assert.rejects(s.sample([{id:child.pid,type:'child',identity:original.identity}]),e=>['NATIVE_MEMORY_OS_READ','NATIVE_MEMORY_IDENTITY_CHANGED'].includes(e.code)&&e.failedPid===child.pid);
  const fresh=await s.sample(own);assert.equal(fresh.processes.length,1);assert.equal(fresh.processes[0].pid,process.pid);assert.equal(fresh.sampling.requestId,3);
 }finally{await stop(child);await s.close();}
});
test('expected start identity and bounded single pending request prevent stale PID attribution and unbounded queues',native,async()=>{
 const s=await createNativeProcessMemorySampler();try{
  const first=(await s.sample(own)).processes[0];await assert.rejects(s.sample([{...own[0],identity:{...first.identity,startSeconds:first.identity.startSeconds+1}}]),e=>e.code==='NATIVE_MEMORY_IDENTITY_CHANGED');
  const a=s.sample(own),b=s.sample(own);await assert.rejects(b,e=>e.code==='NATIVE_MEMORY_BUSY');assert.equal((await a).processes[0].pid,process.pid);
  for(const value of [[],[...own,...own],[{id:0,type:'bad'}],[{id:2147483648,type:'bad'}],Array.from({length:1025},(_,n)=>({id:n+1,type:'many'}))])await assert.rejects(s.sample(value),e=>e.code==='NATIVE_MEMORY_INVENTORY');
 }finally{await s.close();}
});
test('fixed binary decoder rejects foreign/duplicate/unsafe/truncated/invalid-clock rows rather than filling gaps',()=>{
 const id=process.pid,reply=(pids=[id])=>{const b=Buffer.alloc(32+56*pids.length);b.write('RPM1');b.writeUInt32BE(1,4);b.writeBigUInt64BE(1n,8);b.writeUInt32BE(pids.length,16);for(const[n,pid]of pids.entries()){const p=32+n*56;b.writeUInt32BE(pid,p);b.writeUInt32BE(7,p+12);b.writeBigUInt64BE(100n,p+16);b.writeBigUInt64BE(1024n,p+32);b.writeBigUInt64BE(2048n,p+40);b.writeBigUInt64BE(512n,p+48);}return b;};
 for(const bad of [reply([id+1]),reply().subarray(0,40),reply([id,id])])assert.throws(()=>decodeNativeMemoryReply(bad,own,1));
 for(const mutate of [b=>b.writeBigUInt64BE(9007199254740992n,64),b=>b.writeUInt32BE(1000000,56),b=>b.writeUInt32BE(0,44),b=>b.write('BAD1')]){const b=reply();mutate(b);assert.throws(()=>decodeNativeMemoryReply(b,own,1));}
 assert.throws(()=>decodeNativeMemoryReply(reply(),[...own,{id:id+1,type:'missing'}],1));assert.throws(()=>decodeNativeMemoryReply(reply(),own,2));
});
test('real unresponsive helper times out at2s, is reaped, never automatically restarts, and cannot return a previous sample',async t=>{
 let starts=0;const spawnProcess=(...args)=>{starts++;return launch('hang')(...args);},s=await createNativeProcessMemorySampler({spawnProcess,executable:'explicit-fault-fixture'}),started=performance.now();try{
  await assert.rejects(s.sample(own),e=>e.code==='NATIVE_MEMORY_REQUEST_TIMEOUT'&&e.owner.exited&&e.owner.signal==='SIGKILL');assert.equal(starts,1);assert.ok(performance.now()-started<5000);await assert.rejects(s.sample(own));assert.equal(starts,1);t.diagnostic(JSON.stringify({scope:'Actualfaultchild/2sdeadline/ownedSIGKILLreap',starts,elapsedMs:performance.now()-started,limits:NATIVE_MEMORY_LIMITS}));
 }finally{const owner=await s.close();assert.equal(owner.exited,true);}
});
test('actual helper protocol errors and row-count overflow fail with owned process cleanup',async()=>{
 await assert.rejects(createNativeProcessMemorySampler({spawnProcess:launch('malformed-ready'),executable:'explicit-fault-fixture'}),e=>e.code==='NATIVE_MEMORY_PROTOCOL'&&e.owner.exited);
 const s=await createNativeProcessMemorySampler({spawnProcess:launch('oversize-count'),executable:'explicit-fault-fixture'});try{await assert.rejects(s.sample(own),e=>e.code==='NATIVE_MEMORY_OUTPUT_LIMIT'&&e.owner.exited);}finally{assert.equal((await s.close()).exited,true);}
});
