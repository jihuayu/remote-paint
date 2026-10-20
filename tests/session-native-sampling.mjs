// Separate native allocation attribution. No GC/pressure command, no claim
// that weighted sampled allocations are a census or unique physical memory.
import assert from 'node:assert/strict';
import {mkdir, writeFile, appendFile} from 'node:fs/promises';
import {join} from 'node:path';

const address = text => {
  assert.equal(typeof text, 'string');
  assert.match(text, /^(?:0x[0-9a-f]+|[0-9]+)$/i, 'Invalid native module address');
  return BigInt(text);
};
const exact = value => {assert.ok(Number.isSafeInteger(value) && value >= 0, 'Unsafe native sampling byte value'); return value;};

export function summarizeNativeProfile(profile) {
  assert.ok(Array.isArray(profile?.samples) && profile.samples.length <= 16384, 'Native sample count bound');
  assert.ok(Array.isArray(profile.modules) && profile.modules.length <= 512, 'Native module count bound');
  const modules = profile.modules.map(module => {
    assert.ok(typeof module.name === 'string' && module.name.length <= 1024);
    assert.ok(typeof module.uuid === 'string' && module.uuid.length <= 128);
    return {...module, base: address(module.baseAddress), bytes: BigInt(exact(module.size))};
  });
  const groups = new Map(); let estimatedAllocationBytes = 0, sampledAllocationBytes = 0, unmappedFrames = 0;
  for (const sample of profile.samples) {
    exact(sample.size); exact(sample.total);
    assert.ok(Array.isArray(sample.stack) && sample.stack.length <= 256, 'Native stack bound');
    const stack = sample.stack.map(frame => {
      assert.ok(typeof frame === 'string' && frame.length <= 4096);
      const match = /^(0x[0-9a-f]+)(?:\s.*)?$/i.exec(frame);
      assert.ok(match, 'Expected a real native PC,not a synthetic heap node');
      const pc = address(match[1]), candidates = modules.filter(m => pc >= m.base && pc < m.base + m.bytes);
      if (candidates.length !== 1) {unmappedFrames++; return {pc: '0x'+pc.toString(16), mapped: false, candidates: candidates.length};}
      const m = candidates[0];
      return {module: m.name, uuid: m.uuid, offset: '0x'+(pc-m.base).toString(16),
        // Missing UUID is not a stable identity across processes or runs.
        ...(!m.uuid ? {unidentifiedModuleBase: m.baseAddress} : {})};
    });
    const key = JSON.stringify(stack), group = groups.get(key) ?? {stack, samples: 0, sampledBytes: 0, estimatedBytes: 0};
    group.samples++; group.sampledBytes = exact(group.sampledBytes + sample.size); group.estimatedBytes = exact(group.estimatedBytes + sample.total); groups.set(key, group);
    estimatedAllocationBytes = exact(estimatedAllocationBytes + sample.total); sampledAllocationBytes = exact(sampledAllocationBytes + sample.size);
  }
  return {samples: profile.samples.length, modules: profile.modules.length, stackGroups: groups.size,
    sampledAllocationBytes, estimatedAllocationBytes, unmappedFrames,
    largestGroups: [...groups.values()].sort((a,b)=>b.estimatedBytes-a.estimatedBytes).slice(0,64),
    scope: 'Live native allocation samples with Poisson weights;not exact object totals/physical memory. Module UUID+relative PC identity only;unmapped/ambiguous PCs stay explicit. No inferred function names.'};
}

function within(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' exceeded'+ms+'ms')),ms);})]).finally(()=>clearTimeout(timer));
}

export async function createSessionNativeSampling(session, directory, context, {samplingInterval=262144, deadlineMs=5000, maxBytes=8388608}={}) {
  assert.ok([131072,262144].includes(samplingInterval));
  assert.ok(Number.isInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= 5000);
  assert.ok(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 8388608);
  assert.match(context.label,/^[a-z][a-z0-9-]{0,63}$/); assert.ok(context.frameId && context.targetId && context.pageNonce);
  await mkdir(directory,{recursive:true});
  let attempted=false, active=false, busy=false, ordinal=0, closing;
  const log = value => appendFile(join(directory,context.label+'-receipts.jsonl'),JSON.stringify({at:new Date().toISOString(),context,...value})+'\n');
  const send = (method,params) => within(session.send(method,params),deadlineMs,method);
  return {
    async start() {
      assert.equal(attempted,false);attempted=true;
      try {await send('Memory.startSampling',{samplingInterval,suppressRandomness:false});active=true;await log({phase:'started',samplingInterval,suppressRandomness:false,deadlineMs,maxBytes});}
      catch(error){await log({phase:'start-failed',error:error.stack});throw error;}
    },
    async capture(cycle) {
      assert.ok(active&&!busy&&!closing);assert.ok(++ordinal<=1024);busy=true;
      const start=performance.now(),path=join(directory,context.label+'-'+ordinal+'.raw.json');
      try {
        const call=(method)=>within(session.send(method),Math.max(1,deadlineMs-(performance.now()-start)),method);
        const {frameTree}=await call('Page.getFrameTree');assert.equal(frameTree.frame.id,context.frameId,'Native sampling page frame changed');
        const reply=await call('Memory.getSamplingProfile'),raw=JSON.stringify(reply)+'\n',bytes=Buffer.byteLength(raw);
        assert.ok(bytes<=maxBytes,'Native profile output exceeds frozen byte bound');
        await writeFile(path,raw,{flag:'wx',mode:0o600}); // Preserve raw before semantic validation.
        const summary=summarizeNativeProfile(reply.profile);
        assert.ok(performance.now()-start<=deadlineMs,'Native profile total deadline exceeded');
        await log({phase:'captured',ordinal,cycle,path,bytes,elapsedMs:performance.now()-start,summary,
          association:'Actual attached page target/frame/nonce;native profile is renderer-process-wide including worker allocations. Exact OS PID association is not claimed here.'});
        return {ordinal,cycle,samples:summary.samples,estimatedAllocationBytes:summary.estimatedAllocationBytes};
      }catch(error){await log({phase:'capture-failed',ordinal,cycle,path,elapsedMs:performance.now()-start,error:error.stack});throw error;}
      finally {busy=false;}
    },
    close() {
      return closing??=(async()=>{
        if(!attempted)return {status:'not-started'};
        try{await send('Memory.stopSampling');active=false;await log({phase:'stopped'});return {status:'stopped'};}
        catch(error){await log({phase:'stop-failed',error:error.stack});throw error;}
      })();
    }
  };
}
