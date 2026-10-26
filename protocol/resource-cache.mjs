import {isHash} from './wire.mjs';

export const CACHE_CAPABILITY='private-resource-offer-v1';
export const CACHE_NEGOTIATION=Object.freeze({schema:'viewer-resource-offer-v1',maxEntries:128,waitMs:250});
export const cacheResourceKey=(kind,id)=>kind+':'+id;
function fields(value,names){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid cache offer');
 const proto=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
 if(proto!==null&&Object.getPrototypeOf(proto)!==null||keys.length!==names.length||keys.some(k=>!names.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))throw new Error('Invalid cache offer');
}
export function cacheRenderer(value){
 fields(value,['canvaskit','wasmSha256']);if(typeof value.canvaskit!=='string'||!value.canvaskit.length||value.canvaskit.length>64||!isHash(value.wasmSha256))throw new Error('Invalid cache renderer');
 return Object.freeze({canvaskit:value.canvaskit,wasmSha256:value.wasmSha256});
}
export function validateCacheNegotiation(value){
 fields(value,['schema','maxEntries','waitMs']);if(Object.keys(CACHE_NEGOTIATION).some(k=>value[k]!==CACHE_NEGOTIATION[k]))throw new Error('Invalid cache negotiation');return CACHE_NEGOTIATION;
}
export function parseCacheOffer(value,namespace,renderer){
 fields(value,['type','schema','namespace','renderer','resources']);cacheRenderer(value.renderer);
 if(value.type!=='ResourceCacheOffer'||value.schema!==CACHE_NEGOTIATION.schema||typeof value.namespace!=='string'||!/^vrc1_[a-f0-9]{64}$/.test(value.namespace)||value.namespace!==namespace||value.renderer.canvaskit!==renderer.canvaskit||value.renderer.wasmSha256!==renderer.wasmSha256||!Array.isArray(value.resources)||value.resources.length>CACHE_NEGOTIATION.maxEntries)throw new Error('Invalid cache authority');
 const keys=new Set();
 for(const entry of value.resources){fields(entry,['kind','id']);if(!['skp','chunk'].includes(entry.kind)||!isHash(entry.id))throw new Error('Invalid cache reference');const key=cacheResourceKey(entry.kind,entry.id);if(keys.has(key))throw new Error('Duplicate cache reference');keys.add(key);}
 return keys;
}
export function makeCacheOffer(permission,resources=[]){
 const value={type:'ResourceCacheOffer',schema:CACHE_NEGOTIATION.schema,namespace:permission.namespace,renderer:cacheRenderer(permission.renderer),resources:resources.map(({kind,id})=>Object.freeze({kind,id}))};
 parseCacheOffer(value,permission.namespace,permission.renderer);return Object.freeze({...value,resources:Object.freeze(value.resources)});
}
