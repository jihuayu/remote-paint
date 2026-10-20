import {isIP,isIPv4} from 'node:net';
import {verifyDockerRuntime} from './docker-runtime-spec.mjs';
import {isRuntimeWitnessBinding} from './runtime-witness-binding.mjs';
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export class NativeEndpointError extends Error {constructor(code='ENDPOINT_BINDING'){super('Owned Native endpoint is unavailable');this.name='NativeEndpointError';this.code=code==='ENDPOINT_NETWORK'?code:'ENDPOINT_BINDING';}}
const fail=code=>{throw new NativeEndpointError(code);};
function read(v,key,code='ENDPOINT_BINDING'){if(!plain(v))fail(code);const descriptor=Object.getOwnPropertyDescriptor(v,key);if(!descriptor||!Object.hasOwn(descriptor,'value'))fail(code);return descriptor.value;}
const ipv4=value=>value.split('.').reduce((n,part)=>(n*256+Number(part))>>>0,0);
const unicast=value=>typeof value==='string'&&isIPv4(value)&&![0,127].includes(Number(value.split('.')[0]))&&Number(value.split('.')[0])<224;
function subnet(value){
 if(typeof value!=='string')fail('ENDPOINT_NETWORK');const parts=value.split('/');if(parts.length!==2||!/^(0|[1-9][0-9]{0,2})$/.test(parts[1]))fail('ENDPOINT_NETWORK');const family=isIP(parts[0]),prefix=Number(parts[1]);if(!family||prefix>(family===4?32:128))fail('ENDPOINT_NETWORK');if(family===6)return null;
 const mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0,base=ipv4(parts[0]);if(((base&mask)>>>0)!==base)fail('ENDPOINT_NETWORK');return {prefix,mask,base};
}
const contains=(range,value)=>((ipv4(value)&range.mask)>>>0)===range.base;

// Projection only. The provider must obtain these records from its current
// ledger, live inspection and inspection-bound witness store, then fence all
// awaits. This function neither authorizes a caller nor proves reachability.
export function captureOwnedNativeEndpoint(value){
 try{
  if(!exact(value,['plan','inspection','allocation','networkInspection','witnessReceipt']))fail();const {plan,inspection,allocation,networkInspection,witnessReceipt}=value;
  if(read(read(plan,'create'),'Cmd')?.[0]!=='/project/service/native-session-worker.mjs')fail();
  if(read(allocation,'state')!=='ready'||read(allocation,'requestStarted')!==true||read(allocation,'closeReason')!==null||read(allocation,'retirement')!==null)fail();const version=read(allocation,'version'),binding=read(allocation,'startDispatch');if(typeof version!=='string'||!version.length||version.length>256||!isRuntimeWitnessBinding(binding))fail();
  for(const [key,expected] of Object.entries({sessionId:plan.sessionId,tenant:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,ownerKeyHash:plan.ownerKeyHash,specDigest:plan.specDigest,imageId:plan.imageId,containerName:plan.containerName}))if(read(allocation,key)!==expected)fail();
  const containerId=read(allocation,'containerId');if(!hash(containerId))fail();const profile=verifyDockerRuntime(plan,inspection,{containerId}),state=read(inspection.document,'State');if(!profile.running||profile.state!=='running'||profile.pid<=0||read(state,'StartedAt')!==binding.engineStartedAt||['Paused','Restarting','Dead','OOMKilled'].some(k=>read(state,k)!==false))fail();
  const receipt={sessionId:plan.sessionId,containerId,daemonId:plan.daemonId,specDigest:plan.specDigest,witnessSha256:binding.witnessSha256,evidenceSha256:binding.evidenceSha256};if(!exact(witnessReceipt,Object.keys(receipt))||Object.entries(receipt).some(([k,v])=>witnessReceipt[k]!==v))fail();
  const code='ENDPOINT_NETWORK',settings=read(inspection.document,'NetworkSettings',code),sandboxId=read(settings,'SandboxID',code),networks=read(settings,'Networks',code);if(!hash(sandboxId)||!exact(networks,['bridge']))fail(code);const bridge=read(networks,'bridge',code),networkId=read(bridge,'NetworkID',code),endpointId=read(bridge,'EndpointID',code),address=read(bridge,'IPAddress',code),prefix=read(bridge,'IPPrefixLen',code),gateway=read(bridge,'Gateway',code);
  if(!hash(networkId)||!hash(endpointId)||!unicast(address)||!unicast(gateway)||address===gateway||!Number.isSafeInteger(prefix)||prefix<0||prefix>32)fail(code);
  if(read(networkInspection,'found',code)!==true||read(read(networkInspection,'daemon',code),'id',code)!==plan.daemonId)fail(code);const network=read(networkInspection,'document',code);for(const [key,expected]of Object.entries({Id:networkId,Name:'bridge',Driver:'bridge',Scope:'local'}))if(read(network,key,code)!==expected)fail(code);
  const member=read(read(network,'Containers',code),containerId,code);if(read(member,'Name',code)!==plan.containerName||read(member,'EndpointID',code)!==endpointId||read(member,'IPv4Address',code)!==address+'/'+prefix)fail(code);
  const configs=read(read(network,'IPAM',code),'Config',code);if(!Array.isArray(configs)||configs.length<1||configs.length>16)fail(code);let matches=0;
  for(const config of configs){const range=subnet(read(config,'Subnet',code));if(!range)continue;const configuredGateway=read(config,'Gateway',code);if(range.prefix!==prefix||configuredGateway!==gateway||!contains(range,address)||!contains(range,gateway))continue;const host=(ipv4(address)&(~range.mask>>>0))>>>0;if(prefix<31&&(host===0||host===(~range.mask>>>0)))fail(code);matches++;}if(matches!==1)fail(code);
  return Object.freeze({schema:'owned-native-endpoint-v1',scope:'metadata-only',sessionId:plan.sessionId,tenantId:plan.tenantId,region:plan.region,version,containerId,specDigest:plan.specDigest,engineStartedAt:binding.engineStartedAt,networkId,sandboxId,endpointId,address,origin:'http://127.0.0.1:4175',streamOrigin:'http://'+address+':4176'});
 }catch(error){if(error instanceof NativeEndpointError)throw error;throw new NativeEndpointError();}
}
