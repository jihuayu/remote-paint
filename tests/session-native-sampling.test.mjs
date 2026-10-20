import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {summarizeNativeProfile,createSessionNativeSampling} from './session-native-sampling.mjs';
const profile={modules:[{name:'Framework',uuid:'A1',baseAddress:'0x20000000000000',size:4096}],samples:[{size:16,total:512,stack:['0x20000000000008']}]};
test('native PC offsets remain exact above JS integer range and unknown frames remain explicit',()=>{
 const value=summarizeNativeProfile(profile);assert.equal(value.largestGroups[0].stack[0].offset,'0x8');assert.equal(value.estimatedAllocationBytes,512);
 const unknown=summarizeNativeProfile({...profile,samples:[{size:8,total:256,stack:['0x0']}]});assert.equal(unknown.unmappedFrames,1);assert.equal(unknown.largestGroups[0].stack[0].mapped,false);
 assert.throws(()=>summarizeNativeProfile({...profile,samples:[{size:1,total:1,stack:['<V8 Heap>']}]}),/synthetic/);
 assert.throws(()=>summarizeNativeProfile({...profile,samples:[{size:1,total:Number.MAX_SAFE_INTEGER+1,stack:[]}]}),/Unsafe/);
});
test('native sampling preserves raw evidence,does not force GC,and stops once after a capture failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-native-sampling-')),calls=[];
 const session={async send(method,params){calls.push({method,params});if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};if(method==='Memory.getSamplingProfile')return {profile};return {};}};
 try{
  const sampler=await createSessionNativeSampling(session,directory,{label:'cpu-main',frameId:'frame',targetId:'target',pageNonce:'nonce'});await sampler.start();const result=await sampler.capture(400);assert.equal(result.samples,1);
  await Promise.all([sampler.close(),sampler.close()]);assert.equal(calls.filter(c=>c.method==='Memory.stopSampling').length,1);assert.equal(calls[0].params.suppressRandomness,false);
  assert.ok(calls.every(c=>['Memory.startSampling','Memory.getSamplingProfile','Memory.stopSampling','Page.getFrameTree'].includes(c.method)));
  assert.deepEqual(JSON.parse(await readFile(join(directory,'cpu-main-1.raw.json'),'utf8')),{profile});
  const bad=await createSessionNativeSampling(session,directory,{label:'bad',frameId:'other',targetId:'target',pageNonce:'nonce'});await bad.start();await assert.rejects(bad.capture(401),/frame changed/);await bad.close();
  const receipts=(await readFile(join(directory,'bad-receipts.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(receipts[1].phase,'capture-failed');assert.equal(receipts[2].phase,'stopped');
 }finally{await rm(directory,{recursive:true,force:true});}
});
