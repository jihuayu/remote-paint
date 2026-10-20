import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockerEffectClient,DockerEffectError} from '../service/docker-effect-session.mjs';
import {planDockerRuntime} from '../service/docker-runtime-spec.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {records} from './fixtures/session-store-records.mjs';
const daemonId='daemon-fixture',cid='e'.repeat(64),info={ID:daemonId,OSType:'linux',Architecture:'aarch64'};
const code=value=>e=>e instanceof DockerEffectError&&e.code===value;
const send=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(status===204?'':JSON.stringify(data));};
function plan(){return planDockerRuntime({sessionId:'ses_a',tenantId:'tenant-a',region:'test',ownerKeyHash:'a'.repeat(64)},{deploymentId:'deployment-fixture',daemonId,imageId:'sha256:'+'b'.repeat(64),projectPath:'/fixture/project',browserPath:'/fixture/browser',projectManifestSha256:'c'.repeat(64),browserManifestSha256:'d'.repeat(64),imageEnvironment:['PATH=/usr/local/bin']});}
function document(p){const c=structuredClone(p.create);return {Id:cid,Name:'/'+p.containerName,Image:p.imageId,Config:c,HostConfig:c.HostConfig,Mounts:c.HostConfig.Mounts.map(m=>({Type:'bind',Source:m.Source,Destination:m.Target,RW:false,Propagation:'rprivate'})),State:{Status:'created',Running:false,Pid:0},NetworkSettings:{Ports:{}}};}
function allocation(p,kind='create'){return {sessionId:p.sessionId,tenant:p.tenantId,region:p.region,deploymentId:p.deploymentId,daemonId:p.daemonId,ownerKeyHash:p.ownerKeyHash,specDigest:p.specDigest,imageId:p.imageId,containerName:p.containerName,containerId:kind==='create'?null:cid,state:{create:'requested',start:'created',remove:'closing'}[kind],requestStarted:true,startDispatch:kind==='start'?'requested':'not-requested',version:null};}
const ack=(p,kind='create')=>({revision:3,allocation:allocation(p,kind)});
async function fixture(t,handler,options={}){
 const dir=await mkdtemp(join(tmpdir(),'rp-effect-')),socket=join(dir,'engine.sock'),seen=[],sockets=new Set(),p=plan();let n=0;
 const server=createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const raw=Buffer.concat(chunks).toString('utf8');seen.push({method:req.method,url:req.url,connection:req.socket.testId,body:raw?JSON.parse(raw):null});try{await handler(req,res,seen,p);}catch(e){res.destroy(e);}});
 server.on('connection',s=>{s.testId=++n;sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(socket,resolve));
 const client=new DockerEffectClient({socketPath:socket,daemonId,...options});t.after(async()=>{await client.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});return {client,seen,server,sockets,p,dir,socket};
}
function normal(req,res,_seen,p){if(req.url.endsWith('/info'))send(res,info);else if(req.method==='GET')send(res,document(p));else if(req.url.includes('/create?'))send(res,{Id:cid,Warnings:[]},201);else send(res,null,204);}
const mutations=seen=>seen.filter(x=>x.method!=='GET');
test('create/start/remove use the same identity-checked connection and expose no raw HTTP or mutable internals',async t=>{
 const f=await fixture(t,normal);
 for(const kind of ['create','start','remove']){const s=await f.client.open({kind,plan:f.p,...(kind==='create'?{}:{containerId:cid})});assert.ok(Object.isFrozen(s));assert.deepEqual(Object.keys(s).sort(),['close','connectionId','inspect','kind','perform'].sort());assert.equal(s.json,undefined);assert.equal(s.agent,undefined);const before=f.seen.length;assert.equal(mutations(f.seen).length,['create','start','remove'].indexOf(kind));const a=s.inspect();if(a.inspection)a.inspection.document.HostConfig.Privileged=true;const r=await s.perform(()=>ack(f.p,kind));assert.equal(r.containerId,cid);assert.equal(r.authorizationRevision,3);assert.equal(r.effectAttempted,true);assert.equal(r.alreadyAbsent,false);assert.equal(f.seen.length,before+1);const operation=f.seen.slice(kind==='create'?before-1:before-2);assert.equal(new Set(operation.map(x=>x.connection)).size,1);await assert.rejects(s.perform(()=>ack(f.p,kind)),code('EFFECT_ALREADY_ATTEMPTED'));assert.equal((await s.close()).status,'closed');}
 assert.ok(Object.isFrozen(f.client));assert.equal(f.client.socketPath,undefined);assert.equal(f.client.status().activeSessions,0);assert.deepEqual(mutations(f.seen).map(x=>x.method),['POST','POST','DELETE']);assert.deepEqual(mutations(f.seen)[0].body,f.p.create);
});
test('actual synchronous SQLite dispatch acknowledgment is durable before the first create byte', {skip:!sessionStoreSupported},async t=>{
 let durable=false,store,owner;const f=await fixture(t,(req,res,seen,p)=>{if(req.method==='POST'){const row=store.loadRuntime({owner}).allocations[0];assert.equal(row.state,'requested');assert.equal(row.requestStarted,true);assert.equal(durable,true);}normal(req,res,seen,p);});
 store=new SqliteSessionStore({path:join(f.dir,'journal.sqlite')});owner=Symbol('fixture');const at='2026-10-18T00:00:00.000Z';store.claimRuntimeProvider(owner,{region:'test',deploymentId:f.p.deploymentId,daemonId,createdAt:at});store.commit(records());let row={...allocation(f.p),state:'intent',requestStarted:false,closeReason:null,retirement:null,createdAt:at,updatedAt:at};store.commitRuntime(row,{owner});
 try{const s=await f.client.open({kind:'create',plan:f.p});const result=await s.perform(()=>{row={...row,state:'requested',requestStarted:true};const receipt=store.commitRuntime(row,{owner});durable=true;return receipt;});assert.equal(result.authorizationRevision,3);await s.close();}finally{store.releaseRuntimeProvider(owner);store.close();}
});
test('missing,throwing,async,wrong-state and wrong-identity acknowledgments never dispatch and consume the session once',async t=>{
 const f=await fixture(t,normal);const callbacks=[undefined,()=>{throw Error('private-secret');},async()=>ack(f.p),()=>({revision:0,allocation:allocation(f.p)}),()=>({...ack(f.p),allocation:{...allocation(f.p),requestStarted:1}}),()=>({...ack(f.p),allocation:{...allocation(f.p),state:'intent'}}),()=>({...ack(f.p),allocation:{...allocation(f.p),tenant:'foreign'}})];
 for(const callback of callbacks){const s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(callback),e=>e instanceof DockerEffectError&&!JSON.stringify(e).includes('private-secret'));await assert.rejects(s.perform(()=>ack(f.p)),code('EFFECT_ALREADY_ATTEMPTED'));await s.close();}assert.equal(mutations(f.seen).length,0);
});
test('mutating caller plan or an inspection copy cannot weaken authorization or change the posted fixed profile',async t=>{
 const f=await fixture(t,normal),p=structuredClone(f.p),s=await f.client.open({kind:'create',plan:p});p.create.HostConfig.Privileged=true;p.containerName='foreign';await s.perform(()=>ack(f.p));assert.deepEqual(mutations(f.seen)[0].body,f.p.create);await s.close();
});
test('a connection closed after info is never reconnected or sent to another daemon',async t=>{
 const f=await fixture(t,(_req,res)=>{res.setHeader('Connection','close');send(res,info);});const s=await f.client.open({kind:'create',plan:f.p});await new Promise(resolve=>setTimeout(resolve,10));await assert.rejects(s.perform(()=>ack(f.p)),e=>e instanceof DockerEffectError&&e.uncertain===true);await s.close();assert.equal(f.seen.length,1);assert.equal(mutations(f.seen).length,0);
});
test('wrong daemon/platform and foreign ownership reject before mutation',async t=>{
 for(const mode of ['daemon','platform','owner']){const f=await fixture(t,(req,res,_seen,p)=>{if(req.url.endsWith('/info'))send(res,{...info,...(mode==='daemon'?{ID:'foreign'}:mode==='platform'?{Architecture:'x86_64'}:{})});else{const d=document(p);d.Config.Labels['org.remote-paint.runtime.owner-hash']='f'.repeat(64);send(res,d);}});await assert.rejects(f.client.open({kind:'start',plan:f.p,containerId:cid}));assert.equal(mutations(f.seen).length,0);assert.equal(f.client.status().activeSessions,0);}
});
test('unsafe owned isolation and already-running state deny Start; ownership alone still permits exact-ID removal',async t=>{
 for(const mode of ['hostpid','running']){const f=await fixture(t,(req,res,seen,p)=>{if(req.method!=='GET')return normal(req,res,seen,p);if(req.url.endsWith('/info'))return send(res,info);const d=document(p);if(mode==='hostpid')d.HostConfig.PidMode='host';else d.State={Status:'running',Running:true,Pid:23};send(res,d);});await assert.rejects(f.client.open({kind:'start',plan:f.p,containerId:cid}));const remove=await f.client.open({kind:'remove',plan:f.p,containerId:cid});if(mode==='hostpid')assert.equal(remove.inspect().profile,null);await remove.perform(()=>ack(f.p,'remove'));await remove.close();assert.equal(mutations(f.seen).length,1);assert.ok(mutations(f.seen)[0].url.includes(cid));}
});
test('known-ID absence can skip Delete but is explicitly not retirement proof; absent Start rejects',async t=>{
 const f=await fixture(t,(req,res)=>send(res,req.url.endsWith('/info')?info:{message:'absent'},req.url.endsWith('/info')?200:404));await assert.rejects(f.client.open({kind:'start',plan:f.p,containerId:cid}),code('EFFECT_OBJECT_ABSENT'));const s=await f.client.open({kind:'remove',plan:f.p,containerId:cid}),r=await s.perform(()=>ack(f.p,'remove'));assert.equal(r.alreadyAbsent,true);assert.equal(r.effectAttempted,false);assert.equal(r.httpStatus,404);assert.ok(r.scope.includes('not worker readiness or namespace retirement proof'));assert.equal(mutations(f.seen).length,0);await s.close();
});
test('lost create reply is uncertain and one-use; no automatic retries or fabricated container ID',async t=>{
 const f=await fixture(t,(req,res)=>{if(req.method==='GET')send(res,info);else res.destroy();});const s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>ack(f.p)),e=>code('EFFECT_IO')(e)&&e.uncertain);await assert.rejects(s.perform(()=>ack(f.p)),code('EFFECT_ALREADY_ATTEMPTED'));assert.equal(mutations(f.seen).length,1);assert.equal((await s.close()).status,'closed');
});
test('redirects,403 and unexpected304 replies never authorize a second request or leak private response bodies',async t=>{
 for(const status of [301,403,304,500]){const f=await fixture(t,(req,res)=>{if(req.method==='GET')send(res,info);else{res.writeHead(status,{Location:'http://private.invalid'});res.end('private-secret');}});const s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>ack(f.p)),e=>code('EFFECT_HTTP')(e)&&e.status===status&&e.uncertain&&!JSON.stringify(e).includes('private-secret'));assert.equal(mutations(f.seen).length,1);await s.close();}
});
test('malformed,oversized,truncated and warning-bearing mutation replies remain uncertain',async t=>{
 for(const mode of ['utf8','scalar','declared','stream','partial','id','warning']){const f=await fixture(t,(req,res)=>{if(req.method==='GET')return send(res,info);if(mode==='utf8'){res.writeHead(201);res.end(Buffer.from([255]));}else if(mode==='scalar'){res.writeHead(201);res.end('7');}else if(mode==='declared'){res.writeHead(201,{'content-length':'99999'});res.end('private-secret');}else if(mode==='stream'){res.writeHead(201);res.end('private-secret'.repeat(100));}else if(mode==='partial'){res.writeHead(201,{'content-length':'100'});res.write('{');setTimeout(()=>res.destroy(),5);}else send(res,mode==='id'?{Id:'short'}:{Id:cid,Warnings:['private-secret']},201);},{maxResponseBytes:1024});const s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>ack(f.p)),e=>e instanceof DockerEffectError&&e.uncertain&&!JSON.stringify(e).includes('private-secret'));assert.equal(mutations(f.seen).length,1);await s.close();}
});
test('request byte cap rejects the profile before any mutation byte',async t=>{
 const f=await fixture(t,normal,{maxRequestBytes:1024}),s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>ack(f.p)),e=>code('EFFECT_REQUEST_LIMIT')(e)&&!e.uncertain);assert.equal(mutations(f.seen).length,0);await s.close();
});
test('one original deadline covers info,inspection and Start together',async t=>{
 const f=await fixture(t,(req,res,seen,p)=>{setTimeout(()=>normal(req,res,seen,p),30);},{timeoutMs:80});const start=performance.now(),s=await f.client.open({kind:'start',plan:f.p,containerId:cid});await assert.rejects(s.perform(()=>ack(f.p,'start')),e=>code('EFFECT_DEADLINE')(e)&&e.uncertain);assert.ok(performance.now()-start<350);assert.equal((await s.close()).status,'closed');
});
test('idle sessions expire and release capacity without dispatch or an explicit caller close',async t=>{
 const f=await fixture(t,normal,{timeoutMs:60,maxConcurrent:1}),s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(f.client.open({kind:'create',plan:f.p}),code('EFFECT_BUSY'));await new Promise(resolve=>setTimeout(resolve,90));assert.equal(f.client.status().activeSessions,0);await assert.rejects(s.perform(()=>ack(f.p)),code('EFFECT_DEADLINE'));assert.equal(mutations(f.seen).length,0);
});
test('abortbefore open makes no request; inflight abort and client close reap only owned sockets',async t=>{
 const f=await fixture(t,()=>{}),aborted=new AbortController();aborted.abort(Error('private-secret'));await assert.rejects(f.client.open({kind:'create',plan:f.p,signal:aborted.signal}),code('EFFECT_ABORTED'));assert.equal(f.seen.length,0);const signal=new AbortController(),pending=f.client.open({kind:'create',plan:f.p,signal:signal.signal});signal.abort(Error('private-secret'));await assert.rejects(pending,e=>code('EFFECT_ABORTED')(e)&&!JSON.stringify(e).includes('private-secret'));assert.equal((await f.client.close()).status,'closed');await assert.rejects(f.client.open({kind:'create',plan:f.p}),code('EFFECT_CLIENT_CLOSED'));
});
test('close or expiration inside the authorization callback prevents dispatch after the durable receipt',async t=>{
 const f=await fixture(t,normal),s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>{void s.close();return ack(f.p);}),code('EFFECT_SESSION_CLOSED'));assert.equal(mutations(f.seen).length,0);
});
test('concurrency cap has no implicit queue; malformed identities,plans and limits never reach the Engine',async t=>{
 const f=await fixture(t,()=>{}, {maxConcurrent:1,timeoutMs:60}),pending=f.client.open({kind:'create',plan:f.p});await assert.rejects(f.client.open({kind:'create',plan:f.p}),code('EFFECT_BUSY'));await assert.rejects(pending,code('EFFECT_DEADLINE'));assert.equal(f.seen.length,1);assert.equal(f.client.status().activeSessions,0);
 for(const config of [{socketPath:'relative',daemonId},{socketPath:'/tmp/no',daemonId,maxConcurrent:0},{socketPath:'/tmp/no',daemonId,timeoutMs:0}])assert.throws(()=>new DockerEffectClient(config),TypeError);
 const g=await fixture(t,normal);for(const options of [{kind:'exec',plan:g.p},{kind:'create',plan:g.p,containerId:cid},{kind:'start',plan:g.p,containerId:'short'},{kind:'create',plan:{...g.p,daemonId:'other'}}])await assert.rejects(g.client.open(options));assert.equal(g.seen.length,0);
});
test('every immutable ledger identity and exact Start/Remove state is checked before dispatch',async t=>{
 const f=await fixture(t,normal);
 for(const key of ['sessionId','tenant','region','deploymentId','daemonId','ownerKeyHash','specDigest','imageId','containerName']){const s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>({revision:3,allocation:{...allocation(f.p),[key]:'foreign'}})),code('EFFECT_AUTHORIZATION'));await s.close();}
 for(const kind of ['start','remove'])for(const patch of [{containerId:'f'.repeat(64)},{state:'ready'},...(kind==='start'?[{version:'old-ready'}]:[])]){const s=await f.client.open({kind,plan:f.p,containerId:cid});await assert.rejects(s.perform(()=>({revision:4,allocation:{...allocation(f.p,kind),...patch}})),code('EFFECT_AUTHORIZATION'));await s.close();}assert.equal(mutations(f.seen).length,0);
});
test('mutation abort and client close remain uncertain and close actual owned sockets',async t=>{
 for(const mode of ['abort','close']){let dispatch;const sent=new Promise(resolve=>dispatch=resolve),f=await fixture(t,(req,res)=>{if(req.method==='GET')send(res,info);else dispatch();}),controller=new AbortController(),s=await f.client.open({kind:'create',plan:f.p,signal:controller.signal}),pending=s.perform(()=>ack(f.p));await sent;if(mode==='abort')controller.abort(Error('private-secret'));else void f.client.close();await assert.rejects(pending,e=>e instanceof DockerEffectError&&e.uncertain&&!JSON.stringify(e).includes('private-secret'));assert.equal((await s.close()).status,'closed');assert.equal(f.client.status().activeSessions,0);assert.equal(mutations(f.seen).length,1);}
});
test('synchronous authorization cannot extend the deadline or send after it expires',async t=>{
 const f=await fixture(t,normal,{timeoutMs:40}),s=await f.client.open({kind:'create',plan:f.p});await assert.rejects(s.perform(()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return ack(f.p);}),e=>code('EFFECT_DEADLINE')(e)&&e.uncertain===false);await s.close();assert.equal(mutations(f.seen).length,0);
});

test('an early lease or request timer callback rechecks the same absolute deadline before expiring',async t=>{
 const original=setTimeout;for(const forcedTimer of [1,2]){const f=await fixture(t,(req,res,seen,p)=>{original(()=>normal(req,res,seen,p),5);});let scheduled=0,forced=0;const mock=t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{if(++scheduled===forcedTimer){forced++;return original(callback,0,...args);}return original(callback,ms,...args);});try{const s=await f.client.open({kind:'create',plan:f.p});assert.equal(forced,1);assert.equal((await s.perform(()=>ack(f.p))).httpStatus,201);assert.equal((await s.close()).status,'closed');assert.equal(mutations(f.seen).length,1);}finally{mock.mock.restore();}}
});

test('Engine Start rejects missing,never-requested or migrated-unknown durable fences before sending HTTP',async t=>{
 const f=await fixture(t,normal);
 for(const value of [undefined,'not-requested','legacy-unknown']){
  const session=await f.client.open({kind:'start',plan:f.p,containerId:cid});
  await assert.rejects(session.perform(()=>{const receipt=ack(f.p,'start');if(value===undefined)delete receipt.allocation.startDispatch;else receipt.allocation.startDispatch=value;return receipt;}),code('EFFECT_AUTHORIZATION'));
  assert.equal((await session.close()).status,'closed');
 }
 assert.equal(mutations(f.seen).length,0);
});
