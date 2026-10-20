// File/journal contracts use structural witnesses; actual Engine evidence is
// collected separately through the public owning provider/Registry fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,rename,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {RuntimeRetirementStore} from '../service/runtime-retirement-store.mjs';
import {copyRuntimeWitnessBinding,isRuntimeWitnessBinding} from '../service/runtime-witness-binding.mjs';
import {retirement} from './fixtures/runtime-retirement-records.mjs';
import {witness} from './fixtures/runtime-witness-records.mjs';
import {records} from './fixtures/session-store-records.mjs';
import {provider,intent,requested,created,starting,closing} from './fixtures/session-runtime-records.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'rp-known-absence-'));t.after(()=>rm(directory,{recursive:true,force:true}));const facts=retirement(),witnessDirectory=join(directory,'namespace'),witnessStore=new RuntimeWitnessStore({directory:witnessDirectory}),receipt=witnessStore.persist({...facts,witness:witness()}),startWitness=copyRuntimeWitnessBinding({schema:'runtime-start-witness-v1',engineStartedAt:facts.inspection.document.State.StartedAt,witnessSha256:receipt.witnessSha256,evidenceSha256:receipt.evidenceSha256});facts.closing.allocation.startDispatch=startWitness;
 const retirementDirectory=join(directory,'retirement'),store=new RuntimeRetirementStore({directory:retirementDirectory,witnessStore}),absenceProbe={...facts.removal,httpStatus:404,effectAttempted:false,alreadyAbsent:true};return {directory,...facts,witnessDirectory,witnessStore,startWitness,retirementDirectory,store,absenceProbe};
}
test('historical witness requires the journal generation and both digests, without claiming a live inspection',async t=>{
 const f=await fixture(t),saved=f.witnessStore.readHistorical({plan:f.plan,containerId:f.inspection.document.Id,startWitness:f.startWitness});assert.equal(saved.receipt.evidenceSha256,f.startWitness.evidenceSha256);assert.equal(saved.record.identity.engineStartedAt,f.startWitness.engineStartedAt);
 for(const startWitness of [undefined,'requested','legacy-unknown',{...f.startWitness,engineStartedAt:'2026-10-19T00:00:01.000Z'},{...f.startWitness,witnessSha256:'0'.repeat(64)},{...f.startWitness,evidenceSha256:'0'.repeat(64)}])assert.throws(()=>f.witnessStore.readHistorical({plan:f.plan,containerId:f.inspection.document.Id,startWitness}));
 assert.throws(()=>f.witnessStore.readHistorical({plan:f.plan,containerId:null,startWitness:f.startWitness}),{code:'WITNESS_BINDING'});assert.throws(()=>f.witnessStore.readHistorical({plan:f.plan,containerId:'0'.repeat(64),startWitness:f.startWitness}),{code:'WITNESS_MISSING'});
});
test('known fullCID absence has its own immutable v2 proof with actual no-effect404 and independently readable namespace',async t=>{
 const f=await fixture(t),receipt=f.store.persistAbsent(f);assert.equal(receipt.kind,'container-absent');const saved=new RuntimeRetirementStore({directory:f.retirementDirectory}).read({plan:f.plan,containerId:f.inspection.document.Id,expectedSha256:receipt.evidenceSha256});assert.equal(saved.record.schema,'session-runtime-retirement-v2');assert.equal(saved.record.proof.kind,'container-absent');assert.equal(saved.record.proof.absenceProbe.httpStatus,404);assert.equal(saved.record.proof.absenceProbe.effectAttempted,false);assert.equal(saved.record.proof.removal,undefined);assert.deepEqual(saved.record.proof.startWitness,f.startWitness);assert.throws(()=>f.store.persistAbsent(f),{code:'RETIREMENT_EXISTS'});
});
test('original204 persistence cannot accept404 even when historical witness is available',async t=>{
 const f=await fixture(t);assert.throws(()=>f.store.persistRemoved({...f,removal:f.absenceProbe}),{code:'RETIREMENT_REMOVAL'});assert.equal((await readdir(f.retirementDirectory)).length,0);
});
test('unknown requestedCID,nonclosing receipt and legacy/unbound Start cannot retire from absence',async t=>{
 const f=await fixture(t);
 for(const edit of [v=>v.closing.allocation.containerId=null,v=>v.closing.allocation.state='created',v=>v.closing.allocation.requestStarted=false,v=>v.closing.revision=0]){const value=structuredClone({...retirement(),absenceProbe:f.absenceProbe});value.closing.allocation.startDispatch=f.startWitness;edit(value);assert.throws(()=>f.store.persistAbsent(value),{code:'RETIREMENT_JOURNAL'});}
 for(const startDispatch of ['requested','legacy-unknown','not-requested'])assert.throws(()=>f.store.persistAbsent({...f,closing:{...f.closing,allocation:{...f.closing.allocation,startDispatch}}}),{code:'RETIREMENT_NAMESPACE'});
 assert.equal((await readdir(f.retirementDirectory)).length,0);
});
test('absence proof rejects wrong daemon,CID,authorization,attempted mutation and nonfresh/full selectors',async t=>{
 const f=await fixture(t);
 for(const edit of [v=>v.absenceProbe.daemonId='foreign',v=>v.absenceProbe.containerId='0'.repeat(64),v=>v.absenceProbe.authorizationRevision++,v=>v.absenceProbe.httpStatus=204,v=>v.absenceProbe.effectAttempted=true,v=>v.absenceProbe.alreadyAbsent=false,v=>v.absence.found=true,v=>v.absence.daemon.id='foreign',v=>v.absence.selector=v.plan.containerName]){const value={plan:f.plan,closing:structuredClone(f.closing),absenceProbe:structuredClone(f.absenceProbe),absence:structuredClone(f.absence)};edit(value);assert.throws(()=>f.store.persistAbsent(value),{code:'RETIREMENT_ABSENCE'});}
 assert.equal((await readdir(f.retirementDirectory)).length,0);
});
test('missing or modified namespace evidence cannot be replaced by a caller-provided receipt',async t=>{
 const f=await fixture(t),file=join(f.witnessDirectory,f.plan.sessionId+'-'+f.inspection.document.Id+'.namespace.json'),bytes=await readFile(file);await writeFile(file,Buffer.from('{broken'));assert.throws(()=>f.store.persistAbsent(f),{code:'WITNESS_DIGEST'});await rm(file);assert.throws(()=>f.store.persistAbsent(f),{code:'WITNESS_MISSING'});await writeFile(file,bytes,{mode:0o600});assert.equal(f.store.persistAbsent(f).kind,'container-absent');
});
test('a live witness-store handle pins its private directory for reads and publication',async t=>{
 const f=await fixture(t);await rename(f.witnessDirectory,join(f.directory,'original-namespace'));await mkdir(f.witnessDirectory,{mode:0o700});
 assert.throws(()=>f.witnessStore.readHistorical({plan:f.plan,containerId:f.inspection.document.Id,startWitness:f.startWitness}),{code:'WITNESS_DIRECTORY'});assert.throws(()=>f.witnessStore.persist({...f,witness:witness()}),{code:'WITNESS_DIRECTORY'});assert.equal((await readdir(f.witnessDirectory)).length,0);
});
test('versioned witness binding rejects getters and changes only once after the durable Start fence',async t=>{
 const f=await fixture(t);let getter=0;const bad={...f.startWitness};Object.defineProperty(bad,'engineStartedAt',{get(){getter++;return f.startWitness.engineStartedAt;},enumerable:true});assert.equal(isRuntimeWitnessBinding(bad),false);assert.equal(getter,0);
 const db=new SqliteSessionStore({path:join(f.directory,'journal.sqlite')}),owner=Symbol('runtime'),batch=records(),row=intent(batch);try{db.claimRuntimeProvider(owner,provider);db.commit(batch);for(const value of [row,requested(row),created(row)])db.commitRuntime(value,{owner});const bound={...created(row),startDispatch:f.startWitness};assert.throws(()=>db.commitRuntime(bound,{owner}),{code:'STATE_RUNTIME_CONFLICT'});db.commitRuntime(starting(row),{owner});db.commitRuntime(bound,{owner});assert.throws(()=>db.commitRuntime(bound,{owner}),{code:'STATE_RUNTIME_CONFLICT'});assert.throws(()=>db.commitRuntime({...closing(bound),startDispatch:{...f.startWitness,evidenceSha256:'0'.repeat(64)}},{owner}),{code:'STATE_RUNTIME_CONFLICT'});db.commitRuntime(closing(bound),{owner});}finally{db.releaseRuntimeProvider(owner);db.close();}
 const reopened=new SqliteSessionStore({path:join(f.directory,'journal.sqlite')}),next=Symbol('recovered');try{reopened.claimRuntimeProvider(next,provider);assert.deepEqual(reopened.loadRuntime({owner:next}).allocations[0].startDispatch,f.startWitness);}finally{reopened.releaseRuntimeProvider(next);reopened.close();}
});
test('restrictive child-only umask fails before publishing a witness with nonprivate final mode',async t=>{
 const f=await fixture(t),directory=join(f.directory,'umask');await mkdir(directory,{mode:0o700});let result;
 await withOwnedTestChild(()=>fork(new URL('./fixtures/runtime-witness-store-child.mjs',import.meta.url),[directory,'restricted-umask'],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{[result]=await once(child,'message',{signal:AbortSignal.timeout(5000)});});assert.deepEqual(result,{event:'persist-failed',code:'WITNESS_FILE'});assert.equal((await readdir(directory)).length,0);
});
