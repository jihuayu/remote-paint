import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerMetadataClient,DockerMetadataError} from '../service/docker-metadata-client.mjs';
const daemonId='daemon-fixture',imageId='sha256:'+'a'.repeat(64),cid='b'.repeat(64),info={ID:daemonId,OSType:'linux',Architecture:'aarch64',ServerVersion:'fixture'};
const code=value=>e=>e instanceof DockerMetadataError&&e.code===value;
async function fixture(t,handler,options={}){
 const directory=await mkdtemp(join(tmpdir(),'rp-engine-')),socket=join(directory,'engine.sock'),seen=[],sockets=new Set(),server=createServer((req,res)=>{seen.push({method:req.method,url:req.url});handler(req,res,seen);});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(socket,resolve));const client=new DockerMetadataClient({socketPath:socket,daemonId,...options});
 t.after(async()=>{await client.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});return {client,seen,server,socket};
}
const send=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
test('Unix metadata operations pin daemon/platform and fence both sides of complete image and container reads',async t=>{
 const {client,seen}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:req.url.includes('/images/')?{Id:imageId,Os:'linux',Architecture:'arm64',Config:{}}:{Id:cid,Image:imageId,Name:'/fixture'}),{maxConcurrent:1});assert.equal((await client.daemon()).id,daemonId);assert.equal((await client.inspectImage(imageId)).document.Id,imageId);assert.equal((await client.inspectContainer(cid)).document.Id,cid);assert.ok(seen.every(r=>r.method==='GET'));assert.equal(seen.length,7);assert.equal(client.status().activeRequests,0);
});
test('404 is absence only after a complete JSON reply and the second matching daemon witness',async t=>{
 const {client,seen}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:{message:'private content omitted'},req.url.endsWith('/info')?200:404));assert.deepEqual(await client.inspectContainer('fixture'),{found:false,daemon:{id:daemonId,os:'linux',architecture:'arm64',version:'fixture'},selector:'fixture'});assert.equal(seen.length,3);
});
test('daemon change before or after an object read rejects it,including an otherwise valid404',async t=>{
 let phase=0;const {client}=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?{...info,ID:++phase===1?daemonId:'other'}:{message:'absent'},req.url.endsWith('/info')?200:404));await assert.rejects(client.inspectContainer(cid),code('ENGINE_ID_CHANGED'));
});
test('platform drift and wrong or unpinned image identities fail without fallback',async t=>{
 const a=await fixture(t,(_req,res)=>send(res,{...info,Architecture:'x86_64'}));await assert.rejects(a.client.daemon(),code('ENGINE_PLATFORM_CHANGED'));
 const b=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:{Id:'sha256:'+'f'.repeat(64),Os:'linux',Architecture:'arm64'}));await assert.rejects(b.client.inspectImage(imageId),code('ENGINE_IMAGE_CHANGED'));await assert.rejects(b.client.inspectImage('latest'),TypeError);
});
test('HTTP403 and redirects are unavailable,never absence or a second endpoint',async t=>{
 for(const status of [301,403,500]){const {client,seen}=await fixture(t,(req,res)=>{if(req.url.endsWith('/info'))send(res,info);else{res.writeHead(status,{Location:'http://private.invalid'});res.end('secret');}});await assert.rejects(client.inspectContainer(cid),e=>code('ENGINE_HTTP')(e)&&e.status===status&&!e.message.includes('secret'));assert.equal(seen.length,2);}
});
test('declared and streaming response limits stop the read and never expose partial JSON or secret error bodies',async t=>{
 for(const declared of [true,false]){const {client}=await fixture(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json',...(declared?{'content-length':'99999'}:{})});res.end('private-secret'.repeat(1000));},{maxResponseBytes:1024});await assert.rejects(client.daemon(),e=>code('ENGINE_BODY_LIMIT')(e)&&!JSON.stringify(e).includes('private-secret'));assert.equal((await client.close()).status,'closed');}
});
test('malformedUTF8,scalarJSON and incomplete bodies cannot become a successful witness',async t=>{
 for(const mode of ['utf8','scalar','partial']){const {client}=await fixture(t,(_req,res)=>{if(mode==='utf8')res.end(Buffer.from([255]));else if(mode==='scalar')res.end('null');else{res.writeHead(200,{'content-length':'100'});res.write('{');setTimeout(()=>res.destroy(),5);}});await assert.rejects(client.daemon(),e=>e instanceof DockerMetadataError);assert.equal((await client.close()).activeRequests,0);}
});
test('the original operation deadline covers all three witnesses rather than restarting per request',async t=>{
 const {client}=await fixture(t,(req,res)=>{setTimeout(()=>send(res,req.url.endsWith('/info')?info:{Id:cid,Image:imageId,Name:'/fixture'}),35);},{timeoutMs:85});const start=performance.now();await assert.rejects(client.inspectContainer(cid),code('ENGINE_DEADLINE'));assert.ok(performance.now()-start<300);assert.equal((await client.close()).status,'closed');
});
test('abortbefore dispatch makes no request;inflight abort andclose reap their own sockets',async t=>{
 const {client,seen}=await fixture(t,()=>{}),controller=new AbortController();controller.abort(new Error('private reason'));await assert.rejects(client.daemon({signal:controller.signal}),code('ENGINE_ABORTED'));assert.equal(seen.length,0);const live=new AbortController(),pending=client.daemon({signal:live.signal});live.abort(new Error('private reason'));await assert.rejects(pending,e=>code('ENGINE_ABORTED')(e)&&!e.message.includes('private'));assert.equal((await client.close()).status,'closed');await assert.rejects(client.daemon(),code('ENGINE_CLIENT_CLOSED'));
});
test('one finite active request denies a concurrent read and no implicit retry is queued',async t=>{
 const {client,seen}=await fixture(t,()=>{},{maxConcurrent:1,timeoutMs:100});const first=client.daemon();await assert.rejects(client.daemon(),code('ENGINE_BUSY'));await assert.rejects(first,code('ENGINE_DEADLINE'));assert.equal(seen.length,1);assert.equal((await client.close()).activeRequests,0);
});
test('selectors and configuration reject unbounded paths,arbitrary endpoints and absent limits',async()=>{
 for(const value of [{socketPath:'relative',daemonId},{socketPath:'/tmp/f',daemonId,maxConcurrent:0},{socketPath:'/tmp/f',daemonId,timeoutMs:0},{socketPath:'/tmp/f',daemonId,maxResponseBytes:0}])assert.throws(()=>new DockerMetadataClient(value),TypeError);const client=new DockerMetadataClient({socketPath:'/tmp/nonexistent-rp-engine',daemonId});try{await assert.rejects(client.inspectContainer('../other'),TypeError);await assert.rejects(client.inspectImage('ubuntu:latest'),TypeError);await assert.rejects(client.daemon(),code('ENGINE_IO'));}finally{await client.close();}
});
