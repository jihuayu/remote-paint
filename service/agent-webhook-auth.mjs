// Private backend wire authentication. A verified MAC is not Event DTO
// validation, durable deduplication, delivery completion or business success.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';

export class AgentWebhookAuthError extends Error {
 constructor(code){super('Agent Webhook operation failed');this.name='AgentWebhookAuthError';Object.defineProperty(this,'code',{value:code,enumerable:true});}
}
const fail=code=>{throw new AgentWebhookAuthError(code);};
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const eventIdPattern=new RegExp('^aevt_'+uuid+'$'),endpointPattern=new RegExp('^awh_'+uuid+'$');
const keyPattern=/^[A-Za-z0-9_-]{1,64}$/;
const signaturePattern=/^t=(0|[1-9][0-9]{0,15}),kid=([A-Za-z0-9_-]{1,64}),v1=([a-f0-9]{64})$/;
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const byteLength=Object.getOwnPropertyDescriptor(typedArrayPrototype,'byteLength').get;
const backingBuffer=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer').get;
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function record(value,required,optional=[]){
 if(!value||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error();
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
 if(required.some(k=>!Object.hasOwn(descriptors,k))||names.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(descriptors[k],'value')))throw Error();
 return Object.fromEntries(names.map(k=>[k,descriptors[k].value]));
}
function array(value){
 if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)throw Error();
 const descriptors=Object.getOwnPropertyDescriptors(value),length=descriptors.length.value;
 if(!integer(length,1,2)||Reflect.ownKeys(descriptors).length!==length+1)throw Error();
 return Array.from({length},(_,i)=>{const d=descriptors[i];if(!d||!Object.hasOwn(d,'value'))throw Error();return d.value;});
}
function bytes(value,min,max){
 if(types.isProxy(value)||!types.isUint8Array(value)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(value)))throw Error();
 const size=byteLength.call(value);
 if(!integer(size,min,max)||types.isSharedArrayBuffer(backingBuffer.call(value)))throw Error();
 const copy=Buffer.allocUnsafe(size);Uint8Array.prototype.set.call(copy,value);return copy;
}
function mac(key,endpointId,keyId,timestamp,eventId,body){
 return createHmac('sha256',key).update('remote-paint-webhook-v1\n'+endpointId+'\n'+keyId+'\n'+timestamp+'\n'+eventId+'\n','utf8').update(body).digest();
}

export function createAgentWebhookAuthenticator(config){
 const keys=new Map();let endpointId,activeKeyId,maxBodyBytes,maxAgeSeconds,futureSkewSeconds,clock,closed=false;
 try{
  const value=record(config,['endpointId','keys','activeKeyId'],['maxBodyBytes','maxAgeSeconds','futureSkewSeconds','clock']);
  ({endpointId,activeKeyId}=value);maxBodyBytes=Object.hasOwn(value,'maxBodyBytes')?value.maxBodyBytes:4096;maxAgeSeconds=Object.hasOwn(value,'maxAgeSeconds')?value.maxAgeSeconds:300;futureSkewSeconds=Object.hasOwn(value,'futureSkewSeconds')?value.futureSkewSeconds:30;clock=Object.hasOwn(value,'clock')?value.clock:()=>Math.floor(Date.now()/1000);
  if(typeof endpointId!=='string'||!endpointPattern.test(endpointId)||typeof activeKeyId!=='string'||!keyPattern.test(activeKeyId)||!integer(maxBodyBytes,1,4096)||!integer(maxAgeSeconds,1,3600)||!integer(futureSkewSeconds,0,60)||typeof clock!=='function'||types.isProxy(clock)||types.isAsyncFunction(clock)||types.isGeneratorFunction(clock))throw Error();
  for(const item of array(value.keys)){
   const {keyId,secret}=record(item,['keyId','secret']);
   if(typeof keyId!=='string'||!keyPattern.test(keyId)||keys.has(keyId))throw Error();
   keys.set(keyId,bytes(secret,32,64));
  }
  if(!keys.has(activeKeyId))throw Error();
 }catch{
  for(const key of keys.values())key.fill(0);keys.clear();fail('AGENT_WEBHOOK_INVALID');
 }
 const now=()=>{
  const value=clock();
  if(types.isPromise(value)){
   // A mistaken synchronous wrapper may return a rejected native Promise.
   // Observe that rejection without accepting it as a clock or echoing it.
   Promise.prototype.then.call(value,()=>{},()=>{});throw Error();
  }
  if(!integer(value,0,Number.MAX_SAFE_INTEGER))throw Error();return value;
 };
 return Object.freeze({
  sign(input){
   if(closed)fail('AGENT_WEBHOOK_CLOSED');
   try{
    const {eventId,body:inputBody}=record(input,['eventId','body']);
    if(typeof eventId!=='string'||!eventIdPattern.test(eventId))throw Error();
    const body=bytes(inputBody,1,maxBodyBytes),timestamp=now();
    if(closed)fail('AGENT_WEBHOOK_CLOSED');
    const digest=mac(keys.get(activeKeyId),endpointId,activeKeyId,timestamp,eventId,body).toString('hex');
    return Object.freeze({body,headers:Object.freeze({'content-type':'application/json','remote-paint-event-id':eventId,'remote-paint-signature':'t='+timestamp+',kid='+activeKeyId+',v1='+digest})});
   }catch{fail(closed?'AGENT_WEBHOOK_CLOSED':'AGENT_WEBHOOK_INVALID');}
  },
  verify(input){
   if(closed)fail('AGENT_WEBHOOK_CLOSED');
   try{
    const {eventId,signature,body:inputBody}=record(input,['eventId','signature','body']);
    if(typeof eventId!=='string'||!eventIdPattern.test(eventId)||typeof signature!=='string'||signature.length>192)throw Error();
    const match=signaturePattern.exec(signature);if(!match)throw Error();
    const timestamp=Number(match[1]),keyId=match[2],key=keys.get(keyId);
    if(!integer(timestamp,0,Number.MAX_SAFE_INTEGER)||!key)throw Error();
    const body=bytes(inputBody,1,maxBodyBytes),observed=now();
    // Subtraction avoids unsafe addition near MAX_SAFE_INTEGER.
    if(closed||observed-timestamp>maxAgeSeconds||timestamp-observed>futureSkewSeconds)throw Error();
    const expected=mac(key,endpointId,keyId,timestamp,eventId,body),received=Buffer.from(match[3],'hex');
    if(!timingSafeEqual(expected,received))throw Error();
    return Object.freeze({endpointId,eventId,keyId,signedAtSeconds:timestamp,body});
   }catch{fail(closed?'AGENT_WEBHOOK_CLOSED':'AGENT_WEBHOOK_AUTH_FAILED');}
  },
  close(){
   if(closed)return;closed=true;
   for(const key of keys.values())key.fill(0);keys.clear();
  }
 });
}
