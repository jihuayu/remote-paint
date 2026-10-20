import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {DockerAttachClient,DockerAttachError} from '../service/docker-attach-client.mjs';
import {planDockerRuntime} from '../service/docker-runtime-spec.mjs';
import {SessionWorkerChannel} from '../service/session-worker-channel.mjs';
const daemonId='daemon-fixture',cid='e'.repeat(64),sessionId='ses_fixture',key='a'.repeat(64),request={url:'https://private.test/#fixture-owner-secret',region:'test',ttlSeconds:60};
const code=value=>e=>e instanceof DockerAttachError&&e.code===value;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=3000){const end=performance.now()+timeout;while(!check()){assert.ok(performance.now()<end,'Attach fixture deadline');await delay(5);}}
function frame(stream,value){const bytes=Buffer.from(value),header=Buffer.alloc(8);header[0]=stream;header.writeUInt32BE(bytes.length,4);return Buffer.concat([header,bytes]);}
const message=(type,rest={})=>JSON.stringify({protocol:'session-worker-v1',sessionId,type,...rest})+'\n';
const info={ID:daemonId,OSType:'linux',Architecture:'aarch64'};
function plan(){return planDockerRuntime({sessionId,tenantId:'tenant-a',region:'test',ownerKeyHash:'b'.repeat(64)},{deploymentId:'deployment-fixture',daemonId,imageId:'sha256:'+'c'.repeat(64),projectPath:'/fixture/project',browserPath:'/fixture/browser',projectManifestSha256:'d'.repeat(64),browserManifestSha256:'f'.repeat(64),imageEnvironment:['PATH=/usr/local/bin']});}
function document(p){const c=structuredClone(p.create);return {Id:cid,Name:'/'+p.containerName,Image:p.imageId,Config:c,HostConfig:c.HostConfig,Mounts:c.HostConfig.Mounts.map(m=>({Type:'bind',Source:m.Source,Destination:m.Target,RW:false,Propagation:'rprivate'})),State:{Status:'running',Running:true,Pid:123},NetworkSettings:{Ports:{}}};}
async function fixture(t,behavior={},options={}){
 const dir=await mkdtemp(join(tmpdir(),'rp-attach-')),socket=join(dir,'engine.sock'),p=plan(),seen=[],sockets=new Set(),received=[];let ids=0;
 const server=createServer((req,res)=>{seen.push({method:req.method,url:req.url,connection:req.socket.testId});if(behavior.get)return behavior.get(req,res,p);const value=req.url.endsWith('/info')?{...info,...behavior.info}:document(p);if(!req.url.endsWith('/info'))behavior.document?.(value);if(behavior.closeAfterInfo)res.setHeader('Connection','close');res.setHeader('content-type','application/json');res.end(JSON.stringify(value));});
 server.on('connection',s=>{s.testId=++ids;sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
 server.on('upgrade',(req,socket,head)=>{seen.push({method:req.method,url:req.url,connection:socket.testId,upgrade:req.headers.upgrade});if(behavior.upgrade)return behavior.upgrade(req,socket,head,p);socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n'),frame(1,message('WorkerHello'))]));let pending='';socket.on('data',b=>{pending+=b.toString();let n;while((n=pending.indexOf('\n'))>=0){const value=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);received.push(value);if(value.type==='Start')socket.write(frame(1,message('Ready',{version:'fake-engine-worker-v1'})));else if(value.type==='Close')socket.end(frame(1,message('Closed',{reason:'released',code:null})));}});});
 await new Promise(resolve=>server.listen(socket,resolve));const client=new DockerAttachClient({socketPath:socket,daemonId,connectTimeoutMs:2000,...options});t.after(async()=>{await client.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});return {client,p,seen,sockets,received,server};
}
function channel(proxy,options={}){return new SessionWorkerChannel({sessionId,region:'test',ownerKey:key,input:proxy.input,output:proxy.output,clientDone:proxy.clientDone,helloTimeoutMs:2500,readyTimeoutMs:2500,closeTimeoutMs:1500,heartbeatMs:25,...options});}

test('one actual socket binds info/inspection/upgrade and carries private channel Start/Ready/Close',async t=>{
 const f=await fixture(t),proxy=f.client.open({plan:f.p,containerId:cid}),worker=channel(proxy);try{assert.deepEqual(await worker.start(request),{version:'fake-engine-worker-v1'});const attached=await proxy.attached;assert.equal(attached.containerId,cid);assert.equal(f.seen.length,3);assert.equal(new Set(f.seen.map(x=>x.connection)).size,1);assert.ok(f.seen[2].url.includes('logs=1&stream=1&stdin=1&stdout=1&stderr=1'));assert.equal(f.seen[2].upgrade,'tcp');assert.equal(f.received[0].ownerKey,key);assert.equal(f.received[0].request.url,request.url);const report=await worker.close();assert.equal(report.workerClose,'confirmed');assert.deepEqual(report.transportExit,{code:0,signal:null});assert.deepEqual(await proxy.clientDone,report.transportExit);assert.equal(proxy.status().transportExited,true);assert.equal(f.client.status().activeProxies,0);assert.equal((await proxy.stop()).status,'closed');assert.equal(report.status,undefined);}catch(error){const before=proxy.status(),channelState=worker.status(),stopped=await proxy.stop();let attachCode=null;try{await proxy.attached;}catch(failure){attachCode=failure.code??null;}t.diagnostic(JSON.stringify({scope:'Finite actual attach failure diagnostics;no private request/key/metadata bodies',code:error.code??null,proxy:before,channel:channelState,attachCode,requests:f.seen.map(row=>({method:row.method,phase:row.url.endsWith('/info')?'info':row.url.includes('/attach?')?'upgrade':'inspection',connection:row.connection})),receivedTypes:f.received.map(row=>row.type),stopped}));throw error;}finally{await proxy.stop();await worker.close();}
});
test('wrong daemon/platform,foreign ownership,unsafe profile and nonrunning object reject before attach/private input',async t=>{
 for(const patch of [{info:{ID:'foreign'}},{info:{Architecture:'x86_64'}},{document:d=>d.Config.Labels['org.remote-paint.runtime.owner-hash']='0'.repeat(64)},{document:d=>d.HostConfig.PidMode='host'},{document:d=>d.HostConfig.LogConfig.Config['max-file']='9'},{document:d=>d.State={Status:'created',Running:false,Pid:0}}]){const f=await fixture(t,patch),p=f.client.open({plan:f.p,containerId:cid});await assert.rejects(p.attached,e=>e instanceof DockerAttachError);await p.clientDone;assert.ok(f.seen.every(x=>!x.url.includes('/attach?')));assert.equal(f.received.length,0);assert.equal(f.client.status().activeProxies,0);}
});
test('a server-closed checked connection is not replaced for inspection or attach',async t=>{
 const f=await fixture(t,{closeAfterInfo:true}),p=f.client.open({plan:f.p,containerId:cid});await assert.rejects(p.attached);await p.clientDone;assert.equal(f.seen.length,1);assert.equal(f.sockets.size,0);
});
test('non-upgrade responses and invalid upgrade headers close the actual proxy without leaking response content',async t=>{
 for(const response of ['HTTP/1.1 200 OK\r\nContent-Length: 14\r\n\r\nprivate-secret','HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n','HTTP/1.1 301 Moved\r\nLocation: http://private.invalid\r\nContent-Length: 0\r\n\r\n','HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: wrong\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n','HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: text/plain\r\n\r\n']){const f=await fixture(t,{upgrade:(_req,s)=>s.end(response)}),p=f.client.open({plan:f.p,containerId:cid});await assert.rejects(p.attached,e=>e instanceof DockerAttachError&&!JSON.stringify(e).includes('private'));await p.clientDone;assert.equal(f.seen.length,3);assert.equal(f.client.status().activeProxies,0);}
});
test('startup abort and capacity have no queue;capacity releases only after actual proxy close',async t=>{
 const f=await fixture(t,{get:()=>{}},{maxConcurrent:1}),controller=new AbortController(),p=f.client.open({plan:f.p,containerId:cid,signal:controller.signal});assert.throws(()=>f.client.open({plan:f.p,containerId:cid}),code('ATTACH_BUSY'));await until(()=>f.seen.length===1);controller.abort(Error('private abort reason'));await assert.rejects(p.attached,e=>code('ATTACH_ABORTED')(e)&&!JSON.stringify(e).includes('private'));await p.clientDone;assert.equal(f.client.status().activeProxies,0);assert.equal((await p.stop()).status,'closed');const never=new AbortController();never.abort();assert.throws(()=>f.client.open({plan:f.p,containerId:cid,signal:never.signal}),code('ATTACH_ABORTED'));
});
test('actual SIGKILL is observed as ChildProcess close and is not invented worker or runtime cleanup',async t=>{
 const f=await fixture(t),p=f.client.open({plan:f.p,containerId:cid}),worker=channel(p);try{await worker.start(request);await p.attached;process.kill(p.status().pid,'SIGKILL');const actual=await p.clientDone;assert.equal(actual.signal,'SIGKILL');assert.equal(actual.code,null);const report=await worker.close();assert.equal(report.workerClose,'unconfirmed');assert.equal(report.transportExit.signal,'SIGKILL');assert.equal(report.status,undefined);assert.equal(f.seen.length,3);}finally{await p.stop();await worker.close();}
});
test('bad configuration is rejected before child launch and a closed client cannot reopen',async t=>{
 for(const value of [{socketPath:'relative',daemonId},{socketPath:'/tmp/no',daemonId,maxConcurrent:0},{socketPath:'/tmp/no',daemonId,connectTimeoutMs:0}])assert.throws(()=>new DockerAttachClient(value),TypeError);const f=await fixture(t);for(const options of [{plan:f.p,containerId:'short'},{plan:{...f.p,daemonId:'foreign'},containerId:cid},{plan:{...f.p,extra:'owner-secret'},containerId:cid}])assert.throws(()=>f.client.open(options));assert.equal(f.client.status().activeProxies,0);assert.equal(f.seen.length,0);await f.client.close();assert.throws(()=>f.client.open({plan:f.p,containerId:cid}),code('ATTACH_CLIENT_CLOSED'));
});
const headers=Buffer.from('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n');
test('upgrade head and subsequent socket reads preserve split headers and stdout while stderr stays private',async t=>{
 const hello=frame(1,message('WorkerHello'));const f=await fixture(t,{upgrade:(_req,s)=>{s.write(Buffer.concat([headers,frame(2,'https://private.test/#owner-secret'),hello.subarray(0,5)]));setTimeout(()=>s.end(hello.subarray(5)),10);}}),p=f.client.open({plan:f.p,containerId:cid}),chunks=[];p.output.on('data',b=>chunks.push(b));await p.attached;assert.deepEqual(await p.clientDone,{code:0,signal:null});assert.equal(Buffer.concat(chunks).toString(),message('WorkerHello'));assert.equal(p.status().diagnosticBytes,0);assert.ok(!JSON.stringify(p.status()).includes('owner-secret'));
});
test('malformed,truncated and oversized multiplex frames never forward partial protocol bytes',async t=>{
 const bad=[];const unknown=frame(1,'private-secret');unknown[0]=0;bad.push(unknown,frame(1,'Ready\n').subarray(0,10));const huge=Buffer.alloc(8);huge[0]=1;huge.writeUInt32BE(65537,4);bad.push(huge);
 for(const wire of bad){const f=await fixture(t,{upgrade:(_req,s)=>s.end(Buffer.concat([headers,wire]))}),p=f.client.open({plan:f.p,containerId:cid});let bytes=0;p.output.on('data',b=>bytes+=b.length);await p.attached;assert.equal((await p.clientDone).code,1);assert.equal(bytes,0);assert.equal(p.status().diagnosticBytes,0);}
});
test('finite stderr lifetime consumption stops the proxy and never forwards secret bytes',async t=>{
 const f=await fixture(t,{upgrade:(_req,s)=>s.end(Buffer.concat([headers,frame(2,'private-secret'.repeat(200))]))},{maxStderrBytes:1024}),p=f.client.open({plan:f.p,containerId:cid});let bytes=0;p.output.on('data',b=>bytes+=b.length);await p.attached;assert.equal((await p.clientDone).code,1);assert.equal(bytes,0);assert.equal(p.status().diagnosticBytes,0);
});
test('oversized and incomplete private input lines are not partially sent to the checked container',async t=>{
 for(const bytes of [Buffer.from('x'.repeat(32769)+'\n'),Buffer.from('private-incomplete')]){let received=0;const f=await fixture(t,{upgrade:(_req,s)=>{s.write(headers);s.on('data',b=>received+=b.length);}}),p=f.client.open({plan:f.p,containerId:cid});await p.attached;p.input.end(bytes);assert.equal((await p.clientDone).code,1);assert.equal(received,0);}
});
test('a complete maximum input line transfers intact before the raw response closes',async t=>{
 const expected=Buffer.from('x'.repeat(32768)+'\n'),chunks=[];let received=0;const f=await fixture(t,{upgrade:(_req,s)=>{s.write(headers);s.on('data',b=>{chunks.push(b);received+=b.length;if(received===expected.length)s.end();});}}),p=f.client.open({plan:f.p,containerId:cid});await p.attached;p.input.end(expected);assert.deepEqual(await p.clientDone,{code:0,signal:null});assert.deepEqual(Buffer.concat(chunks),expected);
});
test('input EOF has a finite response-drain deadline when the peer remains half-open',async t=>{
 const f=await fixture(t,{upgrade:(_req,s)=>{s.allowHalfOpen=true;s.on('end',()=>{});s.resume();s.write(headers);}},{eofTimeoutMs:80}),p=f.client.open({plan:f.p,containerId:cid});await p.attached;const began=performance.now();p.input.end();assert.equal((await p.clientDone).code,1);assert.ok(performance.now()-began<1000);assert.equal(f.client.status().activeProxies,0);
});
test('the original startup deadline includes info,inspection and a stalled upgrade without a reset',async t=>{
 const f=await fixture(t,{get:(req,res,p)=>{setTimeout(()=>res.end(JSON.stringify(req.url.endsWith('/info')?info:document(p))),350);},upgrade:()=>{}},{connectTimeoutMs:1000}),began=performance.now(),p=f.client.open({plan:f.p,containerId:cid});await assert.rejects(p.attached,code('ATTACH_DEADLINE'));await p.clientDone;assert.equal(f.seen.length,3);assert.ok(performance.now()-began<1600);assert.equal(f.client.status().activeProxies,0);
});
test('oversized,malformed and incomplete Engine metadata rejects before upgrade without response body exposure',async t=>{
 for(const mode of ['declared','stream','utf8','truncated']){const f=await fixture(t,{get:(_req,res)=>{if(mode==='declared'){res.writeHead(200,{'content-length':'999999'});res.end('private-secret');}else if(mode==='stream')res.end('private-secret'.repeat(12000));else if(mode==='utf8')res.end(Buffer.from([255]));else{res.writeHead(200,{'content-length':'100'});res.write('{');setTimeout(()=>res.destroy(),5);}}}),p=f.client.open({plan:f.p,containerId:cid});await assert.rejects(p.attached,e=>e instanceof DockerAttachError&&!JSON.stringify(e).includes('private'));await p.clientDone;assert.equal(f.seen.length,1);}
});
test('owner abort after attachment closes the real proxy and fences the available channel',async t=>{
 let unavailable=0;const f=await fixture(t),controller=new AbortController(),p=f.client.open({plan:f.p,containerId:cid,signal:controller.signal}),worker=channel(p,{onUnavailable:()=>unavailable++});try{await worker.start(request);await p.attached;controller.abort();await p.clientDone;assert.equal(worker.status().available,false);assert.equal(unavailable,1);assert.equal((await worker.close()).workerClose,'unconfirmed');assert.equal(p.status().failure,'ATTACH_ABORTED');}finally{await p.stop();await worker.close();}
});
async function bulk(t){let sent=0;const packet=frame(1,Buffer.alloc(16384,82)),total=8*1048576;const f=await fixture(t,{upgrade:(_req,s)=>{s.write(headers);void(async()=>{while(sent<total){const accepted=s.write(packet);sent+=16384;if(!accepted)await once(s,'drain');}s.end();})().catch(()=>{});}}),p=f.client.open({plan:f.p,containerId:cid});await p.attached;return {f,p,total,sent:()=>sent};}
test('slow downstream consumption applies actual pipe/socket backpressure with no unbounded output queue',async t=>{
 const {p,total,sent}=await bulk(t);await delay(80);assert.ok(sent()<total);assert.equal(p.status().transportExited,false);let received=0;p.output.on('data',b=>received+=b.length);assert.deepEqual(await p.clientDone,{code:0,signal:null});assert.equal(received,total);
});
test('stop reaps an actual proxy blocked on unread stdout within its fixed termination budget',async t=>{
 const {p,f,total,sent}=await bulk(t);await delay(50);assert.ok(sent()<total);const began=performance.now(),stopped=p.stop();assert.equal(p.stop(),stopped);const report=await stopped;assert.equal(report.status,'closed');assert.ok(performance.now()-began<900);assert.deepEqual(await p.clientDone,report.transportExit);assert.equal(f.client.status().activeProxies,0);assert.equal(report.scope.includes('not worker or runtime retirement'),true);
});
test('host Node options and unrelated inherited secrets never enter the proxy process environment',async t=>{
 const saved=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--invalid-private-fixture-option';try{const f=await fixture(t),p=f.client.open({plan:f.p,containerId:cid}),worker=channel(p);try{assert.equal((await worker.start(request)).version,'fake-engine-worker-v1');await p.attached;assert.equal((await worker.close()).workerClose,'confirmed');}finally{await p.stop();await worker.close();}}finally{if(saved===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=saved;}
});
