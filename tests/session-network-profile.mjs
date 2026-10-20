// Test-only, run in the explicitly created NET_ADMIN container's own namespace.
// Only that namespace's eth0 egress from this primary Gateway TCP port is shaped.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const tc=async(...args)=>{const r=await exec('tc',args,{timeout:5000,maxBuffer:65536});return r.stdout;};
export function networkProfileCounters(qdiscs){
 assert.ok(Array.isArray(qdiscs));const rows=qdiscs.filter(q=>q.kind==='netem'&&q.handle==='30:');assert.equal(rows.length,1,'Expected exactly the owned netem queue');const q=rows[0];
 for(const key of ['bytes','packets','drops','overlimits','requeues','backlog','qlen'])assert.ok(Number.isSafeInteger(q[key])&&q[key]>=0,'Missing actual kernel qdisc counter:'+key);
 return Object.fromEntries(['bytes','packets','drops','overlimits','requeues','backlog','qlen'].map(key=>[key,q[key]]));
}
export function createSessionNetworkProfile(port){
 assert.equal(process.platform,'linux');assert.ok(Number.isInteger(port)&&port>=1024&&port<65536);let owned=false;
 const configuration={interface:'eth0',gatewayPort:port,direction:'Source-to-Mac Gateway TCP egress only;reverse direction unshaped',delayMs:40,jitterMs:2,lossPercent:1,rateMbit:20,queuePackets:1000,configuredRttMs:null};
 const snapshot=async()=>{const qdiscs=JSON.parse(await tc('-s','-j','qdisc','show','dev','eth0'));return {at:new Date().toISOString(),configuration,qdiscs,counters:networkProfileCounters(qdiscs)};};
 const close=async()=>{if(!owned)return {status:'not-active'};const before=await snapshot();await tc('qdisc','del','dev','eth0','root');owned=false;const after=JSON.parse(await tc('-s','-j','qdisc','show','dev','eth0'));assert.ok(after.every(q=>q.kind==='noqueue'));return {status:'removed',before,after};};
 return {get active(){return owned;},configuration,snapshot,close,async start(){
  assert.equal(owned,false);const before=JSON.parse(await tc('-s','-j','qdisc','show','dev','eth0'));assert.ok(before.length&&before.every(q=>q.kind==='noqueue'),'Refuse to replace an existing qdisc');
  try{
   await tc('qdisc','add','dev','eth0','root','handle','1:','prio','bands','3','priomap',...Array(16).fill('0'));owned=true;
   await tc('qdisc','add','dev','eth0','parent','1:3','handle','30:','netem','limit','1000','delay','40ms','2ms','loss','1%','rate','20mbit');
   await tc('filter','add','dev','eth0','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol','6','0xff','match','ip','sport',String(port),'0xffff','flowid','1:3');
   return await snapshot();
  }catch(error){if(owned){await tc('qdisc','del','dev','eth0','root');owned=false;}throw error;}
 }};
}
