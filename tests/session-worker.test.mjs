import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {withOwnedTestChild} from './owned-test-child.mjs';
const script=fileURLToPath(new URL('./fixtures/session-worker-child.mjs',import.meta.url)),key='a'.repeat(64),sessionId='ses_fixture';
function tracked(mode){
 const child=spawn(process.execPath,[script,mode],{stdio:['pipe','pipe','pipe']}),messages=[],events=[];let stderr='',text='',eventText='';
 child.stdin.on('error',()=>{});child.stdout.on('data',bytes=>{text+=bytes.toString();for(let i;(i=text.indexOf('\n'))>=0;){messages.push(JSON.parse(text.slice(0,i)));text=text.slice(i+1);}});child.stderr.on('data',bytes=>{const value=bytes.toString();stderr+=value;eventText+=value;for(let i;(i=eventText.indexOf('\n'))>=0;){try{events.push(JSON.parse(eventText.slice(0,i)));}catch{}eventText=eventText.slice(i+1);}});
 const closed=once(child,'close').then(([code,signal])=>({code,signal,stderr,messages}));
 return {child,messages,events,closed,send(value){child.stdin.write(JSON.stringify({sessionId,ownerKey:key,...value})+'\n');}};
}
async function until(condition){const deadline=performance.now()+3000;while(!condition()){assert.ok(performance.now()<deadline,'Worker fixture response deadline');await new Promise(resolve=>setTimeout(resolve,5));}}
async function owned(mode,body){let h;return withOwnedTestChild(()=>{h=tracked(mode);return h.child;},async()=>{await until(()=>h.messages.some(m=>m.type==='WorkerHello'));return body(h);});}
const start=h=>h.send({type:'Start',request:{url:'about:blank',region:'test',ttlSeconds:60}});
const receipt=result=>{assert.doesNotMatch(result.stderr,/private-.*secret/);return JSON.parse(result.stderr.trim().split('\n').at(-1));};

test('worker authenticates before resource construction and emits bounded version-only readiness',()=>owned('normal',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));const ready=h.messages.find(m=>m.type==='Ready');assert.deepEqual(ready,{protocol:'session-worker-v1',sessionId,type:'Ready',version:'fixture-worker-v1'});h.send({type:'Close'});const result=await h.closed;assert.equal(result.code,0);assert.equal(result.messages.at(-1).type,'Closed');assert.equal(receipt(result).closes,1);
}));

test('wrong owner/session and malformed bootstrap are rejected without allocating',async()=>{
 for(const input of [{type:'Start',ownerKey:'b'.repeat(64),request:{url:'about:blank',region:'test',ttlSeconds:60}},
  {type:'Start',sessionId:'ses_other',request:{url:'about:blank',region:'test',ttlSeconds:60}},
  {type:'Start',request:{url:'file:///private',region:'test',ttlSeconds:60}},
  {type:'Start',request:{url:'about:blank',region:'elsewhere',ttlSeconds:60}},
  {type:'Start',request:{url:'about:blank',region:'test',ttlSeconds:60,tenantId:'b'}}])await owned('normal',async h=>{
   h.send(input);const result=await h.closed;assert.equal(result.code,1);assert.equal(receipt(result).initializes,0);assert.ok(result.messages.at(-1).code.startsWith('WORKER_'));
  });
});

test('duplicate Start never allocates twice and closes the original owner',()=>owned('normal',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));start(h);const result=await h.closed;assert.equal(result.code,1);assert.equal(receipt(result).initializes,1);assert.equal(receipt(result).closes,1);
}));

test('Close in the same input batch prevents initialization entirely',()=>owned('normal',async h=>{
 h.child.stdin.write(JSON.stringify({type:'Start',sessionId,ownerKey:key,request:{url:'about:blank',region:'test',ttlSeconds:60}})+'\n'+JSON.stringify({type:'Close',sessionId,ownerKey:key})+'\n');const result=await h.closed;assert.equal(result.code,0);assert.equal(receipt(result).initializes,0);assert.equal(receipt(result).closes,1);assert.ok(!h.messages.some(m=>m.type==='Ready'));
}));

test('owner EOF closes and reaps an actual owned child process',()=>owned('owned-child',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));h.child.stdin.end();const result=await h.closed,r=receipt(result);assert.equal(result.code,0);assert.equal(r.leafReaped,true);assert.ok(r.leafPid>0);assert.throws(()=>process.kill(r.leafPid,0),error=>error.code==='ESRCH');
}));

test('owner lease expiry closes even if stdin stays open',()=>owned('lease-expiry',async h=>{
 start(h);const result=await h.closed;assert.equal(result.code,0);assert.equal(receipt(result).outcome.reason,'owner-lease-expired');assert.equal(receipt(result).closes,1);
}));

test('heartbeat extends only the authenticated owner lease and normal release still works',()=>owned('lease-expiry',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));for(let i=0;i<5;i++){h.send({type:'OwnerHeartbeat'});await new Promise(resolve=>setTimeout(resolve,40));}assert.equal(h.child.exitCode,null);h.send({type:'Close'});assert.equal((await h.closed).code,0);
}));

test('release during late initialization waits actual completion and never publishes late Ready',()=>owned('late-start',async h=>{
 start(h);await new Promise(resolve=>setTimeout(resolve,20));h.send({type:'Close'});const result=await h.closed;assert.equal(result.code,0);assert.equal(receipt(result).initializes,1);assert.equal(receipt(result).closes,1);assert.ok(!h.messages.some(m=>m.type==='Ready'));
}));

test('startup, factory and cleanup failures stay redacted and cannot produce false successful exit',async()=>{
 for(const mode of ['startup-fail','factory-fail','async-factory','close-fail','unconfirmed','close-timeout'])await owned(mode,async h=>{
  start(h);if(!['startup-fail','factory-fail','async-factory'].includes(mode)){await until(()=>h.messages.some(m=>m.type==='Ready'));h.send({type:'Close'});}const result=await h.closed;assert.equal(result.code,1,mode);assert.doesNotMatch(JSON.stringify(h.messages),/private-.*secret/);if(['close-fail','unconfirmed','close-timeout'].includes(mode))assert.equal(h.messages.at(-1).type,'CleanupIncomplete');
 });
});

test('frame size, invalid UTF8 and non-JSON input are bounded before allocation',async()=>{
 for(const data of [Buffer.from('x'.repeat(32769)),Buffer.from([255,10]),Buffer.from('{\n')])await owned('normal',async h=>{h.child.stdin.write(data);const result=await h.closed;assert.equal(result.code,1);assert.equal(receipt(result).initializes,0);assert.match(h.messages.at(-1).code,/WORKER_(INVALID_FRAME|FRAME_LIMIT)/);});
});

test('missing handshake and overall initialization deadline stop the worker without false Ready',async()=>{
 await owned('handshake-timeout',async h=>{const result=await h.closed;assert.equal(result.code,1);assert.equal(receipt(result).initializes,0);assert.equal(h.messages.at(-1).code,'WORKER_START_HANDSHAKE_TIMEOUT');});
 await owned('startup-timeout',async h=>{start(h);const result=await h.closed;assert.equal(result.code,1);assert.equal(receipt(result).closes,1);assert.ok(!h.messages.some(m=>m.type==='Ready'));assert.equal(h.messages.at(-1).code,'WORKER_START_TIMEOUT');});
});


test('early closed acknowledgement cannot hide still pending initialization',()=>owned('early-close',async h=>{
 start(h);await new Promise(resolve=>setTimeout(resolve,20));h.send({type:'Close'});const result=await h.closed;assert.equal(result.code,1);assert.equal(h.messages.at(-1).type,'CleanupIncomplete');assert.ok(!h.messages.some(m=>m.type==='Ready'));
}));

test('abort listeners see the already installed single close fence',()=>owned('abort-reentrant',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));h.send({type:'Close'});const result=await h.closed,r=receipt(result);assert.equal(result.code,0);assert.equal(r.reentries,1);assert.equal(r.reentryHadFence,true);assert.equal(r.closes,1);
}));

test('closing stdout during release still completes resource cleanup without unhandled pipe errors',()=>owned('normal',async h=>{
 start(h);await until(()=>h.messages.some(m=>m.type==='Ready'));h.child.stdout.destroy();h.send({type:'Close'});const result=await h.closed;assert.equal(result.code,0,result.stderr);assert.equal(receipt(result).closes,1);assert.equal(receipt(result).outcome.status,'closed');
}));

test('fragmented UTF8 bootstrap remains one authenticated request with no URL echo',()=>owned('normal',async h=>{
 const url='https://例子.测试/path?private=fixture',bytes=Buffer.from(JSON.stringify({type:'Start',sessionId,ownerKey:key,request:{url,region:'test',ttlSeconds:60}})+'\n');
 for(let i=0;i<bytes.length;i+=3)h.child.stdin.write(bytes.subarray(i,i+3));await until(()=>h.messages.some(m=>m.type==='Ready'));h.send({type:'Close'});const result=await h.closed;assert.equal(result.code,0);assert.equal(receipt(result).initializes,1);assert.doesNotMatch(JSON.stringify(h.messages),/private=fixture|例子/);
}));


test('a setup rejection reaps the worker and the owned leaf also exits on inherited owner EOF',async()=>{
 let pid;
 await assert.rejects(owned('owned-child',async h=>{start(h);await until(()=>h.messages.some(m=>m.type==='Ready')&&h.events.some(e=>e.event==='OwnedLeaf'));pid=h.events.find(e=>e.event==='OwnedLeaf').pid;throw new Error('fixture setup rejected after child allocation');}),/fixture setup rejected/);
 assert.ok(pid>0);await until(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}});
});
