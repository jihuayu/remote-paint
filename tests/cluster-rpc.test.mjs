import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ClusterRpcClient,createClusterRpcServer} from '../service/cluster-rpc.mjs';
import {createClusterTestPki,readClusterTestTls} from './fixtures/cluster-test-pki.mjs';
const directory=process.env.REMOTE_PAINT_CLUSTER_TEST_PKI??mkdtempSync(join(tmpdir(),'cluster-test-pki-'));
const pins=process.env.REMOTE_PAINT_CLUSTER_TEST_PKI?JSON.parse(readFileSync(join(directory,'pins.json'))):createClusterTestPki(directory);
if(!process.env.REMOTE_PAINT_CLUSTER_TEST_PKI)test.after(()=>rmSync(directory,{recursive:true,force:true}));
async function fixture(t,{handle=async(_method,payload)=>payload,...options}={}){
 const server=createClusterRpcServer({tls:readClusterTestTls(directory,'worker-a'),clientSha256:[pins.controller],handle,...options});server.listen(0,'127.0.0.1');await once(server,'listening');
 const clients=[];const client=extra=>{const result=new ClusterRpcClient({endpoint:'https://127.0.0.1:'+server.address().port,serverName:'worker-a.test',serverSha256:pins['worker-a'],tls:readClusterTestTls(directory,'controller'),...extra});clients.push(result);return result;};
 t.after(async()=>{for(const c of clients)c.close();server.closeAllConnections();await new Promise(r=>server.close(r));});return {server,client};
}
test('mTLS validates both identities and carries a bounded correlated response',async t=>{const f=await fixture(t);assert.deepEqual(await f.client().call('status',{marker:'synthetic'}),{marker:'synthetic'});});
test('a CA-trusted client outside the fingerprint allowlist cannot execute a handler',async t=>{let calls=0;const f=await fixture(t,{handle:async()=>{calls++;return {};}});await assert.rejects(f.client({tls:readClusterTestTls(directory,'other-client')}).call('status',{}));assert.equal(calls,0);});
test('server fingerprint and hostname checks both precede handler execution',async t=>{let calls=0;const f=await fixture(t,{handle:async()=>{calls++;return {};}});await assert.rejects(f.client({serverSha256:'0'.repeat(64)}).call('status',{}));await assert.rejects(f.client({serverName:'wrong.test'}).call('status',{}));assert.equal(calls,0);});
test('client bounds reject before dispatch and TLS timeouts remain uncertain',async t=>{
 let release;const held=new Promise(r=>release=r);const f=await fixture(t,{handle:async()=>{await held;return {};}}),c=f.client({maxConcurrent:1,timeoutMs:100,maxBytes:1024});
 await assert.rejects(c.call('unknown',{}),e=>e.outcome==='not-dispatched');await assert.rejects(c.call('status',{large:'a'.repeat(2048)}),e=>e.outcome==='not-dispatched');
 const first=c.call('status',{});await assert.rejects(c.call('status',{}),e=>e.outcome==='not-dispatched');await assert.rejects(first,e=>e.outcome==='unknown');release();
});
test('server admission remains owned after observer timeout until the actual handler settles',async t=>{
 let release;const held=new Promise(r=>release=r);const f=await fixture(t,{timeoutMs:100,maxConcurrent:1,handle:async()=>{await held;return {};}}),c=f.client();
 await assert.rejects(c.call('status',{}));assert.equal(f.server.clusterStatus().active,1);await assert.rejects(c.call('status',{}));assert.equal(f.server.clusterStatus().active,1);release();await delay(10);assert.equal(f.server.clusterStatus().active,0);
});
test('unknown handler failures are sanitized and no automatic retry duplicates effects',async t=>{let calls=0;const f=await fixture(t,{handle:async()=>{calls++;throw new Error('private configuration and access material');}});await assert.rejects(f.client().call('status',{}),e=>e.code==='CLUSTER_RPC_HANDLER'&&e.outcome==='unknown'&&!e.message.includes('material'));assert.equal(calls,1);});
test('bounded per-call startup budgets do not force the heartbeat timeout onto an owned create',async t=>{const f=await fixture(t,{handle:async()=>{await delay(150);return {ready:true};}});assert.deepEqual(await f.client({timeoutMs:100}).call('create',{}, {timeoutMs:500}),{ready:true});});
