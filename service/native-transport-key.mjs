import {createHmac} from 'node:crypto';
const fields=['ownerKey','sessionId','tenantId','region'];
// Both ends already share the authenticated owner capability. Derive a
// separate data-plane capability; do not send another secret in logged Ready.
export function deriveNativeTransportKey(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||![null,Object.prototype].includes(Object.getPrototypeOf(value))||Reflect.ownKeys(value).length!==fields.length||!fields.every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))||typeof value.ownerKey!=='string'||!/^[a-f0-9]{64}$/.test(value.ownerKey)||typeof value.sessionId!=='string'||!/^ses_[A-Za-z0-9_-]{1,124}$/.test(value.sessionId)||typeof value.tenantId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.tenantId)||typeof value.region!=='string'||value.region.length<1||value.region.length>64)throw new TypeError('Invalid private Native identity');
 const key=Buffer.from(value.ownerKey,'hex');try{return createHmac('sha256',key).update(JSON.stringify(['remote-paint-native-transport-v1',value.sessionId,value.tenantId,value.region])).digest('hex');}finally{key.fill(0);}
}
