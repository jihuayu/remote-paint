import assert from 'node:assert/strict';

// Lifecycle checkpoints supplement the periodic sampler. They must never
// postpone its next deadline and hide a primary-only observation interval.
export function createSessionSamplingCadence(now=()=>performance.now()){
 let lastPeriodicStart=now();
 return {
  due(){return now()-lastPeriodicStart>60000;},
  begin(secondarySessionId=null){
   assert.ok(secondarySessionId===null||(typeof secondarySessionId==='string'&&secondarySessionId.length>0&&secondarySessionId.length<=256));
   const startedAt=now();assert.ok(Number.isFinite(startedAt)&&startedAt>=lastPeriodicStart);
   if(secondarySessionId===null)lastPeriodicStart=startedAt;
   return {startedAt,trigger:secondarySessionId===null?'periodic':'secondary-before-close',secondarySessionId};
  }
 };
}

export function secondarySampleCoverage(sample,secondarySessionId){
 assert.equal(sample.state,'with-secondary');
 assert.equal(sample.source.secondary?.id,secondarySessionId);
 assert.ok(sample.secondary&&sample.source.secondary.workload.imageBytes>64*1024*1024);
 assert.equal(sample.sampling.trigger,'secondary-before-close');
 assert.equal(sample.sampling.secondarySessionId,secondarySessionId);
 assert.ok(Number.isFinite(sample.elapsedSeconds)&&sample.elapsedSeconds>0);
 return {secondarySessionId,sampleElapsedSeconds:sample.elapsedSeconds,primaryCycle:sample.cycle,trigger:sample.sampling.trigger};
}
