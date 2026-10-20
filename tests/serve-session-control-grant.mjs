// Explicit diagnostic: hold one real Native ControlGranted until the private
// test driver releases it. The production Source/control/Gateway are unchanged.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startSessionMemoryFixture} from './session-memory-fixture.mjs';
import {createSessionMemoryOwner} from './session-memory-owner.mjs';
import {atomicJson} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'linux');
const directory=resolve(process.env.REMOTE_PAINT_SESSION_LONG_DIR),port=Number(process.env.REMOTE_PAINT_SESSION_LONG_PORT),runId=randomUUID();assert.ok(port>=1024&&port<65532);
await mkdir(directory,{recursive:true,mode:0o700});for(const name of ['requests','responses'])await mkdir(join(directory,name),{recursive:true});
const fixture=await startSessionMemoryFixture(),handled=new Set(),records=[];let owner,closing=false,timer,stopPromise,armed=false,held=null,sequence=0;
const save=(name,value)=>atomicJson(directory,name,value);
async function release(reason){assert.ok(held,'No grant is held');const job=held;held=null;clearTimeout(job.timer);job.record.releaseReason=reason;job.record.releasedAtSourceMs=performance.now();job.record.heldMs=job.record.releasedAtSourceMs-job.record.heldAtSourceMs;await save('grant-delay-records.json',records);job.resolve();await job.done;return {...job.record};}
const stop=()=>stopPromise??=(async()=>{closing=true;clearTimeout(timer);const errors=[];let receipt;
 try{if(held)await release('source-stop');armed=false;}catch(e){errors.push(e.stack);}
 try{receipt=await owner?.close();assert.equal(receipt?.status,'closed');assert.deepEqual(receipt.nodeCalls,{map:0,publish:0,awaitPromise:0});}catch(e){errors.push(e.stack);}
 try{await fixture.close();}catch(e){errors.push(e.stack);}
 await save('source-stopped.json',{at:new Date().toISOString(),runId,status:errors.length?'failed':'closed',errors,receipt,records,fixtureListening:fixture.listening});if(errors.length)process.exitCode=1;
})();
try{
 owner=await createSessionMemoryOwner(fixture,{port,host:'0.0.0.0'});await owner.pin();const source=owner.source,original=source.broker.request;
 source.broker.request=function(op,...args){
  if(!armed||op!=='send'||args[0]?.message?.type!=='ControlGranted')return original.call(this,op,...args);
  assert.equal(held,null);armed=false;const message=args[0].message,record={ordinal:++sequence,peerId:args[0].peerId,pageEpoch:message.pageEpoch,viewportVersion:message.viewportVersion,heldAtSourceMs:performance.now(),releaseReason:null};assert.ok(records.length<8);records.push(record);
  const gate=new Promise(resolve=>{held={record,resolve,timer:null,done:null};});const job=held;
  job.done=(async()=>{await save('grant-delay-records.json',records);await gate;return original.call(source.broker,op,...args);})();
  job.timer=setTimeout(()=>void release('guard-autorelease').catch(e=>{process.exitCode=1;console.error(e.message);}),2000);return job.done;
 };
 await save('ready.json',{runId,primary:{id:owner.id,number:owner.number,url:owner.url,streamOrigin:owner.streamOrigin,renderer:owner.renderer},scope:'Explicitone-granthold diagnostic;2000msguard,notorganiclossorlongload.'});
}catch(e){await stop();throw e;}
async function operation(c){
 if(c.op==='arm-grant'){assert.ok(!armed&&!held);armed=true;return {armed:true};}
 if(c.op==='release-grant')return {released:await release('test-release')};
 if(c.op==='snapshot'){const source=owner.source;return {state:{pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,control:source.control.state(),inputLength:await source.page.locator('input').inputValue().then(v=>v.length)},armed,held:held?{...held.record}:null,records};}
 if(c.op==='stop')return {stopped:true};
 throw new Error('Unknown grant-regression command');
}
async function poll(){if(closing)return;try{
 const name=(await readdir(join(directory,'requests'))).find(n=>/^[a-f0-9-]{36}\.json$/.test(n)&&!handled.has(n));if(!name)return;const c=JSON.parse(await readFile(join(directory,'requests',name),'utf8'));assert.equal(c.runId,runId);handled.add(name);assert.ok(handled.size<=128);
 try{const value=await operation(c);await save('responses/'+c.id+'.json',{id:c.id,...value});if(c.op==='stop')await stop();}catch(e){await save('responses/'+c.id+'.json',{id:c.id,error:e.stack});}
}catch(e){console.error(e.message);}finally{if(!closing)timer=setTimeout(()=>void poll(),10);}}
void poll();process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
