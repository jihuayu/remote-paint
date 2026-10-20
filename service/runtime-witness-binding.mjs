const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const keys=['schema','engineStartedAt','witnessSha256','evidenceSha256'];
export const runtimeWitnessStartedAt=v=>typeof v==='string'&&/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
export function isRuntimeWitnessBinding(value){
 return !!value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))&&value.schema==='runtime-start-witness-v1'&&runtimeWitnessStartedAt(value.engineStartedAt)&&hash(value.witnessSha256)&&hash(value.evidenceSha256);
}
export function copyRuntimeWitnessBinding(value){
 if(!isRuntimeWitnessBinding(value))throw new TypeError('Expected a versioned effective runtime witness binding');
 return Object.freeze(Object.fromEntries(keys.map(k=>[k,value[k]])));
}
