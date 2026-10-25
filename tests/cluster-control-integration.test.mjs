import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,openSync,closeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';

const binding=r=>Object.fromEntries(['tenantId','sessionId','nodeId','generation','epoch'].map(k=>[k,r[k]]));
const request=sessionId=>({tenantId:'tenant-a',sessionId,region:'local',arch:'arm64',version:'source-v1'});
const error=code=>e=>e.code===code;
function worker(nodeId,incarnation){
 const child=fork(new URL('./fixtures/cluster-worker-child.mjs',import.meta.url),[nodeId,incarnation],{stdio:['ignore','ignore','pipe','ipc']});
 let ordinal=0,stderr='';const pending=new Map();child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);});
 child.on('message',message=>{const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);if(message.ok)item.resolve(message.data);else item.reject(Object.assign(new Error('Virtual Worker rejected request'),message.error));});
 child.on('exit',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Owned virtual Worker exited: '+stderr));}pending.clear();});
 const call=(method,data)=>new Promise((resolve,reject)=>{const id=++ordinal,item={resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Owned IPC request deadline'));},2000)};pending.set(id,item);child.send({id,method,data},error=>{if(error){clearTimeout(item.timer);pending.delete(id);reject(error);}});});
 return {nodeId,incarnation,call,async close(){if(child.exitCode!==null||child.signalCode!==null)return;try{await call('close');}finally{const exited=once(child,'exit',{signal:AbortSignal.timeout(3000)});child.disconnect();try{await exited;}catch{child.kill('SIGKILL');await once(child,'exit',{signal:AbortSignal.timeout(1000)});}}}};
}

test('real SQLite and two owned IPC workers fence heartbeat loss and require explicit retirement before a replacement', {timeout:10000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'remote-paint-cluster-ipc-')),path=join(directory,'cluster.sqlite');closeSync(openSync(path,'wx',0o600));
 // Explicit virtual-resource verifier. No Native runtime proof is claimed.
 const receipts=new Map(),store=new ClusterPlacementStore({database:new DatabaseSync(path),leaseMs:500,verifyRetirement:(placement,receipt)=>receipts.get(placement.sessionId)===receipt.sha256});
 const workers=[],a=worker('node-a','boot-a'),b=worker('node-b','boot-b');workers.push(a,b);let keepB=true,heartbeatB;
 const register=async w=>{await w.call('begin');const lease=store.registerNode({nodeId:w.nodeId,incarnation:w.incarnation,region:'local',arch:'arm64',version:'source-v1',capacity:1});await w.call('lease',{lease,leaseMs:500});return lease;};
 try{
  await register(a);const leaseB=await register(b);
  const first=store.reserve(request('ses_first')),second=store.reserve(request('ses_second'));assert.equal(first.nodeId,a.nodeId);assert.equal(second.nodeId,b.nodeId);
  await a.call('admit',binding(first));await b.call('admit',binding(second));assert.equal((await a.call('work',binding(first))).calls,1);assert.equal((await b.call('work',binding(second))).calls,1);store.ready(binding(first));store.ready(binding(second));
  heartbeatB=(async()=>{while(keepB){await delay(80);if(!keepB)break;await b.call('begin');const lease=store.heartbeat(leaseB);await b.call('lease',{lease,leaseMs:500});}})();
  let lost;const deadline=performance.now()+2000;
  do{lost=await a.call('status');if(lost.state==='expired')break;assert.ok(performance.now()<deadline);await delay(30);}while(true);
  assert.equal(lost.ownerAborted,true);const settled=await a.call('settled');assert.equal(settled.owned,0);assert.equal(settled.cleanups,1);
  // Worker deadlines start before the lease request. Wait independently for
  // the coordinator's later deadline instead of assuming synchronized clocks.
  while(store.status().quarantined===0){assert.ok(performance.now()<deadline);await delay(5);}
  assert.throws(()=>store.route(request('ses_first')),error('CLUSTER_SESSION_UNAVAILABLE'));assert.equal(store.status().heldSlots,2);assert.equal(store.route(request('ses_second')).nodeId,b.nodeId);
  await assert.rejects(a.call('work',binding(first)),e=>e.code==='CLUSTER_WORKER_LEASE'&&e.outcome==='not-dispatched');
  assert.equal(store.reserve(request('ses_first')).state,'quarantined');
  const replacement=worker('node-a','boot-a-2');workers.push(replacement);await register(replacement);
  assert.throws(()=>store.reserve(request('ses_replacement')),error('CLUSTER_CAPACITY'));
  const virtualProof='a'.repeat(64);receipts.set(first.sessionId,virtualProof);store.confirmRetired(binding(first),{sha256:virtualProof});
  const next=store.reserve(request('ses_replacement'));assert.ok(next.generation>first.generation);assert.ok(next.epoch>first.epoch);await replacement.call('admit',binding(next));await replacement.call('work',binding(next));store.ready(binding(next));
  assert.equal(store.route(request('ses_replacement')).nodeId,'node-a');assert.equal(store.reserve(request('ses_first')).state,'closed');
  assert.equal((await a.call('status')).calls,1,'old Worker did not execute after its fence expired');
 }finally{keepB=false;await heartbeatB?.catch(()=>{});for(const w of workers.reverse())await w.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
