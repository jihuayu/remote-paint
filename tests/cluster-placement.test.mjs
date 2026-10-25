import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,openSync,closeSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';

const descriptor=(nodeId,capacity=2,extra={})=>({nodeId,incarnation:nodeId+'-boot-1',region:'local',arch:'arm64',version:'source-v1',capacity,...extra});
const request=(sessionId,extra={})=>({tenantId:'tenant-a',sessionId,region:'local',arch:'arm64',version:'source-v1',...extra});
const binding=r=>Object.fromEntries(['tenantId','sessionId','nodeId','generation','epoch'].map(k=>[k,r[k]]));
const error=code=>e=>e.code===code;
const proof={sha256:'a'.repeat(64)};
function fixture(t,options={}){
 const directory=mkdtempSync(join(tmpdir(),'remote-paint-cluster-')),path=join(directory,'cluster.sqlite');closeSync(openSync(path,'wx',0o600));
 let at=1000,store;const open=()=>store=new ClusterPlacementStore({database:new DatabaseSync(path),now:()=>at,leaseMs:1000,verifyRetirement:(_placement,receipt)=>receipt.sha256===proof.sha256,...options});
 t.after(()=>{store?.close();rmSync(directory,{recursive:true,force:true});});open();
 return {get store(){return store;},path,advance:ms=>at+=ms,reopen(){store.close();return open();}};
}

test('two-node scheduling balances reserved slots, matches region/architecture, and routes by original tenant/version',t=>{
 const f=fixture(t),a=f.store.registerNode(descriptor('node-a')),b=f.store.registerNode(descriptor('node-b'));
 f.store.registerNode(descriptor('node-x64',10,{arch:'x64'}));f.store.registerNode(descriptor('other-region',10,{region:'other'}));
 const first=f.store.reserve(request('ses_first')),second=f.store.reserve(request('ses_second'));
 assert.equal(first.nodeId,a.nodeId);assert.equal(second.nodeId,b.nodeId);assert.notEqual(first.epoch,second.epoch);
 assert.throws(()=>f.store.route(request('ses_first')),error('CLUSTER_SESSION_UNAVAILABLE'));
 f.store.ready(binding(first));assert.equal(f.store.route(request('ses_first')).nodeId,a.nodeId);
 assert.throws(()=>f.store.route(request('ses_first',{tenantId:'tenant-b'})),error('CLUSTER_SESSION_NOT_FOUND'));
 assert.throws(()=>f.store.route(request('ses_first',{version:'source-v2'})),error('CLUSTER_SESSION_UNAVAILABLE'));
});

test('drain rejects new allocation but keeps existing routes, then re-enables admission explicitly',t=>{
 const f=fixture(t),lease=f.store.registerNode(descriptor('node-a'));
 const first=f.store.reserve(request('ses_first'));f.store.ready(binding(first));f.store.drain(lease);
 assert.equal(f.store.route(request('ses_first')).nodeId,'node-a');assert.throws(()=>f.store.reserve(request('ses_new')),error('CLUSTER_CAPACITY'));
 f.store.drain(lease,false);assert.equal(f.store.reserve(request('ses_new')).nodeId,'node-a');
});

test('slots survive release until independently verified physical retirement; a Session ID never creates a second allocation',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-a',1));const first=f.store.reserve(request('ses_first'));
 assert.deepEqual(f.store.reserve(request('ses_first')),first);f.store.beginRelease(request('ses_first'));
 assert.throws(()=>f.store.reserve(request('ses_new')),error('CLUSTER_CAPACITY'));
 assert.throws(()=>f.store.confirmRetired(binding(first),{sha256:'b'.repeat(64)}),error('CLUSTER_RETIREMENT_UNCONFIRMED'));assert.equal(f.store.status().heldSlots,1);
 assert.deepEqual(f.store.confirmRetired(binding(first),proof),{status:'closed'});assert.equal(f.store.status().heldSlots,0);
 assert.equal(f.store.reserve(request('ses_first')).state,'closed');assert.equal(f.store.reserve(request('ses_new')).nodeId,'node-a');
});

test('cross-tenant Session IDs and altered retry fingerprints cannot disclose or reassign ownership',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-a'));f.store.reserve(request('ses_first'));
 assert.throws(()=>f.store.reserve(request('ses_first',{tenantId:'tenant-b'})),error('CLUSTER_SESSION_NOT_FOUND'));
 assert.throws(()=>f.store.reserve(request('ses_first',{version:'source-v2'})),error('CLUSTER_IDEMPOTENCY_CONFLICT'));
 assert.equal(f.store.status().heldSlots,1);
});

test('lease expiry denies heartbeat, Ready and routing, and never releases a possibly live runtime',t=>{
 const f=fixture(t),lease=f.store.registerNode(descriptor('node-a',1)),row=f.store.reserve(request('ses_first'));f.store.ready(binding(row));f.advance(1000);
 assert.throws(()=>f.store.heartbeat(lease),error('CLUSTER_LEASE'));assert.throws(()=>f.store.ready(binding(row)),error('CLUSTER_FENCE'));assert.throws(()=>f.store.route(request('ses_first')),error('CLUSTER_SESSION_UNAVAILABLE'));
 assert.deepEqual(f.store.status(),{nodes:1,retainedSessions:1,heldSlots:1,quarantined:1});assert.equal(f.store.reserve(request('ses_first')).state,'quarantined');
});

test('worker reincarnation increments generation but remains fenced until old owned resources have retirement evidence',t=>{
 const f=fixture(t),old=f.store.registerNode(descriptor('node-a',1)),row=f.store.reserve(request('ses_first'));
 assert.throws(()=>f.store.registerNode(descriptor('node-a',1,{incarnation:'boot-2'})),error('CLUSTER_NODE_OWNED'));
 f.advance(1000);const next=f.store.registerNode(descriptor('node-a',1,{incarnation:'boot-2'}));assert.ok(next.generation>old.generation);
 assert.throws(()=>f.store.heartbeat(old),error('CLUSTER_LEASE'));assert.throws(()=>f.store.reserve(request('ses_new')),error('CLUSTER_CAPACITY'));
 assert.throws(()=>f.store.drain(next,false),error('CLUSTER_RECOVERY_REQUIRED'));
 f.store.confirmRetired(binding(row),proof);assert.equal(f.store.reserve(request('ses_new')).generation,next.generation);
});

test('stale or altered placement fences cannot publish Ready or retire another allocation',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-a'));const row=f.store.reserve(request('ses_first'));
 for(const patch of [{epoch:row.epoch+1},{generation:row.generation+1},{tenantId:'tenant-b'},{nodeId:'node-other'}])assert.throws(()=>f.store.ready({...binding(row),...patch}),error('CLUSTER_FENCE'));
 assert.throws(()=>f.store.confirmRetired(binding(row),proof),error('CLUSTER_RETIREMENT_REQUIRED'));
 f.store.beginRelease(request('ses_first'));assert.throws(()=>f.store.confirmRetired({...binding(row),epoch:row.epoch+1},proof),error('CLUSTER_FENCE'));
});

test('durable restart quarantines all live placements and preserves monotonically increasing fences',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-a'));const old=f.store.reserve(request('ses_first'));f.store.ready(binding(old));f.reopen();
 assert.equal(f.store.status().quarantined,1);assert.throws(()=>f.store.route(request('ses_first')),error('CLUSTER_SESSION_UNAVAILABLE'));
 const lease=f.store.registerNode(descriptor('node-a',2,{incarnation:'boot-2'}));assert.ok(lease.generation>old.generation);
 assert.throws(()=>f.store.reserve(request('ses_new')),error('CLUSTER_CAPACITY'));f.store.confirmRetired(binding(old),proof);
 const next=f.store.reserve(request('ses_new'));assert.ok(next.epoch>old.epoch);assert.equal(f.store.reserve(request('ses_first')).state,'closed');
});

test('a second SQLite controller cannot reset the live exclusive owner',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-a'));const second=new DatabaseSync(f.path);
 try{assert.throws(()=>new ClusterPlacementStore({database:second,verifyRetirement:()=>true}),error('CLUSTER_STORAGE'));assert.equal(f.store.status().nodes,1);}finally{second.close();}
});

test('bounded retention and node counts reject growth rather than discard unresolved ownership',t=>{
 const f=fixture(t,{maxNodes:1,maxSessions:1});f.store.registerNode(descriptor('node-a'));
 assert.throws(()=>f.store.registerNode(descriptor('node-b')),error('CLUSTER_NODE_LIMIT'));const row=f.store.reserve(request('ses_first'));
 f.store.beginRelease(request('ses_first'));f.store.confirmRetired(binding(row),proof);
 assert.throws(()=>f.store.reserve(request('ses_new')),error('CLUSTER_RETENTION_LIMIT'));
});

test('strict descriptors reject application accessors and regressing clocks cannot extend a lease',t=>{
 const f=fixture(t);let reads=0;const invalid=descriptor('node-a');Object.defineProperty(invalid,'capacity',{get(){reads++;return 2;}});
 assert.throws(()=>f.store.registerNode(invalid),TypeError);assert.equal(reads,0);const lease=f.store.registerNode(descriptor('node-a'));
 f.advance(-1);assert.throws(()=>f.store.heartbeat(lease),error('CLUSTER_CLOCK'));f.advance(1);assert.equal(f.store.heartbeat(lease).generation,lease.generation);
});

test('retirement verifier failure retains ownership and permits an explicit verified retry',t=>{
 let available=false;const f=fixture(t,{verifyRetirement:()=>{if(!available)throw new Error('private evidence reader unavailable');return true;}});
 f.store.registerNode(descriptor('node-a'));const row=f.store.reserve(request('ses_first'));f.store.beginRelease(request('ses_first'));
 assert.throws(()=>f.store.confirmRetired(binding(row),proof),error('CLUSTER_RETIREMENT_UNCONFIRMED'));assert.equal(f.store.status().heldSlots,1);
 available=true;assert.equal(f.store.confirmRetired(binding(row),proof).status,'closed');
});

test('malformed retirement fences and asynchronous verification cannot release or poison the ledger',t=>{
 const f=fixture(t,{verifyRetirement:async()=>{throw new Error('not a synchronous verifier');}});f.store.registerNode(descriptor('node-a'));const row=f.store.reserve(request('ses_first'));f.store.beginRelease(request('ses_first'));
 assert.throws(()=>f.store.confirmRetired({...binding(row),epoch:Symbol('invalid')},proof),TypeError);
 assert.throws(()=>f.store.confirmRetired(binding(row),proof),error('CLUSTER_RETIREMENT_UNCONFIRMED'));assert.equal(f.store.status().heldSlots,1);
});

test('cluster persistence rejects in-memory databases and permanently fences replaced ledger identities',t=>{
 const memory=new DatabaseSync(':memory:');try{assert.throws(()=>new ClusterPlacementStore({database:memory,verifyRetirement:()=>true}),error('CLUSTER_DATABASE_FILE'));}finally{memory.close();}
 const f=fixture(t);f.store.registerNode(descriptor('node-a'));renameSync(f.path,f.path+'.old');closeSync(openSync(f.path,'wx',0o600));
 assert.throws(()=>f.store.status(),error('CLUSTER_STORAGE'));assert.throws(()=>f.store.registerNode(descriptor('node-b')),error('CLUSTER_CLOSED'));
});

test('rolling versions allocate only to matching worker versions and never migrate existing Session identities',t=>{
 const f=fixture(t);f.store.registerNode(descriptor('node-v1'));f.store.registerNode(descriptor('node-v2',2,{version:'source-v2'}));
 const old=f.store.reserve(request('ses_old'));assert.equal(old.nodeId,'node-v1');f.store.ready(binding(old));
 const next=f.store.reserve(request('ses_new',{version:'source-v2'}));assert.equal(next.nodeId,'node-v2');
 assert.equal(f.store.route(request('ses_old')).nodeId,'node-v1');assert.throws(()=>f.store.reserve(request('ses_other',{version:'source-v3'})),error('CLUSTER_CAPACITY'));
});

test('the existing Native Chromium/Wasm data version is preserved verbatim through placement and routing',t=>{
 const f=fixture(t),version='chromium:155.0.8059.79;wasm:'+'a'.repeat(64);f.store.registerNode(descriptor('native-node',1,{version}));
 const row=f.store.reserve(request('ses_native',{version}));f.store.ready(binding(row));assert.equal(f.store.route(request('ses_native',{version})).version,version);
 assert.throws(()=>f.store.registerNode(descriptor('bad-node',1,{version:'bad\nversion'})),TypeError);
});
