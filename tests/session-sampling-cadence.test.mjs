import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSessionSamplingCadence,secondarySampleCoverage} from './session-sampling-cadence.mjs';

test('secondary checkpoints cannot move the independent periodic deadline',()=>{
 let clock=0;const cadence=createSessionSamplingCadence(()=>clock);
 cadence.begin();clock=59000;
 assert.equal(cadence.begin('secondary-1').trigger,'secondary-before-close');
 clock=60001;assert.equal(cadence.due(),true);
 // Repeated short lifetimes must not starve the 60s periodic sampler.
 cadence.begin('secondary-2');assert.equal(cadence.due(),true);
 assert.equal(cadence.begin().trigger,'periodic');assert.equal(cadence.due(),false);
 clock=119999;cadence.begin('secondary-3');assert.equal(cadence.due(),false);
 clock=120002;assert.equal(cadence.due(),true);
 assert.throws(()=>cadence.begin(''));assert.throws(()=>cadence.begin(1));
 clock=60000;assert.throws(()=>cadence.begin('secondary-4'));
});

test('secondary coverage requires an actual late-load sample from the same live Source and Viewer cohort',()=>{
 const sample={state:'with-secondary',source:{secondary:{id:'secondary-1',workload:{imageBytes:65*1024*1024}}},secondary:{result:{frameId:7}},sampling:{trigger:'secondary-before-close',secondarySessionId:'secondary-1'},elapsedSeconds:91,cycle:420};
 assert.deepEqual(secondarySampleCoverage(sample,'secondary-1'),{secondarySessionId:'secondary-1',sampleElapsedSeconds:91,primaryCycle:420,trigger:'secondary-before-close'});
 for(const change of [s=>s.state='primary-only',s=>s.source.secondary=null,s=>s.source.secondary.id='secondary-2',s=>s.secondary=null,s=>s.source.secondary.workload.imageBytes=64*1024*1024,s=>s.sampling.trigger='periodic',s=>s.sampling.secondarySessionId='secondary-2',s=>s.elapsedSeconds=NaN]){
  const invalid=structuredClone(sample);change(invalid);assert.throws(()=>secondarySampleCoverage(invalid,'secondary-1'));
 }
});
