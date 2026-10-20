import assert from 'node:assert/strict';

export const physicalKeys=Object.freeze(['viewerFootprintBytes','viewerRssSumBytes','sourcePssBytes','sourceAnonBytes','sourceNodePssBytes']);
const states=['primary-only','with-secondary'];
function bounds(value){
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),[...physicalKeys].sort(),'Physical policy must bound exactly the measured domains');
 for(const key of physicalKeys)assert.ok(Number.isSafeInteger(value[key])&&value[key]>0,'Invalid physical policy bound:'+key);
}
export function validatePhysicalPolicy(policy,{requirePlateau=false}={}){
 assert.equal(policy?.schema,'darwin-session-long-v1');
 assert.deepEqual(Object.keys(policy.states??{}).sort(),[...states].sort());
 for(const state of states)bounds(policy.states[state]);
 if(requirePlateau)assert.ok(policy.plateau,'Long run requires a frozen physical growth policy');
 if(policy.plateau){
  const p=policy.plateau;bounds(p.growthBytes);
  assert.ok(Number.isSafeInteger(p.windowSamples)&&p.windowSamples>=3&&p.windowSamples<=60);
  assert.ok(Number.isSafeInteger(p.minSamplesPerState)&&p.minSamplesPerState>=2*p.windowSamples,'Early and late median windows must not overlap');
 }
 return policy;
}
export function physicalBreaches(policy,state,physical){
 assert.ok(states.includes(state));
 for(const key of physicalKeys)assert.ok(Number.isSafeInteger(physical[key])&&physical[key]>0,'Missing or invalid actual physical measurement:'+key);
 return physicalKeys.filter(key=>physical[key]>policy.states[state][key]).map(key=>({key,observedBytes:physical[key],limitBytes:policy.states[state][key]}));
}
export function physicalPlateau(policy,samples,{warmCycle=400}={}){
 validatePhysicalPolicy(policy,{requirePlateau:true});
 const p=policy.plateau,median=values=>{const v=values.slice().sort((a,b)=>a-b),n=v.length;return n%2?v[(n-1)/2]:(v[n/2-1]+v[n/2])/2;},result={};
 for(const state of states){
  const rows=samples.filter(row=>row.state===state&&row.cycle>=warmCycle);
  assert.ok(rows.length>=p.minSamplesPerState,'Insufficient post-warm samples for '+state+':'+rows.length);
  const early=rows.slice(0,p.windowSamples),late=rows.slice(-p.windowSamples),domains={};
  for(const key of physicalKeys){
   const values=rows.map(row=>row.physical[key]);assert.ok(values.every(v=>Number.isSafeInteger(v)&&v>0));
   const firstMedianBytes=median(early.map(row=>row.physical[key])),lastMedianBytes=median(late.map(row=>row.physical[key]));
   domains[key]={firstMedianBytes,lastMedianBytes,growthBytes:lastMedianBytes-firstMedianBytes,allowedGrowthBytes:p.growthBytes[key],passed:lastMedianBytes-firstMedianBytes<=p.growthBytes[key]};
  }
  result[state]={postWarmSamples:rows.length,earlyCycles:early.map(r=>r.cycle),lateCycles:late.map(r=>r.cycle),domains};
 }
 return {states:result,passed:Object.values(result).every(state=>Object.values(state.domains).every(domain=>domain.passed))};
}
