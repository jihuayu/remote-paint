import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:https';
import {connect as tlsConnect,Server as TlsServer} from 'node:tls';
import {connect as tcpConnect} from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createAgentWebhookInbox} from '../service/agent-webhook-inbox.mjs';
import {createAgentWebhookReceiver} from '../service/agent-webhook-receiver.mjs';
import {createAgentWebhookAuthenticator} from '../service/agent-webhook-auth.mjs';
import {createAgentWebhookDispatcher} from '../service/agent-webhook-dispatcher.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {readyRecords,activate,uuid} from './fixtures/session-agent-records.mjs';
import {cert,secret,endpointId,authConfig,digest} from './fixtures/agent-webhook-https.mjs';
import {until} from './fixtures/agent-executor-fixture.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=c=>({code:'AGENT_WEBHOOK_RECEIVER_'+c}),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),key=readFileSync(new URL('./fixtures/webhook-localhost-key.pem',import.meta.url));
const value=(n=1)=>({schema:'agent-webhook-v1',endpointId,subscriptionId:'awsub_'+uuid(1),event:{schema:'agent-event-v1',eventId:'aevt_'+uuid(n),agentRunId:'arun_'+uuid(1),sessionId:'ses_'+uuid(1),region:'test',version:'v1',sequence:n,observedAt:'2026-10-21T07:00:00.000Z',type:'run.updated',data:{state:'active',holdsWriter:true,beginDispatch:'confirmed',endDispatch:'not-requested',error:null,closeEvidenceKind:null,stateUpdatedAt:'2026-10-21T07:00:00.000Z'}}});
function signed(v=value()){const auth=createAgentWebhookAuthenticator(authConfig);try{const result=auth.sign({eventId:v.event.eventId,body:Buffer.from(JSON.stringify(v))});return {body:result.body,headers:{...result.headers}};}finally{auth.close();}}
async function fixture(t,opts={}){const root=await mkdtemp(join(tmpdir(),'remote-paint-receiver-')),cfg={directory:join(root,'inbox'),tenantId:'tenant-a',...authConfig,key,cert,...opts},receiver=createAgentWebhookReceiver(cfg);t.after(async()=>{await receiver.close({signal:AbortSignal.timeout(3000)});await rm(root,{recursive:true,force:true});});const address=await receiver.listen();return {root,cfg,receiver,address,url:'https://127.0.0.1:'+address.port+address.path};}
function send(url,{body,headers},extra={}){return new Promise((resolve,reject)=>{const req=request(url,{method:'POST',agent:false,ca:cert,headers:{...headers,'content-length':String(body.length),...extra.headers},...Object.fromEntries(Object.entries(extra).filter(([k])=>k!=='headers'))},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end(body);});}
async function raw(t,address,text,{write=true,tls=true}={}){
 const socket=tls?tlsConnect({host:'127.0.0.1',port:address.port,ca:cert,ALPNProtocols:['http/1.1']}):tcpConnect({host:'127.0.0.1',port:address.port});socket.on('error',()=>{});t.after(()=>socket.destroy());let response='';const closed=new Promise(resolve=>socket.once('close',resolve));socket.on('data',b=>response+=b.toString('utf8'));await once(socket,tls?'secureConnect':'connect',{signal:AbortSignal.timeout(3000)});if(write)socket.write(text);return {socket,closed,response:()=>response};
}
function frame(address,row,{method='POST',path=address.path,headers=[],length=row.body.length,body=row.body}={}){return Buffer.concat([Buffer.from(method+' '+path+' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: '+length+'\r\nRemote-Paint-Event-Id: '+row.headers['remote-paint-event-id']+'\r\nRemote-Paint-Signature: '+row.headers['remote-paint-signature']+'\r\n'+headers.map(x=>x+'\r\n').join('')+'\r\n'),body]);}

test('owned production HTTPS receiver authenticates real bytes and acknowledges durable acceptance plus restart dedup',enabled,async t=>{
 const f=await fixture(t),row=signed(),id=f.receiver.identity(),a=await send(f.url,row);assert.equal(a.status,202);assert.deepEqual(JSON.parse(a.text),{schema:'agent-webhook-ack-v1',eventId:value().event.eventId,bodySha256:digest(row.body)});assert.equal(a.headers.connection,'close');assert.equal(f.receiver.read().events.length,1);await f.receiver.close();const next=createAgentWebhookReceiver(f.cfg);t.after(()=>next.close());assert.deepEqual(next.identity(),id);const address=await next.listen(),b=await send('https://127.0.0.1:'+address.port+address.path,signed());assert.equal(b.status,200);assert.equal(b.text,a.text);assert.equal(next.read().events.length,1);
});
test('actual dispatcher delivers its original Source capture through production receiver without releasing the Source writer',enabled,async t=>{
 const f=await fixture(t),owner=Symbol(),store=new SqliteSessionStore({path:join(f.root,'source.sqlite'),enableAgentWebhooks:true});store.commit(readyRecords());store.claimAgentController(owner);const run=activate(store,owner),worker=createAgentWebhookDispatcher({...authConfig,store,owner,tenantId:'tenant-a',url:f.url,ca:cert,retryBaseMs:10});try{const sub=worker.subscribe({agentRunId:run.agentRunId,after:0}),head=worker.read(sub.subscriptionId).deliveries[0],result=await worker.deliver(sub.subscriptionId);assert.equal(result.status,'accepted');assert.equal(result.attempts,1);assert.equal(f.receiver.read().events[0].bodySha256,head.bodySha256);assert.equal(store.findAgentWriter(run.sessionId,{owner}).reserved,true);}finally{await worker.close();store.releaseAgentController(owner);store.close();}
});
test('completed HTTPS response retires owned transport records before exact inbox ownership can be reacquired',enabled,async t=>{
 const f=await fixture(t,{maxConnections:1});await send(f.url,signed());await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.status().requests,0);assert.equal(f.receiver.read().events.length,1);await f.receiver.close();assert.equal(f.receiver.status().state,'closed');assert.equal(f.receiver.status().connections,0);
});
test('HTTPS receiver returns bounded non-sensitive authentication and metadata errors without storing unauthenticated work',enabled,async t=>{
 const f=await fixture(t),row=signed();row.headers['remote-paint-signature']='private secret';let result=await send(f.url,row);assert.equal(result.status,401);assert.ok(!result.text.includes('private'));const v=value();v.event.data.action={text:'private'};result=await send(f.url,signed(v));assert.equal(result.status,400);assert.ok(!result.text.includes('private'));assert.equal(f.receiver.read().events.length,0);
});
test('production receiver maps durable conflict and capacity to finite failed responses while duplicates stay accepted',enabled,async t=>{
 const f=await fixture(t,{maxEvents:1});assert.equal((await send(f.url,signed())).status,202);const v=value();v.event.version='other';assert.equal((await send(f.url,signed(v))).status,409);assert.equal((await send(f.url,signed(value(2)))).status,503);assert.equal((await send(f.url,signed())).status,200);assert.equal(f.receiver.read().events.length,1);
});
test('only exact configured HTTPS path and POST method can enter the durable inbox',enabled,async t=>{
 const f=await fixture(t);for(const path of [f.address.path+'?private=1',f.address.path+'/',f.address.path.replace('webhooks','web%68ooks')])assert.equal((await send('https://127.0.0.1:'+f.address.port+path,signed())).status,404);const result=await send(f.url,signed(),{method:'PUT'});assert.equal(result.status,405);assert.equal(result.headers.allow,'POST');assert.equal(f.receiver.read().events.length,0);
});
test('content type and declared body length bounds reject oversized allocation before inbox acceptance',enabled,async t=>{
 const f=await fixture(t);assert.equal((await send(f.url,signed(),{headers:{'content-type':'text/plain'}})).status,415);
 const a=await raw(t,f.address,frame(f.address,signed(),{length:4097,body:Buffer.alloc(0)}));await a.closed;assert.match(a.response(),/^HTTP\/1.1 413/);assert.equal(f.receiver.read().events.length,0);
});
test('missing Content-Length and chunked bodies never become ambiguous accepted envelopes',enabled,async t=>{
 const f=await fixture(t);for(const suffix of ['', 'Transfer-Encoding: chunked\r\n']){const row=signed(),text='POST '+f.address.path+' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nRemote-Paint-Event-Id: '+row.headers['remote-paint-event-id']+'\r\nRemote-Paint-Signature: '+row.headers['remote-paint-signature']+'\r\n'+suffix+'\r\n';const client=await raw(t,f.address,text);await client.closed;assert.match(client.response(),/^HTTP\/1.1 (400|411)/);}assert.equal(f.receiver.read().events.length,0);
});
test('duplicate signature content-type or custom headers are rejected instead of folded into authenticated input',enabled,async t=>{
 const f=await fixture(t);for(const headers of [['Remote-Paint-Signature: private'],['Content-Type: application/json'],['X-Private: one','x-private: two']]){const c=await raw(t,f.address,frame(f.address,signed(),{headers}));await c.closed;assert.match(c.response(),/^HTTP\/1.1 400/);}assert.equal(f.receiver.read().events.length,0);
});
test('actual HTTP header byte and count limits reject hidden fields before parsing an accepted body',enabled,async t=>{
 const f=await fixture(t);for(const headers of [['X-Large: '+'x'.repeat(8192)],Array.from({length:12},(_,i)=>'X-Extra-'+i+': v')]){const c=await raw(t,f.address,frame(f.address,signed(),{headers}));await c.closed;assert.ok(!/^HTTP\/1.1 20[02]/.test(c.response()));}assert.equal(f.receiver.read().events.length,0);
});
test('Expect continue and unsupported expectations never allocate or acknowledge a request body',enabled,async t=>{
 const f=await fixture(t);for(const expectation of ['100-continue','private']){const c=await raw(t,f.address,frame(f.address,signed(),{headers:['Expect: '+expectation],body:Buffer.alloc(0)}));await c.closed;assert.match(c.response(),/^HTTP\/1.1 417/);assert.ok(!c.response().includes('100 Continue'));}assert.equal(f.receiver.read().events.length,0);
});
test('HTTP upgrade and CONNECT cannot escape receiver-owned socket shutdown',enabled,async t=>{
 const f=await fixture(t);for(const request of ['GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n','CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\n\r\n']){const c=await raw(t,f.address,request);await c.closed;assert.ok(!c.response().includes(' 200 '));}await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);
});
test('pipelined second signed event cannot reuse a connection or enter the inbox behind its original request',enabled,async t=>{
 const f=await fixture(t),row=signed(),a=frame(f.address,row),b=frame(f.address,signed(value(2)));const c=await raw(t,f.address,Buffer.concat([a,b]));await c.closed;assert.ok(f.receiver.read().events.length<=1);assert.ok(!f.receiver.read().events.some(e=>e.envelope.event.sequence===2));
});
test('absolute connection deadline retires a pre-TLS TCP stall with no request or persistent acceptance',enabled,async t=>{
 const f=await fixture(t,{connectionLifetimeMs:75}),c=await raw(t,f.address,'',{tls:false,write:false});await until(()=>f.receiver.status().connections===1);await c.closed;await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);
});
test('absolute receiver deadline cannot be renewed by slowly dripping valid header bytes',enabled,async t=>{
 const f=await fixture(t,{connectionLifetimeMs:100}),c=await raw(t,f.address,'POST '+f.address.path+' HTTP/1.1\r\nHost: localhost\r\nX-Slow: ');let timer=setInterval(()=>c.socket.write('x'),10);try{await c.closed;}finally{clearInterval(timer);}await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);
});
test('absolute receiver deadline cannot be renewed by slowly dripping an incomplete signed body',enabled,async t=>{
 const f=await fixture(t,{connectionLifetimeMs:100}),row=signed(),c=await raw(t,f.address,frame(f.address,row,{body:row.body.subarray(0,1)}));const timer=setInterval(()=>c.socket.write(' '),10);try{await c.closed;}finally{clearInterval(timer);}await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);
});
test('connection capacity includes pre-handshake TCP clients and becomes reusable only after their actual close',enabled,async t=>{
 const f=await fixture(t,{maxConnections:1,connectionLifetimeMs:2000}),a=await raw(t,f.address,'',{tls:false,write:false});await until(()=>f.receiver.status().connections===1);const b=await raw(t,f.address,'',{tls:false,write:false});await b.closed;assert.equal(f.receiver.status().connections,1);a.socket.destroy();await a.closed;await until(()=>f.receiver.status().connections===0);assert.equal((await send(f.url,signed())).status,202);
});
test('receiver close cancellation only cancels observation while original TCP TLS and database retirement continues',enabled,async t=>{
 const f=await fixture(t),tcp=await raw(t,f.address,'',{tls:false,write:false}),tls=await raw(t,f.address,'',{write:false}),controller=new AbortController();controller.abort(Error('private reason'));const closing=f.receiver.close({signal:controller.signal}),cancelled=assert.rejects(closing,code('ABORTED'));assert.equal(f.receiver.status().state,'closing');assert.equal(f.receiver.status().connections,2);assert.throws(()=>createAgentWebhookInbox({directory:f.cfg.directory,tenantId:'tenant-a',...authConfig}),{code:'AGENT_WEBHOOK_INBOX_OPEN'});await cancelled;await f.receiver.close();await Promise.all([tcp.closed,tls.closed]);assert.equal(f.receiver.status().state,'closed');assert.equal(f.receiver.status().connections,0);assert.throws(()=>f.receiver.read(),code('CLOSED'));const next=createAgentWebhookReceiver(f.cfg);await next.close();
});
test('cancelled listen observation does not cancel original bind or duplicate its owned listener',enabled,async t=>{
 const root=await mkdtemp(join(tmpdir(),'remote-paint-receiver-listen-')),receiver=createAgentWebhookReceiver({directory:join(root,'inbox'),tenantId:'tenant-a',...authConfig,key,cert});t.after(async()=>{await receiver.close();await rm(root,{recursive:true,force:true});});const controller=new AbortController();controller.abort();await assert.rejects(receiver.listen({signal:controller.signal}),code('ABORTED'));const a=await receiver.listen(),b=await receiver.listen();assert.deepEqual(a,b);assert.equal((await send('https://127.0.0.1:'+a.port+a.path,signed())).status,202);
});
test('close before listen and during a pending literal-address bind retires the exact owned database',enabled,async t=>{
 for(const mode of ['never','pending']){const root=await mkdtemp(join(tmpdir(),'remote-paint-receiver-early-')),cfg={directory:join(root,'inbox'),tenantId:'tenant-a',...authConfig,key,cert},receiver=createAgentWebhookReceiver(cfg);t.after(()=>rm(root,{recursive:true,force:true}));const pending=mode==='pending'?assert.rejects(receiver.listen(),code('CLOSED')):Promise.resolve();await receiver.close();await pending;assert.equal(receiver.status().state,'closed');const next=createAgentWebhookReceiver(cfg);await next.close();}
});
test('a failed listener bind leaves an observable owner that can close without resetting its inbox',enabled,async t=>{
 const first=await fixture(t),second=await fixture(t);await second.receiver.close();const next=createAgentWebhookReceiver({...second.cfg,port:first.address.port});t.after(()=>next.close());await assert.rejects(next.listen(),code('LISTEN'));assert.equal(next.status().state,'listen-failed');await next.close();assert.equal(next.status().state,'closed');
});
test('receiver configuration and observer options reject getters proxies and policy expansion without invoking caller hooks',enabled,async t=>{
 const f=await fixture(t);let calls=0;for(const patch of [{host:'localhost'},{maxConnections:33},{connectionLifetimeMs:60001},{port:-1},{path:'/hook?private=1'},{key:null},{cert:'private'}])assert.throws(()=>createAgentWebhookReceiver({...f.cfg,directory:join(f.root,'invalid'),...patch}));assert.throws(()=>createAgentWebhookReceiver(Object.defineProperty({...f.cfg},'key',{get(){calls++;return key;}})),code('INVALID'));assert.throws(()=>f.receiver.listen({signal:{}}),code('INVALID'));assert.throws(()=>f.receiver.close(Object.defineProperty({},'signal',{get(){calls++;}})),code('INVALID'));assert.equal(calls,0);assert.equal(f.receiver.status().state,'listening');
});
for(const mode of ['before-commit','after-commit'])test('production HTTPS receiver actual writer SIGKILL '+mode+' preserves exact restart identity and original event dedup',enabled,async t=>{
 const root=await mkdtemp(join(tmpdir(),'remote-paint-prod-receiver-kill-')),directory=join(root,'inbox'),marker=join(root,'marker');t.after(()=>rm(root,{recursive:true,force:true}));let identity;
 const spawn=mode=>fork(new URL('./fixtures/agent-webhook-receiver-child.mjs',import.meta.url),[directory,mode,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
 await withOwnedTestChild(()=>spawn(mode),async child=>{const [ready]=await once(child,'message',{signal:AbortSignal.timeout(5000)});identity=ready.identity;const died=once(child,'close');await assert.rejects(send(ready.url,signed()));const [,signal]=await died;assert.equal(signal,'SIGKILL');assert.equal(await readFile(marker,'utf8'),mode+'\n');});
 await withOwnedTestChild(()=>spawn('normal'),async child=>{const [ready]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.deepEqual(ready.identity,identity);const row=await send(ready.url,signed());assert.equal(row.status,mode==='before-commit'?202:200);assert.equal((await send(ready.url,signed())).status,200);assert.equal(JSON.parse(row.text).bodySha256,digest(signed().body));});
});

test('malformed real TLS handshakes retire actual TCP records and leave the receiver closed after shutdown',enabled,async t=>{
 const f=await fixture(t,{connectionLifetimeMs:2000});const c=await raw(t,f.address,'not a TLS handshake\r\n',{tls:false});await c.closed;await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);assert.equal((await send(f.url,signed())).status,202);await f.receiver.close();
});
test('a truncated actual signed body followed by peer close cannot enter the inbox or leak receiver ownership',enabled,async t=>{
 const f=await fixture(t),row=signed(),c=await raw(t,f.address,frame(f.address,row,{body:row.body.subarray(0,3)}));c.socket.destroy();await c.closed;await until(()=>f.receiver.status().connections===0);assert.equal(f.receiver.read().events.length,0);assert.equal((await send(f.url,signed())).status,202);
});

test('pre-handshake close notifications and actual TCP retirement do not strand the original receiver or database owner',enabled,async t=>{
 const f=await fixture(t,{connectionLifetimeMs:75}),notifications=[],rawReceipts=[],serverEmit=TlsServer.prototype.emit,ownServer=Object.hasOwn(TlsServer.prototype,'emit');
 TlsServer.prototype.emit=function(event,...args){
  if(event==='tlsClientError')notifications.push({fromCloseCallback:/onSocketClose/.test(new Error().stack)});
  const result=serverEmit.call(this,event,...args);
  if(event==='connection')args[0].once('close',()=>rawReceipts.push({notified:notifications.length}));return result;
 };
 try{
  for(const mode of ['deadline','malformed','peer-close']){const before=rawReceipts.length,c=await raw(t,f.address,mode==='malformed'?'not TLS\r\n':'',{tls:false,write:mode==='malformed'});if(mode==='peer-close'){await until(()=>f.receiver.status().connections===1);c.socket.destroy();}await c.closed;await until(()=>rawReceipts.length>before);assert.ok(rawReceipts.at(-1).notified>0);await until(()=>f.receiver.status().connections===0);}
  assert.ok(notifications.some(x=>x.fromCloseCallback));const id=f.receiver.identity();await f.receiver.close();assert.equal(f.receiver.status().state,'closed');const next=createAgentWebhookReceiver(f.cfg);try{assert.deepEqual(next.identity(),id);}finally{await next.close();}
 }finally{if(ownServer)TlsServer.prototype.emit=serverEmit;else delete TlsServer.prototype.emit;}
});
