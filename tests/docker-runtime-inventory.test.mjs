import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DockerMetadataClient,DockerMetadataError} from '../service/docker-metadata-client.mjs';
const daemonId='inventory-engine',deploymentId='stable-deployment',region='test-region',prefix='org.remote-paint.runtime.';
const info={ID:daemonId,OSType:'linux',Architecture:'aarch64'},scope={deploymentId,region},id=n=>n.toString(16).padStart(64,'0');
const row=(n,extra={})=>({Id:id(n),Names:['/fixture-'+n],State:'created',Labels:{[prefix+'deployment']:deploymentId,[prefix+'region']:region,[prefix+'schema']:'session-runtime-v1',[prefix+'daemon']:daemonId},...extra});
const code=value=>error=>error instanceof DockerMetadataError&&error.code===value;
const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
async function fixture(t,handler,options={}){
 const directory=await mkdtemp(join(tmpdir(),'rp-inventory-')),socketPath=join(directory,'engine.sock'),seen=[],sockets=new Set();
 const server=createServer((req,res)=>{seen.push({method:req.method,url:req.url});handler(req,res,seen);});server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});await new Promise(resolve=>server.listen(socketPath,resolve));
 const client=new DockerMetadataClient({socketPath,daemonId,...options});t.after(async()=>{await client.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});return {client,seen};
}
test('inventory queries all states without truncation and returns only complete candidate IDs',async t=>{
 const data=[row(3,{State:'exited',Command:'private-url',Labels:{...row(3).Labels,private:'private-owner-key'}}),row(1,{State:'running'}),row(2)];
 const {client,seen}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:data));const result=await client.listRuntimeCandidates(scope);
 assert.deepEqual(result.containerIds,[id(1),id(2),id(3)]);assert.equal(result.daemon.id,daemonId);assert.ok(Object.isFrozen(result.containerIds));assert.ok(!JSON.stringify(result).includes('private-'));
 assert.deepEqual(seen.map(x=>x.method),['GET','GET','GET']);const url=new URL(seen[1].url,'http://local.invalid');assert.equal(url.pathname,'/v1.45/containers/json');assert.deepEqual([...url.searchParams.keys()],['all','filters']);assert.equal(url.searchParams.get('all'),'1');
 assert.deepEqual(JSON.parse(url.searchParams.get('filters')),{label:[prefix+'deployment='+deploymentId,prefix+'region='+region]});assert.equal(client.status().activeRequests,0);
});
test('empty inventory requires a complete array and matching final engine witness',async t=>{
 let witnesses=0;const good=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:[]));assert.deepEqual((await good.client.listRuntimeCandidates(scope)).containerIds,[]);assert.equal(good.seen.length,3);
 const changed=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?{...info,ID:++witnesses===1?daemonId:'changed'}:[]));await assert.rejects(changed.client.listRuntimeCandidates(scope),code('ENGINE_ID_CHANGED'));
});
test('unsupported schema or wrong daemon/deployment/region are conflicts rather than hidden candidates',async t=>{
 for(const [key,value]of [['schema','other'],['daemon','other'],['deployment','other'],['region','other']]){
  const candidate=row(1);candidate.Labels[prefix+key]=value;const {client}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:[candidate]));await assert.rejects(client.listRuntimeCandidates(scope),code('ENGINE_INVENTORY_CONFLICT'));
 }
});
test('duplicate,truncated IDs and missing or nonobject labels fail the complete inventory',async t=>{
 for(const data of [[row(1),row(1)],[row(1,{Id:'abcdef'})],[row(1,{Labels:null})],[row(1,{Labels:[]})],[null]]){
  const {client}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:data));await assert.rejects(client.listRuntimeCandidates(scope),code('ENGINE_INVENTORY_CONFLICT'));
 }
});
test('record cap rejects the whole reply instead of selecting a prefix or adding a Docker limit',async t=>{
 const {client,seen}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:[row(1),row(2),row(3)]),{maxRuntimeRecords:2});await assert.rejects(client.listRuntimeCandidates(scope),code('ENGINE_INVENTORY_LIMIT'));assert.equal(client.status().maxRuntimeRecords,2);assert.ok(!seen[1].url.includes('limit'));
});
test('declared and streamed byte caps reject oversized array data without exposing its contents',async t=>{
 for(const declared of [true,false]){
  const {client}=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else{res.writeHead(200,declared?{'content-length':'99999'}:{});res.end(JSON.stringify([row(1,{Command:'private-secret'.repeat(1000)})]));}},{maxResponseBytes:1024});
  await assert.rejects(client.listRuntimeCandidates(scope),e=>code('ENGINE_BODY_LIMIT')(e)&&!JSON.stringify(e).includes('private-secret'));assert.equal((await client.close()).activeRequests,0);
 }
});
test('HTTP errors and redirects never become an empty inventory or another endpoint',async t=>{
 for(const status of [301,403,404,500]){
  const {client,seen}=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else{res.writeHead(status,{Location:'http://private.invalid'});res.end('private-response');}});
  await assert.rejects(client.listRuntimeCandidates(scope),e=>code('ENGINE_HTTP')(e)&&e.status===status&&!JSON.stringify(e).includes('private-response'));assert.equal(seen.length,2);
 }
});
test('object,scalar,malformed UTF8 and incomplete array bodies are unavailable',async t=>{
 for(const mode of ['object','scalar','utf8','incomplete']){
  const {client}=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else if(mode==='object')send(res,{containers:[]});else if(mode==='scalar')send(res,null);else if(mode==='utf8')res.end(Buffer.from([91,255,93]));else{res.writeHead(200,{'content-length':'100'});res.write('[');setTimeout(()=>res.destroy(),5);}});
  await assert.rejects(client.listRuntimeCandidates(scope),e=>e instanceof DockerMetadataError);assert.equal((await client.close()).activeRequests,0);
 }
});
test('one deadline covers both engine witnesses and the inventory read',async t=>{
 const {client}=await fixture(t,(req,res)=>setTimeout(()=>send(res,req.url.endsWith('/info')?info:[]),35),{timeoutMs:85});await assert.rejects(client.listRuntimeCandidates(scope),code('ENGINE_DEADLINE'));assert.equal((await client.close()).status,'closed');
});
test('abort in an inventory read drains its socket and does not retry',async t=>{
 let entered;const pendingRead=new Promise(resolve=>entered=resolve),{client,seen}=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else entered();}),controller=new AbortController(),pending=client.listRuntimeCandidates({...scope,signal:controller.signal});await pendingRead;controller.abort(new Error('private-abort'));await assert.rejects(pending,e=>code('ENGINE_ABORTED')(e)&&!JSON.stringify(e).includes('private-abort'));assert.equal(seen.length,2);assert.equal((await client.close()).status,'closed');
});
test('invalid trusted scopes and count bounds dispatch no requests',async t=>{
 const {client,seen}=await fixture(t,()=>{});for(const value of [{deploymentId:'../bad',region},{deploymentId,region:''},{deploymentId,region:'x'.repeat(65)},{deploymentId,region:'bad\0region'}])await assert.rejects(client.listRuntimeCandidates(value),TypeError);assert.equal(seen.length,0);
 for(const maxRuntimeRecords of [0,4097,1.5])assert.throws(()=>new DockerMetadataClient({socketPath:'/tmp/unused-inventory',daemonId,maxRuntimeRecords}),TypeError);
});
