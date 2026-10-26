import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ClusterWorkerFence} from '../service/cluster-worker-fence.mjs';

const lease={nodeId:'node-a',incarnation:'boot-1',generation:1};
const binding={tenantId:'tenant-a',sessionId:'ses_one',nodeId:'node-a',generation:1,epoch:1};
const error=(code,outcome='not-dispatched')=>e=>e.code===code&&e.outcome===outcome;
function fixture(t,options={}){
 let at=1000;const cleanups=[];const fence=new ClusterWorkerFence({nodeId:lease.nodeId,incarnation:lease.incarnation,now:()=>at,onExpired:receipt=>{cleanups.push(receipt);},...options});
 t.after(()=>fence.close());return {fence,cleanups,advance:ms=>at+=ms,activate(){fence.acceptLease(fence.beginHeartbeat(),lease,{leaseMs:1000});}};
}

test('only the exact pending local observation and trusted node incarnation admit a lease',t=>{
 const f=fixture(t);assert.throws(()=>f.fence.admit(binding),error('CLUSTER_WORKER_LEASE'));
 const observation=f.fence.beginHeartbeat();assert.throws(()=>f.fence.beginHeartbeat(),error('CLUSTER_WORKER_HEARTBEAT_BUSY'));
 assert.throws(()=>f.fence.acceptLease({...observation},lease,{leaseMs:1000}),error('CLUSTER_WORKER_HEARTBEAT'));
 assert.throws(()=>f.fence.acceptLease(observation,{...lease,incarnation:'other'},{leaseMs:1000}),error('CLUSTER_WORKER_LEASE'));
 f.activate();assert.deepEqual(f.fence.admit(binding),binding);assert.equal(f.fence.check(binding).epoch,1);
});

test('response delay consumes the lease budget instead of extending it at receipt time',t=>{
 const f=fixture(t),observation=f.fence.beginHeartbeat();f.advance(900);f.fence.acceptLease(observation,lease,{leaseMs:1000});
 assert.equal(f.fence.status().remainingMs,100);f.advance(100);assert.equal(f.fence.status().state,'expired');assert.equal(f.fence.signal.aborted,true);
 assert.throws(()=>f.fence.acceptLease(f.fence.beginHeartbeat(),lease,{leaseMs:1000}),error('CLUSTER_WORKER_LEASE'));
});

test('a lease response received after its request budget expires cannot resurrect the worker',t=>{
 const f=fixture(t),observation=f.fence.beginHeartbeat();f.advance(1000);
 assert.throws(()=>f.fence.acceptLease(observation,lease,{leaseMs:1000}),error('CLUSTER_WORKER_LEASE'));assert.equal(f.fence.signal.aborted,true);
});

test('tenant, epoch, node and generation changes cannot reuse an admitted Session fence',t=>{
 const f=fixture(t);f.activate();f.fence.admit(binding);
 for(const patch of [{tenantId:'tenant-b'},{epoch:2},{nodeId:'node-b'},{generation:2}]){
  assert.throws(()=>f.fence.admit({...binding,...patch}),error('CLUSTER_WORKER_FENCE'));assert.throws(()=>f.fence.check({...binding,...patch}),error('CLUSTER_WORKER_FENCE'));
 }
 assert.throws(()=>f.fence.check({...binding,sessionId:'ses_not_admitted'}),error('CLUSTER_WORKER_FENCE'));
});

test('renewal preserves generation and expiry aborts ownership cleanup exactly once under reentry',async t=>{
 const f=fixture(t);f.activate();f.fence.admit(binding);f.advance(900);const observation=f.fence.beginHeartbeat();f.fence.acceptLease(observation,lease,{leaseMs:1000});
 assert.equal(f.fence.status().remainingMs,1000);f.fence.signal.addEventListener('abort',()=>{void f.fence.close();});f.advance(1000);
 assert.throws(()=>f.fence.check(binding),error('CLUSTER_WORKER_LEASE'));await f.fence.close();assert.equal(f.cleanups.length,1);
});

test('a different server generation permanently fences the old worker incarnation',t=>{
 const f=fixture(t);f.activate();const observation=f.fence.beginHeartbeat();
 assert.throws(()=>f.fence.acceptLease(observation,{...lease,generation:2},{leaseMs:1000}),error('CLUSTER_WORKER_LEASE'));assert.equal(f.fence.status().state,'expired');
});

test('effects are checked before and after asynchronous work and uncertain outcomes are never called not-dispatched',async t=>{
 const f=fixture(t);f.activate();f.fence.admit(binding);let calls=0;
 assert.equal(await f.fence.run(binding,async signal=>{calls++;assert.equal(signal.aborted,false);return 'done';}),'done');
 await assert.rejects(f.fence.run({...binding,epoch:2},async()=>{calls++;}),error('CLUSTER_WORKER_FENCE'));assert.equal(calls,1);
 await assert.rejects(f.fence.run(binding,async()=>{f.advance(1000);return 'late';}),error('CLUSTER_WORKER_FENCE_LOST','unknown'));
 assert.equal(f.fence.signal.aborted,true);
});

test('effect failures are sanitized and bounded Session fence retention never silently evicts identities',async t=>{
 const f=fixture(t,{maxSessions:1});f.activate();f.fence.admit(binding);
 assert.throws(()=>f.fence.admit({...binding,sessionId:'ses_two',epoch:2}),error('CLUSTER_WORKER_RETENTION_LIMIT'));
 await assert.rejects(f.fence.run(binding,async()=>{throw new Error('private upstream credential');}),e=>e.code==='CLUSTER_WORKER_EFFECT_FAILED'&&e.outcome==='unknown'&&!e.message.includes('credential'));
});

test('a real timer expires a partitioned worker and signals its owner without waiting for another request',async()=>{
 let cleanups=0;const fence=new ClusterWorkerFence({nodeId:lease.nodeId,incarnation:lease.incarnation,onExpired:()=>{cleanups++;}});
 try{fence.acceptLease(fence.beginHeartbeat(),lease,{leaseMs:100});fence.admit(binding);await delay(160);assert.equal(fence.signal.aborted,true);await fence.terminal;assert.equal(cleanups,1);assert.throws(()=>fence.check(binding),error('CLUSTER_WORKER_LEASE'));}finally{await fence.close();}
});

test('a regressing worker clock aborts ownership instead of prolonging the current lease',t=>{
 const f=fixture(t);f.activate();f.advance(-1);assert.throws(()=>f.fence.status(),error('CLUSTER_WORKER_CLOCK'));assert.equal(f.fence.signal.aborted,true);
});
