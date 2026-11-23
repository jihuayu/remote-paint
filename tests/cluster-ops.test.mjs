import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,openSync,closeSync,rmSync,chmodSync,writeFileSync,readFileSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';
import {ClusterWorkerService} from '../service/cluster-worker-service.mjs';
import {createClusterRpcServer} from '../service/cluster-rpc.mjs';
import {ClusterOperations,assemblePrivateCluster,verifyClusterArchive} from '../service/cluster-ops.mjs';
import {createClusterTestPki,readClusterTestTls} from './fixtures/cluster-test-pki.mjs';

const descriptor=(nodeId,capacity=2,extra={})=>({nodeId,incarnation:nodeId+'-boot-1',region:'local',arch:'arm64',version:'source-v1',capacity,...extra});
const request=(sessionId,extra={})=>({tenantId:'tenant-a',sessionId,region:'local',arch:'arm64',version:'source-v1',...extra});
const binding=r=>Object.fromEntries(['tenantId','sessionId','nodeId','generation','epoch'].map(k=>[k,r[k]]));
const error=code=>e=>e.code===code;
const proof={sha256:'a'.repeat(64)};

function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'remote-paint-cluster-ops-'));
 const path=join(directory,'cluster.sqlite');
 const archiveDir=join(directory,'archives');
 mkdirSync(archiveDir,{mode:0o700});
 closeSync(openSync(path,'wx',0o600));
 let at=1000,store;
 const open=()=>store=new ClusterPlacementStore({database:new DatabaseSync(path),now:()=>at,leaseMs:1000,verifyRetirement:(_placement,receipt)=>receipt.sha256===proof.sha256,...options});
 t.after(()=>{store?.close();rmSync(directory,{recursive:true,force:true});});
 open();
 return {get store(){return store;},directory,path,archiveDir,advance:ms=>at+=ms,reopen(){store.close();return open();}};
}

test('placement metrics report per-node capacity, session states, lease remaining and cleanup readiness',t=>{
 const f=fixture(t);
 f.store.registerNode(descriptor('node-a',2));
 f.store.registerNode(descriptor('node-b',3));
 const first=f.store.reserve(request('ses_1'));
 const second=f.store.reserve(request('ses_2'));
 f.store.ready(binding(first));
 f.store.beginRelease(request('ses_2'));
 f.advance(250);
 const snap=f.store.metrics();
 assert.equal(snap.totals.nodes,2);
 assert.equal(snap.totals.totalCapacity,5);
 assert.equal(snap.totals.activeCapacity,5);
 assert.equal(snap.totals.heldSlots,2);
 assert.equal(snap.totals.availableSlots,3);
 assert.deepEqual(snap.totals.byMode,{active:2,draining:0,recovering:0,expired:0});
 assert.deepEqual(snap.totals.byState,{reserved:0,ready:1,closing:1,quarantined:0,closed:0});
 const nodeA=snap.nodes.find(n=>n.nodeId==='node-a');
 const nodeB=snap.nodes.find(n=>n.nodeId==='node-b');
 assert.equal(nodeA.heldSlots,1);
 assert.equal(nodeA.freeSlots,1);
 assert.equal(nodeA.leaseRemainingMs,750);
 assert.equal(nodeA.sessions.ready,1);
 assert.equal(nodeA.safeToStop,false);
 assert.equal(nodeB.sessions.closing,1);
});

test('operator drainNode stops new allocations while keeping existing routes and enforces recovery/lease gates',t=>{
 const f=fixture(t);
 f.store.registerNode(descriptor('node-a',2));
 f.store.registerNode(descriptor('node-b',2));
 const first=f.store.reserve(request('ses_1'));
 f.store.ready(binding(first));
 const drained=f.store.drainNode('node-a',true);
 assert.deepEqual(drained,{nodeId:'node-a',mode:'draining',draining:true,heldSlots:1,quarantinedSessions:0,safeToStop:false});
 assert.equal(f.store.route(request('ses_1')).nodeId,'node-a');
 const second=f.store.reserve(request('ses_2'));
 assert.equal(second.nodeId,'node-b');
 f.store.beginRelease(request('ses_1'));
 f.store.confirmRetired(binding(first),proof);
 const readyToStop=f.store.drainNode('node-a',true);
 assert.equal(readyToStop.safeToStop,true);
 assert.equal(f.store.drainNode('node-a',false).mode,'active');
 assert.throws(()=>f.store.drainNode('missing-node',true),error('CLUSTER_NODE_NOT_FOUND'));
 f.advance(1000);
 assert.throws(()=>f.store.drainNode('node-a',false),error('CLUSTER_LEASE'));
 assert.equal(f.store.drainNode('node-a',true).mode,'expired');
});

test('bounded history archival writes verified 0600 NDJSON batches, frees retention slots, and never archives unresolved sessions',t=>{
 const f=fixture(t,{maxNodes:2,maxSessions:2});
 const ops=new ClusterOperations({store:f.store});
 f.store.registerNode(descriptor('node-a',2));
 const first=f.store.reserve(request('ses_1'));
 const second=f.store.reserve(request('ses_2'));
 f.store.ready(binding(second));
 f.store.beginRelease(request('ses_1'));
 f.store.confirmRetired(binding(first),proof);
 assert.throws(()=>f.store.reserve(request('ses_3')),error('CLUSTER_RETENTION_LIMIT'));

 // Failing or asynchronous archive sink rolls back with zero deletions.
 assert.throws(()=>f.store.archiveClosedSessions({onArchive:()=>{throw new Error('disk full');}}),error('CLUSTER_ARCHIVE_FAILED'));
 assert.throws(()=>f.store.archiveClosedSessions({onArchive:async()=>true}),error('CLUSTER_ARCHIVE_FAILED'));
 assert.equal(f.store.status().retainedSessions,2);

 // Real verified NDJSON archive prunes only the closed session.
 const result=ops.archiveClosedSessions({archiveDir:f.archiveDir,limit:10});
 assert.equal(result.archived,1);
 assert.equal(result.minEpoch,first.epoch);
 assert.equal(result.maxEpoch,first.epoch);
 assert.equal(lstatSync(result.archiveFile).mode&0o777,0o600);
 assert.equal(lstatSync(result.manifestFile).mode&0o777,0o600);
 const verified=verifyClusterArchive({manifestPath:result.manifestFile});
 assert.equal(verified.valid,true);
 assert.equal(verified.records.length,1);
 assert.equal(verified.records[0].sessionId,'ses_1');
 assert.equal(verified.records[0].retirementSha256,proof.sha256);

 // Unresolved session remains intact, retention slot is freed, and epoch keeps increasing.
 assert.equal(f.store.status().retainedSessions,1);
 assert.equal(f.store.metrics().totals.archivedSessions,1);
 assert.equal(f.store.metrics().totals.archivedBatches,1);
 const third=f.store.reserve(request('ses_3'));
 assert.ok(third.epoch>second.epoch);

 // Tampering with archived bytes fails verification.
 const original=readFileSync(result.archiveFile,'utf8');
 writeFileSync(result.archiveFile,original.replace('ses_1','ses_X'),'utf8');
 assert.throws(()=>verifyClusterArchive({manifestPath:result.manifestFile}),error('CLUSTER_ARCHIVE_CORRUPT'));
});

test('archive directory permissions are strictly enforced before pruning',t=>{
 const f=fixture(t);
 const ops=new ClusterOperations({store:f.store});
 f.store.registerNode(descriptor('node-a',1));
 const first=f.store.reserve(request('ses_1'));
 f.store.beginRelease(request('ses_1'));
 f.store.confirmRetired(binding(first),proof);
 chmodSync(f.archiveDir,0o755);
 assert.throws(()=>ops.archiveClosedSessions({archiveDir:f.archiveDir}),error('CLUSTER_ARCHIVE_DIR'));
 assert.equal(f.store.status().retainedSessions,1);
});

test('removeNode enforces drain/retirement/archival gates and preserves monotonic generationFloor across reopen',t=>{
 const f=fixture(t,{maxNodes:1,maxSessions:4});
 const ops=new ClusterOperations({store:f.store});
 const lease=f.store.registerNode(descriptor('node-a',2));
 const first=f.store.reserve(request('ses_1'));
 f.store.ready(binding(first));

 // Active node cannot be removed.
 assert.throws(()=>ops.removeNode('node-a'),error('CLUSTER_NODE_ACTIVE'));

 // Drained node with unresolved session cannot be removed.
 ops.drainNode('node-a');
 assert.throws(()=>ops.removeNode('node-a'),error('CLUSTER_NODE_IN_USE'));

 // Retired but unarchived closed session still blocks removal.
 f.store.beginRelease(request('ses_1'));
 f.store.confirmRetired(binding(first),proof);
 assert.throws(()=>ops.removeNode('node-a'),error('CLUSTER_NODE_HAS_HISTORY'));

 // After archiving node-a's closed sessions, node-a can be removed and maxNodes slot is freed.
 assert.equal(ops.archiveClosedSessions({archiveDir:f.archiveDir,nodeId:'node-a'}).archived,1);
 const removed=ops.removeNode('node-a');
 assert.deepEqual(removed,{nodeId:'node-a',removedGeneration:lease.generation,generationFloor:lease.generation});
 assert.equal(f.store.status().nodes,0);

 // Re-opening preserves generationFloor so re-registering node-a never reuses generation 1.
 f.reopen();
 const next=f.store.registerNode(descriptor('node-a',2,{incarnation:'node-a-boot-2'}));
 assert.ok(next.generation>lease.generation);
});

test('planRollingUpgrade requires active target-version capacity before recommending draining old nodes',t=>{
 const f=fixture(t);
 const ops=new ClusterOperations({store:f.store});
 f.store.registerNode(descriptor('node-v1',2,{version:'source-v1'}));
 const s1=f.store.reserve(request('ses_v1',{version:'source-v1'}));
 f.store.ready(binding(s1));

 // Without target-version capacity, cannot drain old nodes.
 const beforeTarget=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.equal(beforeTarget.canDrainOld,false);
 assert.deepEqual(beforeTarget.readyToDrain,[]);
 assert.equal(beforeTarget.complete,false);

 // Bring up target-version node.
 f.store.registerNode(descriptor('node-v2',2,{version:'source-v2'}));
 const readyPlan=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.equal(readyPlan.canDrainOld,true);
 assert.deepEqual(readyPlan.readyToDrain,['node-v1']);

 // Drain old node while s1 is still active.
 ops.drainNode('node-v1');
 const drainingPlan=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.deepEqual(drainingPlan.draining,['node-v1']);
 assert.deepEqual(drainingPlan.safeToRemove,[]);

 // Retire s1 -> needs archive before removal.
 f.store.beginRelease(request('ses_v1'));
 f.store.confirmRetired(binding(s1),proof);
 const archivePlan=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.deepEqual(archivePlan.safeToArchiveAndRemove,['node-v1']);

 // Archive and remove old node -> upgrade complete.
 ops.archiveClosedSessions({archiveDir:f.archiveDir,nodeId:'node-v1'});
 const removablePlan=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.deepEqual(removablePlan.safeToRemove,['node-v1']);
 ops.removeNode('node-v1');
 const finalPlan=ops.planRollingUpgrade({region:'local',arch:'arm64',targetVersion:'source-v2',minTargetCapacity:2});
 assert.equal(finalPlan.complete,true);
});

test('assemblePrivateCluster wires mTLS workers, operator drain, metrics and verified archival end to end',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'cluster-private-assembly-'));
 const pki=join(directory,'pki');
 const archiveDir=join(directory,'archives');
 mkdirSync(archiveDir,{mode:0o700});
 const pins=createClusterTestPki(pki);
 const placementPath=join(directory,'placement.sqlite');
 closeSync(openSync(placementPath,'wx',0o600));
 const version='cluster-ops-v1';
 const services=[],servers=[],workerSpecs=[];
 let cluster=null;
 t.after(async()=>{
  if(cluster)await cluster.shutdown();
  for(const service of services)await service.close();
  for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}
  rmSync(directory,{recursive:true,force:true});
 });

 for(const nodeId of ['worker-a','worker-b']){
  const entries=new Map();
  const impl={
   create(req){entries.set(req.sessionId,{closed:false});return {version};},
   close({sessionId}){const e=entries.get(sessionId);if(e)e.closed=true;return {status:'closed'};},
   resolveSource(req){return {...req,origin:'http://127.0.0.1:4176',streamOrigin:'http://127.0.0.1:4177',key:'k'};},
   agent(){return {stage:'run-closed'};}
  };
  const service=new ClusterWorkerService({nodeId,incarnation:'boot-'+nodeId,region:'test',version,provider:impl,leaseMs:2000,maxSessions:16,verifyRetirement:()=>proof});
  services.push(service);
  const server=createClusterRpcServer({tls:readClusterTestTls(pki,nodeId),clientSha256:[pins.controller],handle:service.handle.bind(service)});
  servers.push(server);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  workerSpecs.push({
   nodeId,incarnation:'boot-'+nodeId,endpoint:'https://127.0.0.1:'+server.address().port,
   serverName:nodeId+'.test',serverSha256:pins[nodeId],capacity:2,
   validateSource:(target,req)=>target.sessionId===req.sessionId&&target.tenantId===req.tenantId
  });
 }

 // Rejects duplicate nodeIds before opening resources.
 assert.throws(()=>assemblePrivateCluster({placementPath,region:'test',arch:'arm64',version,controllerTls:readClusterTestTls(pki,'controller'),workers:[workerSpecs[0],workerSpecs[0]]}),TypeError);

 cluster=assemblePrivateCluster({placementPath,region:'test',arch:'arm64',version,leaseMs:2000,heartbeatMs:200,controllerTls:readClusterTestTls(pki,'controller'),workers:workerSpecs});
 assert.equal((await cluster.initialize()).availableWorkers,2);

 // Drain worker-a so new session lands on worker-b.
 const drain=cluster.operations.drainNode('worker-a');
 assert.equal(drain.draining,true);
 assert.equal(drain.safeToStop,true);

 await cluster.provider.create({tenantId:'tenant-a',sessionId:'ses_ops_1',region:'test',url:'about:blank',ttlSeconds:60});
 const snap=cluster.operations.snapshot();
 assert.equal(snap.provider.availableWorkers,2);
 assert.equal(snap.provider.drainingWorkers,1);
 assert.equal(snap.placement.nodes.find(n=>n.nodeId==='worker-a').heldSlots,0);
 assert.equal(snap.placement.nodes.find(n=>n.nodeId==='worker-b').heldSlots,1);

 // Close session, archive history, and confirm metrics reflect zero held slots and 1 archived session.
 const closed=await cluster.provider.close({tenantId:'tenant-a',sessionId:'ses_ops_1',region:'test',reason:'released'});
 assert.equal(closed.status,'closed');
 const archived=cluster.operations.archiveClosedSessions({archiveDir});
 assert.equal(archived.archived,1);
 assert.equal(cluster.operations.snapshot().placement.totals.retainedSessions,0);
 assert.equal(cluster.operations.snapshot().placement.totals.archivedSessions,1);
});
