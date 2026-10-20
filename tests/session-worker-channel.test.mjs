import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {SessionWorkerChannel,SessionWorkerChannelError} from '../service/session-worker-channel.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const key='a'.repeat(64),sessionId='ses_fixture',request={url:'about:blank',region:'test',ttlSeconds:60};
const script=fileURLToPath(new URL('./fixtures/session-worker-child.mjs',import.meta.url));
const code=expected=>error=>error instanceof SessionWorkerChannelError&&error.code===expected;
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){const end=performance.now()+3000;while(!predicate()){assert.ok(performance.now()<end,'Channel fixture deadline');await delay(5);}}
async function real(mode,body,options={}){
 let child,channel,stderr='';
 return withOwnedTestChild(()=>{child=spawn(process.execPath,[script,mode],{stdio:['pipe','pipe','pipe']});return child;},async()=>{
  child.stderr.on('data',bytes=>{stderr+=bytes.toString();});const clientDone=once(child,'close').then(([code,signal])=>({code,signal}));
  channel=new SessionWorkerChannel({sessionId,region:'test',ownerKey:key,input:child.stdin,output:child.stdout,clientDone,helloTimeoutMs:2000,readyTimeoutMs:2000,closeTimeoutMs:1500,heartbeatMs:25,...options});
  try{return await body({channel,child,clientDone,receipt:()=>JSON.parse(stderr.trim().split('\n').at(-1)),stderr:()=>stderr});}
  finally{await channel.close();}
 });
}
function fake(t,options={}){
 const output=new PassThrough(),done=defer(),writes=[];let pending=null;
 const input=new Writable({write(chunk,encoding,callback){writes.push(JSON.parse(chunk.toString()));if(options.blockWrite)pending=callback;else callback();}});
 const channel=new SessionWorkerChannel({sessionId,region:'test',ownerKey:key,input,output,clientDone:done.promise,helloTimeoutMs:200,readyTimeoutMs:200,closeTimeoutMs:60,heartbeatMs:10,...options});
 t.after(async()=>{pending?.();done.resolve({code:0,signal:null});await channel.close();input.destroy();output.destroy();});
 return {channel,input,output,done,writes,releaseWrite:()=>{const callback=pending;pending=null;callback?.();},send:(type,rest={})=>output.write(Buffer.from(JSON.stringify({protocol:'session-worker-v1',sessionId,type,...rest})+'\n'))};
}
const hello=h=>h.send('WorkerHello');
const ready=h=>h.send('Ready',{version:'fixture-version'});
const closed=h=>h.send('Closed',{reason:'released',code:null});

test('real worker start is single-flight, captures the request, maintains ownership and reports actual close separately',()=>real('normal',async h=>{
 const value={...request};const first=h.channel.start(value),second=h.channel.start({...request});assert.equal(first,second);value.url='https://changed.test/';
 const result=await first;assert.deepEqual(result,{version:'fixture-worker-v1'});assert.equal(Object.isFrozen(result),true);assert.equal(h.channel.status().available,true);
 const close=h.channel.close();assert.equal(h.channel.close(),close);const report=await close;assert.equal(report.workerClose,'confirmed');assert.deepEqual(report.transportExit,{code:0,signal:null});assert.equal(report.closeTimedOut,false);assert.equal(report.status,undefined);assert.equal(h.receipt().initializes,1);assert.equal(h.receipt().closes,1);assert.doesNotMatch(JSON.stringify(h.channel.status())+JSON.stringify(report),new RegExp(key));
}));

test('wrong owner credential receives no Ready and cannot allocate a resource',()=>real('normal',async h=>{
 await assert.rejects(h.channel.start(request),SessionWorkerChannelError);const report=await h.channel.close();assert.equal(report.workerClose,'confirmed');assert.equal(report.workerCode,'WORKER_AUTHENTICATION_FAILED');assert.equal(report.transportExit.code,1);assert.equal(h.receipt().initializes,0);
},{ownerKey:'b'.repeat(64)}));

test('abort before Hello sends no bootstrap and retains honest missing-close acknowledgement',()=>real('normal',async h=>{
 const controller=new AbortController();controller.abort();await assert.rejects(h.channel.start(request,{signal:controller.signal}),error=>error.code==='CHANNEL_OWNER_ABORTED'&&!error.startSent);
 const report=await h.channel.close();assert.equal(report.startSent,false);assert.equal(report.workerClose,'unconfirmed');assert.equal(report.transportExit.code,0);assert.equal(h.receipt().initializes,0);
}));

test('abort during real late startup never exposes late readiness and waits the close/exit receipt',()=>real('late-start',async h=>{
 const controller=new AbortController(),pending=h.channel.start(request,{signal:controller.signal}),rejected=assert.rejects(pending,code('CHANNEL_OWNER_ABORTED'));
 await until(()=>h.channel.status().startSent);await delay(20);controller.abort();await rejected;
 const report=await h.channel.close();assert.equal(report.workerClose,'confirmed');assert.equal(report.transportExit.code,0);assert.equal(h.channel.status().available,false);assert.equal(h.receipt().initializes,1);assert.equal(h.receipt().closes,1);
}));

test('owner signal remains attached after readiness and closes the actual worker',()=>real('normal',async h=>{
 const controller=new AbortController();await h.channel.start(request,{signal:controller.signal});controller.abort();assert.equal(h.channel.status().available,false);const report=await h.channel.close();assert.equal(report.workerClose,'confirmed');assert.equal(report.transportExit.code,0);
}));

test('parent heartbeats preserve a real short owner lease until explicit release',()=>real('lease-expiry',async h=>{
 await h.channel.start(request);await delay(220);assert.equal(h.channel.status().available,true);assert.equal(h.child.exitCode,null);assert.equal((await h.channel.close()).workerClose,'confirmed');
}));

test('real initialization and cleanup failures do not turn exit or worker acknowledgement into runtime proof',async()=>{
 await real('startup-fail',async h=>{await assert.rejects(h.channel.start(request));const report=await h.channel.close();assert.equal(report.workerCode,'WORKER_START_FAILED');assert.equal(report.transportExit.code,1);assert.doesNotMatch(h.stderr()+JSON.stringify(report),/private-initialize-secret/);});
 for(const mode of ['close-fail','unconfirmed','close-timeout'])await real(mode,async h=>{await h.channel.start(request);const report=await h.channel.close();assert.equal(report.workerClose,'unconfirmed');assert.equal(report.transportExit.code,1);assert.equal(report.closeTimedOut,false);assert.equal(report.status,undefined);assert.doesNotMatch(JSON.stringify(report),/private-close-secret/);});
});

test('unexpected real worker death fences availability and notifies the owner once with an installed close promise',async()=>{
 let channel,callbackClose,callbacks=0;
 await real('normal',async h=>{
  channel=h.channel;await channel.start(request);h.child.kill('SIGKILL');const exit=await channel.terminal;assert.equal(exit.signal,'SIGKILL');const report=await channel.close();assert.equal(report.workerClose,'unconfirmed');assert.equal(report.transportExit.signal,'SIGKILL');assert.equal(callbacks,1);assert.equal(callbackClose,channel.close());assert.equal(channel.status().available,false);
 },{onUnavailable:()=>{callbacks++;callbackClose=channel.close();}});
});

test('Ready and Closed in the same chunk cannot resolve an available start',async t=>{
 const h=fake(t);const pending=h.channel.start(request),rejected=assert.rejects(pending,SessionWorkerChannelError);hello(h);
 h.output.write(Buffer.from(JSON.stringify({protocol:'session-worker-v1',sessionId,type:'Ready',version:'fixture'})+'\n'+JSON.stringify({protocol:'session-worker-v1',sessionId,type:'Closed',reason:'owner-lease-expired',code:null})+'\n'));
 h.done.resolve({code:0,signal:null});await rejected;assert.equal(h.channel.status().available,false);assert.equal((await h.channel.close()).workerClose,'confirmed');
});

test('exit0 without a worker Closed remains unconfirmed and still notifies a ready owner',async t=>{
 let calls=0,channel,callbackClose;
 const h=fake(t,{onUnavailable:()=>{calls++;callbackClose=channel.close();}});channel=h.channel;
 const pending=channel.start(request);hello(h);ready(h);await pending;h.done.resolve({code:0,signal:null});await channel.terminal;
 const report=await channel.close();assert.equal(report.workerClose,'unconfirmed');assert.equal(report.transportExit.code,0);assert.equal(calls,1);assert.equal(callbackClose,channel.close());
});

test('close timeout is uncertain until a later actual client exit arrives and never retries Start',async t=>{
 const h=fake(t);const pending=h.channel.start(request);hello(h);ready(h);await pending;
 const close=h.channel.close(),report=await close;assert.equal(report.closeTimedOut,true);assert.equal(report.transportExit,null);assert.equal(h.channel.status().phase,'uncertain');assert.equal(h.channel.status().transportExited,false);let observed=false;void h.channel.terminal.then(()=>{observed=true;});await delay(5);assert.equal(observed,false);
 h.done.resolve({code:0,signal:null});await h.channel.terminal;assert.equal(h.channel.status().phase,'ended');assert.equal(report.transportExit,null);assert.equal(h.channel.close(),close);assert.equal(h.writes.filter(m=>m.type==='Start').length,1);
});

test('a failed exit observation cannot masquerade as an observed terminal process',async t=>{
 const h=fake(t);const pending=h.channel.start(request),rejected=assert.rejects(pending,code('CHANNEL_EXIT_OBSERVATION_FAILED'));h.done.reject(new Error('private-observation-details'));await rejected;const report=await h.channel.close();assert.equal(report.transportExit,null);assert.equal(report.closeTimedOut,true);assert.equal(h.channel.status().transportExited,false);
});

test('write backpressure does not accumulate heartbeats or unbounded close commands',async t=>{
 const h=fake(t,{blockWrite:true,closeTimeoutMs:120});const pending=h.channel.start(request),rejected=assert.rejects(pending);hello(h);await delay(80);assert.equal(h.writes.length,1);const close=h.channel.close();assert.equal(h.channel.close(),close);assert.equal(h.writes.length,1);const report=await close;await rejected;assert.equal(report.closeTimedOut,true);assert.equal(report.startSent,true);h.releaseWrite();assert.equal(h.writes.length,1);
});

test('malformed, foreign, duplicate, oversized and excessive frames are rejected without raw data in errors',async t=>{
 for(const frame of [Buffer.from('{\n'),Buffer.from([255,10]),Buffer.from('x'.repeat(2049)),Buffer.from(JSON.stringify({protocol:'session-worker-v1',sessionId:'ses_foreign',type:'WorkerHello'})+'\n'),Buffer.from(JSON.stringify({protocol:'unknown',sessionId,type:'WorkerHello'})+'\n')]){
  const h=fake(t);const pending=h.channel.start(request),rejected=assert.rejects(pending,error=>error instanceof SessionWorkerChannelError&&!String(error).includes('private'));
  h.output.write(frame);h.done.resolve({code:1,signal:null});await rejected;assert.equal(h.channel.status().available,false);assert.equal(h.writes.length,0);
 }
 const h=fake(t);const pending=h.channel.start(request),rejected=assert.rejects(pending);hello(h);hello(h);h.done.resolve({code:1,signal:null});await rejected;assert.equal((await h.channel.close()).workerClose,'unconfirmed');
});

test('unknown configuration and Ready before bootstrap are not accepted as valid readiness',async t=>{
 const h=fake(t);const pending=h.channel.start(request),rejected=assert.rejects(pending,code('CHANNEL_WORKER_CONFIGURATION_FAILED'));h.output.write(Buffer.from(JSON.stringify({type:'WorkerConfigurationFailed',protocol:'session-worker-v1',code:'WORKER_CONFIGURATION_FAILED'})+'\n'));h.done.resolve({code:1,signal:null});await rejected;assert.equal(h.writes.length,0);
 const other=fake(t);ready(other);other.done.resolve({code:1,signal:null});assert.equal((await other.channel.close()).workerClose,'unconfirmed');
});

test('only valid starts can be sent and a completed channel cannot be restarted as ready',async t=>{
 const h=fake(t);
 for(const value of [{...request,region:'elsewhere'},{...request,url:'file:///private'},{...request,url:' about:blank'},{...request,ttlSeconds:0},{...request,tenantId:'other'},{...request,get url(){throw new Error('getter must not run');}}])assert.throws(()=>h.channel.start(value),code('CHANNEL_INVALID_START'));
 const first=h.channel.start(request);assert.throws(()=>h.channel.start({...request,url:'https://different.test/'}),code('CHANNEL_START_CONFLICT'));hello(h);ready(h);await first;closed(h);h.done.resolve({code:0,signal:null});await h.channel.close();
 await assert.rejects(h.channel.start(request),SessionWorkerChannelError);assert.equal(h.writes.filter(m=>m.type==='Start').length,1);
});

test('hello and ready deadlines stop pending starts with fixed errors',async t=>{
 const h=fake(t,{helloTimeoutMs:50});await assert.rejects(h.channel.start(request),code('CHANNEL_HELLO_TIMEOUT'));h.done.resolve({code:0,signal:null});await h.channel.close();
 const other=fake(t,{readyTimeoutMs:50});const pending=other.channel.start(request);hello(other);await assert.rejects(pending,code('CHANNEL_READY_TIMEOUT'));other.done.resolve({code:0,signal:null});await other.channel.close();
});
