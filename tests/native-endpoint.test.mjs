// Engine/kernel records below are structural fixtures, not a real container.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime,witness} from './fixtures/runtime-witness-records.mjs';
import {planDockerRuntime} from '../service/docker-runtime-spec.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {mkdtemp,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let capture;try{({captureOwnedNativeEndpoint:capture}=await import('../service/native-endpoint.mjs'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const cid='e'.repeat(64),networkId='f'.repeat(64),endpointId='1'.repeat(64),sandboxId='2'.repeat(64),witnessSha='3'.repeat(64),evidenceSha='4'.repeat(64);
function fixture(address='192.168.215.5',subnet='192.168.215.0/24',gateway='192.168.215.1'){
 assert.equal(typeof capture,'function');const f=runtime(),{plan,inspection}=f;Object.assign(inspection.document.State,{Paused:false,Restarting:false,Dead:false,OOMKilled:false});
 inspection.document.NetworkSettings={Ports:{},SandboxID:sandboxId,Networks:{bridge:{NetworkID:networkId,EndpointID:endpointId,IPAddress:address,IPPrefixLen:Number(subnet.split('/')[1]),Gateway:gateway}}};
 const startDispatch={schema:'runtime-start-witness-v1',engineStartedAt:inspection.document.State.StartedAt,witnessSha256:witnessSha,evidenceSha256:evidenceSha};
 const allocation={sessionId:plan.sessionId,tenant:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,ownerKeyHash:plan.ownerKeyHash,specDigest:plan.specDigest,imageId:plan.imageId,containerName:plan.containerName,containerId:cid,state:'ready',requestStarted:true,startDispatch,version:'chromium:fixture;wasm:'+'a'.repeat(64),closeReason:null,retirement:null,createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z'};
 const networkInspection={found:true,daemon:{id:plan.daemonId},document:{Id:networkId,Name:'bridge',Driver:'bridge',Scope:'local',IPAM:{Driver:'default',Config:[{Subnet:subnet,Gateway:gateway}]},Containers:{[cid]:{Name:plan.containerName,EndpointID:endpointId,IPv4Address:address+'/'+allocationPrefix(inspection),IPv6Address:''},['9'.repeat(64)]:{Name:'other-private-container',IPv4Address:'192.168.215.99/24'}}}};
 const witnessReceipt={sessionId:plan.sessionId,containerId:cid,daemonId:plan.daemonId,specDigest:plan.specDigest,witnessSha256:witnessSha,evidenceSha256:evidenceSha};return {plan,inspection,allocation,networkInspection,witnessReceipt};
}
const allocationPrefix=f=>f.document.NetworkSettings.Networks.bridge.IPPrefixLen;
const rejected=error=>error?.name==='NativeEndpointError'&&['ENDPOINT_BINDING','ENDPOINT_NETWORK'].includes(error.code)&&error.message==='Owned Native endpoint is unavailable';
test('owned Native endpoint projection binds current ready/start witness/container and network and returns only finite metadata',()=>{
 const f=fixture(),p=capture(f);assert.deepEqual(p,{schema:'owned-native-endpoint-v1',scope:'metadata-only',sessionId:f.plan.sessionId,tenantId:f.plan.tenantId,region:f.plan.region,version:f.allocation.version,containerId:cid,specDigest:f.plan.specDigest,engineStartedAt:f.allocation.startDispatch.engineStartedAt,networkId,sandboxId,endpointId,address:'192.168.215.5',origin:'http://127.0.0.1:4175',streamOrigin:'http://192.168.215.5:4176'});assert.ok(Object.isFrozen(p));assert.equal(Object.keys(p).length,15);
});
test('per-network address is authoritative and configurable benchmark subnet works without legacy IPAddress fallback',()=>{
 const f=fixture('198.19.192.4','198.19.192.0/23','198.19.192.1');Object.defineProperty(f.inspection.document.NetworkSettings,'IPAddress',{get(){throw Error('Legacy address used');}});assert.equal(capture(f).streamOrigin,'http://198.19.192.4:4176');
});
test('nonready, closing, legacy or merely requested Start history cannot project a live endpoint',()=>{
 for(const edit of [f=>f.allocation.state='created',f=>f.allocation.state='closing',f=>f.allocation.closeReason='released',f=>f.allocation.retirement={},f=>f.allocation.requestStarted=false,f=>f.allocation.startDispatch='requested',f=>f.allocation.startDispatch='legacy-unknown',f=>f.allocation.version=null]){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('a different owner/CID/spec/tenant or restarted Engine generation is rejected before returning its address',()=>{
 for(const edit of [f=>f.allocation.tenant='other',f=>f.allocation.containerId='0'.repeat(64),f=>f.allocation.ownerKeyHash='0'.repeat(64),f=>f.allocation.specDigest='0'.repeat(64),f=>f.inspection.daemon.id='other',f=>f.inspection.document.Name='/other',f=>f.inspection.document.State.StartedAt='2026-10-18T00:00:01.123456789Z',f=>f.inspection.document.State.Running=false,f=>f.inspection.document.State.Pid=0,f=>f.inspection.document.Config.Env.push('UNEXPECTED=1')]){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('live witness receipt must match every current persisted binding and is never replaced by an older receipt',()=>{
 for(const edit of [f=>f.witnessReceipt.sessionId='ses_other',f=>f.witnessReceipt.containerId='0'.repeat(64),f=>f.witnessReceipt.daemonId='other',f=>f.witnessReceipt.specDigest='0'.repeat(64),f=>f.witnessReceipt.witnessSha256='0'.repeat(64),f=>f.witnessReceipt.evidenceSha256='0'.repeat(64),f=>delete f.witnessReceipt.evidenceSha256]){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('missing or multiple network attachments and invalid sandbox/endpoint identity cannot select an address',()=>{
 for(const edit of [f=>delete f.inspection.document.NetworkSettings.Networks,f=>f.inspection.document.NetworkSettings.Networks.host=f.inspection.document.NetworkSettings.Networks.bridge,f=>f.inspection.document.NetworkSettings.SandboxID='',f=>f.inspection.document.NetworkSettings.Networks.bridge.EndpointID='short',f=>f.inspection.document.NetworkSettings.Networks.bridge.NetworkID='0'.repeat(64),f=>f.networkInspection.found=false]){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('network inspection must independently identify this local bridge and its exact owned container entry',()=>{
 for(const edit of [f=>f.networkInspection.daemon.id='other',f=>f.networkInspection.document.Id='0'.repeat(64),f=>f.networkInspection.document.Name='host',f=>f.networkInspection.document.Driver='overlay',f=>f.networkInspection.document.Scope='swarm',f=>delete f.networkInspection.document.Containers[cid],f=>f.networkInspection.document.Containers[cid].Name='other',f=>f.networkInspection.document.Containers[cid].EndpointID='0'.repeat(64),f=>f.networkInspection.document.Containers[cid].IPv4Address='192.168.215.6/24']){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('invalid, loopback, wildcard, multicast and out-of-subnet addresses or conflicting prefix/gateway cannot become a URL',()=>{
 for(const edit of [f=>f.inspection.document.NetworkSettings.Networks.bridge.IPAddress='127.0.0.1',f=>f.inspection.document.NetworkSettings.Networks.bridge.IPAddress='0.0.0.0',f=>f.inspection.document.NetworkSettings.Networks.bridge.IPAddress='224.0.0.2',f=>f.inspection.document.NetworkSettings.Networks.bridge.IPAddress='192.168.215.005',f=>f.inspection.document.NetworkSettings.Networks.bridge.IPAddress='example.test',f=>f.inspection.document.NetworkSettings.Networks.bridge.IPPrefixLen=16,f=>f.networkInspection.document.IPAM.Config[0].Subnet='192.168.216.0/24',f=>f.networkInspection.document.IPAM.Config[0].Gateway='192.168.215.2',f=>f.networkInspection.document.IPAM.Config.push({...f.networkInspection.document.IPAM.Config[0]})]){const f=fixture();edit(f);assert.throws(()=>capture(f),rejected);}
});
test('raw network/labels/other containers/private getters are not evaluated, returned or retained in the finite projection',()=>{
 const f=fixture();let touched=false;Object.defineProperty(f.networkInspection.document,'privateSecret',{get(){touched=true;throw Error('private-secret');}});Object.defineProperty(f.allocation,'privateSecret',{get(){touched=true;throw Error('private-secret');}});const p=capture(f);assert.equal(touched,false);assert.doesNotMatch(JSON.stringify(p),/other-private-container|192\.168\.215\.99|privateSecret|ownerKeyHash|Config|Env|Containers/);assert.ok(Object.values(p).every(v=>typeof v==='string'));
});
test('extra URL/key input, accessors on required records and invalid version are rejected with fixed errors',()=>{
 const a=fixture();assert.throws(()=>capture({...a,url:'https://unowned.test'}),rejected);assert.throws(()=>capture({...a,key:'private-secret'}),rejected);const b=fixture();let touched=false;Object.defineProperty(b.witnessReceipt,'evidenceSha256',{get(){touched=true;throw Error('private-secret');}});assert.throws(()=>capture(b),rejected);assert.equal(touched,false);const c=fixture();c.allocation.version='';assert.throws(()=>capture(c),rejected);
});
test('paused/restarting/dead/OOM or incomplete Engine state cannot yield a live endpoint even while Running is true',()=>{
 for(const flag of ['Paused','Restarting','Dead','OOMKilled'])for(const value of [true,undefined]){const f=fixture();if(value===undefined)delete f.inspection.document.State[flag];else f.inspection.document.State[flag]=value;assert.throws(()=>capture(f),rejected);}
});
test('a valid generic worker plan cannot acquire the fixed Native endpoint ABI merely by returning a version',()=>{
 const f=fixture(),old=f.plan;f.plan=planDockerRuntime(old,{...old,projectPath:old.create.HostConfig.Mounts[0].Source,browserPath:old.create.HostConfig.Mounts[1].Source,workerEntry:'node-worker.mjs'});const create=structuredClone(f.plan.create);f.inspection.document.Config=create;f.inspection.document.HostConfig=create.HostConfig;f.allocation.specDigest=f.plan.specDigest;f.witnessReceipt.specDigest=f.plan.specDigest;assert.throws(()=>capture(f),rejected);
});
test('actual inspection-bound witness file reads still require the durable byte hash, including a valid-JSON rewrite',async t=>{
 const f=fixture(),parent=await mkdtemp(join(tmpdir(),'rp-endpoint-witness-'));t.after(()=>rm(parent,{recursive:true,force:true}));const directory=join(parent,'proof'),store=new RuntimeWitnessStore({directory}),receipt=store.persist({plan:f.plan,inspection:f.inspection,witness:witness()});f.allocation.startDispatch={...f.allocation.startDispatch,witnessSha256:receipt.witnessSha256,evidenceSha256:receipt.evidenceSha256};f.witnessReceipt=store.read({plan:f.plan,inspection:f.inspection}).receipt;assert.equal(capture(f).containerId,cid);await appendFile(join(directory,f.plan.sessionId+'-'+cid+'.namespace.json'),'\n');f.witnessReceipt=store.read({plan:f.plan,inspection:f.inspection}).receipt;assert.notEqual(f.witnessReceipt.evidenceSha256,f.allocation.startDispatch.evidenceSha256);assert.throws(()=>capture(f),rejected);
});
