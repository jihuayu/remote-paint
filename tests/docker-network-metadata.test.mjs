import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
const networkId='a'.repeat(64),daemonId='network-fixture',info={ID:daemonId,OSType:'linux',Architecture:'arm64'},network={Id:networkId,Name:'bridge',Driver:'bridge',Scope:'local'};
const send=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
async function fixture(t,handler,options={}){const directory=await mkdtemp(join(tmpdir(),'rp-net-meta-')),socket=join(directory,'engine.sock'),seen=[],sockets=new Set();const server=createServer((req,res)=>{seen.push({method:req.method,url:req.url});handler(req,res,seen);});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(socket,r));const client=new DockerMetadataClient({socketPath:socket,daemonId,...options});t.after(async()=>{await client.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});});assert.equal(typeof client.inspectNetwork,'function');return {client,seen};}
test('network inspect uses a full ID and the same pinned Unix Engine before and after a finite GET',async t=>{
 const h=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:network));const value=await h.client.inspectNetwork(networkId);assert.equal(value.found,true);assert.equal(value.document.Id,networkId);assert.equal(value.daemon.id,daemonId);assert.deepEqual(h.seen,[{method:'GET',url:'/v1.45/info'},{method:'GET',url:'/v1.45/networks/'+networkId},{method:'GET',url:'/v1.45/info'}]);assert.equal(h.client.status().activeRequests,0);
});
test('network names, partial IDs and arbitrary paths reject before metadata dispatch',async t=>{
 const h=await fixture(t,(_req,res)=>send(res,info));for(const id of ['bridge','a'.repeat(12),'../info','http://other.test',null])await assert.rejects(h.client.inspectNetwork(id),TypeError);assert.equal(h.seen.length,0);
});
test('network 404 is bounded absence only after the second matching Engine observation',async t=>{
 let infos=0;const good=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:{message:'private-error'},req.url.endsWith('/info')?200:404));assert.deepEqual(await good.client.inspectNetwork(networkId),{found:false,daemon:{id:daemonId,os:'linux',architecture:'arm64',version:null},networkId});assert.equal(good.seen.length,3);const bad=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?{...info,ID:++infos===1?daemonId:'other'}:{message:'private-error'},req.url.endsWith('/info')?200:404));await assert.rejects(bad.client.inspectNetwork(networkId),e=>e.code==='ENGINE_ID_CHANGED');
});
test('network identity changes and malformed representations never yield a route or expose bodies',async t=>{
 for(const value of [{...network,Id:'b'.repeat(64)},{...network,Name:7},{...network,Driver:null},{...network,Scope:null}]){const h=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:value));await assert.rejects(h.client.inspectNetwork(networkId),e=>['ENGINE_NETWORK_CHANGED','ENGINE_RESPONSE_INVALID'].includes(e.code));}const h=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else res.end('private-secret'.repeat(200));},{maxResponseBytes:1024});await assert.rejects(h.client.inspectNetwork(networkId),e=>e.code==='ENGINE_BODY_LIMIT'&&!JSON.stringify(e).includes('private-secret'));
});
test('all network observations share the original total deadline without retry or redirect',async t=>{
 const h=await fixture(t,(req,res)=>{setTimeout(()=>send(res,req.url.endsWith('/info')?info:network),35);},{timeoutMs:85});await assert.rejects(h.client.inspectNetwork(networkId),e=>e.code==='ENGINE_DEADLINE');assert.ok(h.seen.length<=3);const redirect=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else{res.writeHead(302,{location:'http://private.invalid'});res.end();}});await assert.rejects(redirect.client.inspectNetwork(networkId),e=>e.code==='ENGINE_HTTP'&&e.status===302);assert.equal(redirect.seen.length,2);
});
test('abort, admission and close release actual network-read sockets and queue no implicit work',async t=>{
 const h=await fixture(t,()=>{},{maxConcurrent:1,timeoutMs:100}),cancelled=new AbortController();cancelled.abort();await assert.rejects(h.client.inspectNetwork(networkId,{signal:cancelled.signal}),e=>e.code==='ENGINE_ABORTED');assert.equal(h.seen.length,0);const live=new AbortController(),first=h.client.inspectNetwork(networkId,{signal:live.signal});await assert.rejects(h.client.inspectNetwork(networkId),e=>e.code==='ENGINE_BUSY');live.abort();await assert.rejects(first,e=>e.code==='ENGINE_ABORTED');assert.equal((await h.client.close()).status,'closed');assert.equal(h.client.status().activeRequests,0);await assert.rejects(h.client.inspectNetwork(networkId),e=>e.code==='ENGINE_CLIENT_CLOSED');
});
