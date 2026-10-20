import assert from 'node:assert/strict';
import {test} from 'node:test';
import {physicalKeys,validatePhysicalPolicy,physicalBreaches,physicalPlateau} from './session-longload-policy.mjs';
const domains=value=>Object.fromEntries(physicalKeys.map(key=>[key,value]));
const policy=()=>({schema:'darwin-session-long-v1',states:{'primary-only':domains(1000),'with-secondary':domains(1500)},plateau:{windowSamples:3,minSamplesPerState:6,growthBytes:domains(100)}});
test('physical policies reject missing, nonfinite, unknown and overlapping growth gates',()=>{
 for(const mutate of [p=>delete p.states['with-secondary'],p=>delete p.states['primary-only'].sourceAnonBytes,p=>p.states['primary-only'].viewerFootprintBytes=NaN,p=>p.states['primary-only'].rss=1000,p=>p.plateau.minSamplesPerState=5,p=>p.plateau.growthBytes.sourcePssBytes=null]){
  const p=policy();mutate(p);assert.throws(()=>validatePhysicalPolicy(p));
 }
 const p=policy();delete p.plateau;assert.throws(()=>validatePhysicalPolicy(p,{requirePlateau:true}));assert.equal(validatePhysicalPolicy(p),p);
});
test('physical gates retain state-specific exceeded values and reject missing observations',()=>{
 const p=validatePhysicalPolicy(policy());assert.deepEqual(physicalBreaches(p,'primary-only',domains(1000)),[]);
 assert.deepEqual(physicalBreaches(p,'primary-only',{...domains(900),sourcePssBytes:1001}),[{key:'sourcePssBytes',observedBytes:1001,limitBytes:1000}]);
 assert.deepEqual(physicalBreaches(p,'with-secondary',domains(1001)),[]);
 assert.throws(()=>physicalBreaches(p,'primary-only',{...domains(900),sourceNodePssBytes:null}));
});
test('growth uses nonoverlapping post-warm medians per state and preserves failed domains',()=>{
 const p=policy(),samples=[];
 for(const state of Object.keys(p.states)){
  samples.push({state,cycle:0,physical:domains(999999)});
  for(let i=0;i<6;i++)samples.push({state,cycle:400+i,physical:domains(i<3?500:(state==='with-secondary'?601:600))});
 }
 const r=physicalPlateau(p,samples);assert.equal(r.passed,false);
 assert.equal(r.states['primary-only'].domains.sourcePssBytes.growthBytes,100);
 assert.equal(r.states['primary-only'].domains.sourcePssBytes.passed,true);
 assert.equal(r.states['with-secondary'].domains.sourcePssBytes.growthBytes,101);
 assert.equal(r.states['with-secondary'].domains.sourcePssBytes.passed,false);
 assert.deepEqual(r.states['with-secondary'].earlyCycles,[400,401,402]);
 assert.throws(()=>physicalPlateau(p,samples.slice(0,-1)),/Insufficient/);
});
