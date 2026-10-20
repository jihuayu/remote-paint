import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionWorkerChannel} from '../service/session-worker-channel.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {runtimeWitnessSha256} from '../service/linux-runtime-witness.mjs';
import {witness} from './fixtures/runtime-witness-records.mjs';
import {records} from './fixtures/session-store-records.mjs';
import {provider,intent,requested,created,starting,closing} from './fixtures/session-runtime-records.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};},delay=ms=>new Promise(r=>setTimeout(r,ms));
const sessionId='ses_close_witness',runtimeBinding={containerId:'a'.repeat(64),daemonId:'daemon-test',specDigest:'b'.repeat(64)};
const receipt=w=>({sessionId,...runtimeBinding,witnessSha256:runtimeWitnessSha256(w),evidenceSha256:'f'.repeat(64)});
function channel(t,options={}){
 const output=new PassThrough(),done=defer(),writes=[];let ends=0;
 const input=new Writable({write(bytes,_encoding,callback){writes.push(JSON.parse(bytes.toString()));callback();},final(callback){ends++;callback();}}),instance=new SessionWorkerChannel({sessionId,region:'test',ownerKey:null,closeOnly:true,input,output,clientDone:done.promise,requireRuntimeWitness:true,runtimeBinding,onRuntimeWitness:receipt,helloTimeoutMs:1000,closeTimeoutMs:1000,heartbeatMs:10,...options});
 t.after(async()=>{done.resolve({code:0,signal:null});await instance.close();output.destroy();});
 const send=(type,more={})=>output.write(JSON.stringify({type,protocol:'session-worker-v1',sessionId,...more})+'\n');return{channel:instance,done,writes,ends:()=>ends,send,hello:()=>send('WorkerHello',{runtimeWitness:witness()})};
}
test('close-only witness gate accepts Hello while Start and every authenticated frame remain forbidden',async t=>{
 const f=channel(t);let getters=0;assert.throws(()=>f.channel.start({get url(){getters++;return'about:blank';}}),{code:'CHANNEL_CLOSE_ONLY'});assert.equal(getters,0);
 const pending=f.channel.waitForRuntimeWitness();f.hello();assert.deepEqual(await pending,receipt(witness()));await delay(25);assert.equal(f.channel.status().closeOnly,true);assert.equal(f.channel.status().available,false);assert.equal(f.channel.status().startSent,false);assert.equal(f.writes.length,0);
 const closing=f.channel.close();assert.equal(f.ends(),1);f.done.resolve({code:0,signal:null});const result=await closing;assert.equal(result.startSent,false);assert.equal(result.transportExit.code,0);assert.equal(f.writes.length,0);
});
test('close-only proof timeout and unexpected Ready reject the gate without sending Start',async t=>{
 for(const mode of ['timeout','ready']){const f=channel(t,{helloTimeoutMs:50}),pending=assert.rejects(f.channel.waitForRuntimeWitness());if(mode==='ready')f.send('Ready',{version:'unrequested'});await pending;assert.equal(f.writes.length,0);assert.equal(f.channel.runtimeWitnessReceipt,null);}
});
test('explicit close aborts pending close-only evidence IO and rejects a late receipt',async t=>{
 const gate=defer();let signal;const f=channel(t,{onRuntimeWitness:(_w,context)=>{signal=context.signal;return gate.promise;}}),pending=assert.rejects(f.channel.waitForRuntimeWitness());f.hello();const closing=f.channel.close();assert.equal(signal.aborted,true);gate.resolve(receipt(witness()));await pending;await delay(0);assert.equal(f.channel.runtimeWitnessReceipt,null);assert.equal(f.writes.length,0);f.done.resolve({code:0,signal:null});await closing;
});
test('invalid close-only receipt cannot complete the gate or initialize a resource',async t=>{
 const f=channel(t,{onRuntimeWitness:w=>({...receipt(w),containerId:'0'.repeat(64)})}),pending=assert.rejects(f.channel.waitForRuntimeWitness(),{code:'CHANNEL_RUNTIME_WITNESS_RECEIPT'});f.hello();await pending;assert.equal(f.writes.length,0);assert.equal(f.channel.status().startSent,false);
});
test('normal private Start still requires an explicit Start call after the exposed witness gate',async t=>{
 const f=channel(t,{closeOnly:false,ownerKey:'c'.repeat(64)}),witnessReady=f.channel.waitForRuntimeWitness();f.hello();await witnessReady;assert.equal(f.writes.length,0);const start=f.channel.start({url:'about:blank',region:'test',ttlSeconds:60});assert.equal(f.writes[0].type,'Start');f.send('Ready',{version:'fixture'});assert.deepEqual(await start,{version:'fixture'});assert.equal(f.channel.status().available,true);
});
test('close-only configuration cannot carry an owner credential or disable effective witness validation',()=>{
 const output=new PassThrough(),input=new PassThrough(),clientDone=Promise.resolve({code:0,signal:null}),base={sessionId,region:'test',input,output,clientDone,closeOnly:true};
 for(const options of [{ownerKey:'c'.repeat(64),requireRuntimeWitness:true,onRuntimeWitness:receipt,runtimeBinding},{ownerKey:null,requireRuntimeWitness:false}])assert.throws(()=>new SessionWorkerChannel({...base,...options}),TypeError);input.destroy();output.destroy();
});
const binding={schema:'runtime-start-witness-v1',engineStartedAt:'2026-10-18T00:00:00.123456789Z',witnessSha256:'e'.repeat(64),evidenceSha256:'f'.repeat(64)};
async function ledger(t,stage='started'){
 const directory=await mkdtemp(join(tmpdir(),'rp-closing-witness-')),path=join(directory,'journal.sqlite'),store=new SqliteSessionStore({path}),owner=Symbol('provider'),batch=records(),row=intent(batch);store.claimRuntimeProvider(owner,provider);store.commit(batch);let active=row;
 const steps=[row,...(stage==='intent'?[]:[requested(row)]),...(['intent','requested'].includes(stage)?[]:[created(row)]),...(stage==='started'?[starting(row)]:[])];for(const next of steps){store.commitRuntime(next,{owner});active=next;}store.commitRuntime(closing(active),{owner});
 t.after(()=>{try{store.releaseRuntimeProvider(owner);}catch{}store.close();return rm(directory,{recursive:true,force:true});});return{path,store,owner,row,active};
}
test('only the named closing-witness API can qualify an already closing runtime and cannot rewrite it',async t=>{
 const f=await ledger(t),before=f.store.loadRuntime({owner:f.owner});assert.throws(()=>f.store.commitRuntime({...closing(f.active),startDispatch:binding},{owner:f.owner,closingWitness:true}),{code:'STATE_RUNTIME_CONFLICT'});assert.deepEqual(f.store.loadRuntime({owner:f.owner}),before);
 const result=f.store.bindRuntimeClosingWitness(f.row.sessionId,binding,{owner:f.owner});assert.equal(result.revision,before.revision+1);assert.equal(result.allocation.state,'closing');assert.deepEqual(result.allocation.startDispatch,binding);assert.throws(()=>f.store.bindRuntimeClosingWitness(f.row.sessionId,binding,{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});assert.throws(()=>f.store.commitRuntime({...result.allocation,startDispatch:'requested'},{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});
});
test('recovered owner may bind only closing evidence while Create,EngineStart and Ready stay fenced',async t=>{
 const f=await ledger(t);f.store.releaseRuntimeProvider(f.owner);f.store.close();const store=new SqliteSessionStore({path:f.path}),owner=Symbol('recovered');try{store.claimRuntimeProvider(owner,provider);const result=store.bindRuntimeClosingWitness(f.row.sessionId,binding,{owner});assert.equal(result.allocation.state,'closing');assert.throws(()=>store.commitRuntime(starting(f.row),{owner}),{code:'STATE_RUNTIME_RECOVERY_REQUIRED'});assert.throws(()=>store.commitRuntime({...result.allocation,state:'ready',closeReason:null,version:'late'},{owner}),{code:'STATE_RUNTIME_RECOVERY_REQUIRED'});assert.deepEqual(store.loadRuntime({owner}).allocations[0].startDispatch,binding);}finally{store.releaseRuntimeProvider(owner);store.close();}
});
test('undispatched,unknown-CID and never-requested Start histories cannot borrow a closing witness',async t=>{
 for(const stage of ['intent','requested','created']){const f=await ledger(t,stage);assert.throws(()=>f.store.bindRuntimeClosingWitness(f.row.sessionId,binding,{owner:Symbol('foreign')}),{code:'STATE_RUNTIME_OWNER'});assert.throws(()=>f.store.bindRuntimeClosingWitness(f.row.sessionId,binding,{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});assert.equal(f.store.loadRuntime({owner:f.owner}).allocations[0].startDispatch,'not-requested');}
});
