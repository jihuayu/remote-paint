import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {records} from './fixtures/session-store-records.mjs';
import {provider,intent,requested,created,starting,closing} from './fixtures/session-runtime-records.mjs';
import {legacyV2} from './fixtures/session-ledger-v2.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},DatabaseSync=sessionStoreSupported?createRequire(import.meta.url)('node:sqlite').DatabaseSync:null;
function edit(path,run){const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'rp-start-history-')),path=join(directory,'state.sqlite'),store=new SqliteSessionStore({path}),owner=Symbol('runtime'),batch=records();
 store.claimRuntimeProvider(owner,provider);store.commit(batch);const row=intent(batch);for(const r of [row,requested(row),created(row)])store.commitRuntime(r,{owner});
 const detach=()=>{try{store.releaseRuntimeProvider(owner);}catch{}store.close();};t.after(()=>{detach();return rm(directory,{recursive:true,force:true});});return {directory,path,store,owner,row,batch,detach};
}
test('durable Start fence is one-use, survives reopen and cannot be reverted or replayed by recovery owner',enabled,async t=>{
 const f=await fixture(t),before=f.store.loadRuntime({owner:f.owner}),receipt=f.store.commitRuntime(starting(f.row),{owner:f.owner});assert.equal(receipt.revision,before.revision+1);assert.equal(receipt.allocation.startDispatch,'requested');
 for(const row of [starting(f.row),created(f.row)])assert.throws(()=>f.store.commitRuntime(row,{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});
 const identity=f.store.identity();f.detach();const recovered=new SqliteSessionStore({path:f.path}),owner=Symbol('recovered');try{recovered.claimRuntimeProvider(owner,provider);assert.deepEqual(recovered.identity(),identity);assert.equal(recovered.loadRuntime({owner}).allocations[0].startDispatch,'requested');assert.throws(()=>recovered.commitRuntime(starting(f.row),{owner}),{code:'STATE_RUNTIME_RECOVERY_REQUIRED'});assert.throws(()=>recovered.commitRuntime({...closing(starting(f.row)),startDispatch:'not-requested'},{owner}),{code:'STATE_RUNTIME_CONFLICT'});recovered.commitRuntime(closing(starting(f.row)),{owner});}finally{recovered.releaseRuntimeProvider(owner);recovered.close();}
});
test('Start history cannot begin at allocation dispatch, after closure, or after the parent cancellation fence',enabled,async t=>{
 const f=await fixture(t),before=f.store.loadRuntime({owner:f.owner});assert.throws(()=>f.store.commitRuntime({...requested(f.row),startDispatch:'requested'},{owner:f.owner}),{code:'STATE_RUNTIME_INVALID'});assert.deepEqual(f.store.loadRuntime({owner:f.owner}),before);
 f.store.commit({sessions:[{...f.batch.sessions[0],state:'closing',closeReason:'released'}]});assert.throws(()=>f.store.commitRuntime(starting(f.row),{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});
 f.store.commitRuntime(closing(created(f.row)),{owner:f.owner});assert.throws(()=>f.store.commitRuntime({...closing(created(f.row)),startDispatch:'requested'},{owner:f.owner}),{code:'STATE_RUNTIME_CONFLICT'});
});
test('old v2 rows migrate atomically to unknown Start history without changing identity or either revision',enabled,async t=>{
 const f=await fixture(t),identity=f.store.identity(),before=f.store.loadRuntime({owner:f.owner});f.detach();edit(f.path,db=>legacyV2(db));
 const recovered=new SqliteSessionStore({path:f.path}),owner=Symbol('recovered');try{assert.deepEqual(recovered.identity(),identity);assert.equal(recovered.load().revision,1);recovered.claimRuntimeProvider(owner,provider);const state=recovered.loadRuntime({owner});assert.equal(state.revision,before.revision);assert.deepEqual(state.allocations,before.allocations.map(row=>({...row,startDispatch:'legacy-unknown'})));assert.throws(()=>recovered.commitRuntime({...closing(created(f.row)),startDispatch:'not-requested'},{owner}),{code:'STATE_RUNTIME_CONFLICT'});}finally{recovered.releaseRuntimeProvider(owner);recovered.close();}
 edit(f.path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='format'").get().value,'remote-paint-session-ledger-v4');});
});
test('invalid old runtime or index is rejected before any format, row or instance backfill changes',enabled,async t=>{
 for(const mode of ['body','index']){const f=await fixture(t);f.detach();edit(f.path,db=>{legacyV2(db,{withoutIdentity:true});if(mode==='body')db.prepare('UPDATE runtimes SET body=?').run('{broken');else db.prepare('UPDATE runtimes SET container_id=?').run('e'.repeat(64));});
  const before=edit(f.path,db=>db.prepare('SELECT * FROM runtimes').all());assert.throws(()=>new SqliteSessionStore({path:f.path}),{code:'STATE_CORRUPT'});edit(f.path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.deepEqual(db.prepare('SELECT * FROM runtimes').all(),before);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='instance_id'").get(),undefined);});
 }
});
test('current v4 ledger with missing identity fails instead of being relabeled as an older database',enabled,async t=>{
 const f=await fixture(t);f.detach();edit(f.path,db=>db.exec("DELETE FROM metadata WHERE name='instance_id'"));assert.throws(()=>new SqliteSessionStore({path:f.path}),{code:'STATE_IDENTITY'});edit(f.path,db=>assert.equal(db.prepare('PRAGMA user_version').get().user_version,4));
});
test('actual SIGKILL after first migrated row and before commit rolls back all format/history changes',enabled,async t=>{
 const f=await fixture(t),identity=f.store.identity();f.detach();edit(f.path,db=>legacyV2(db));const before=edit(f.path,db=>db.prepare('SELECT * FROM runtimes').all()),marker=join(f.directory,'migration.marker');let result;
 await withOwnedTestChild(()=>fork(new URL('./fixtures/runtime-start-migration-child.mjs',import.meta.url),[f.path,marker],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async child=>{result=await once(child,'close',{signal:AbortSignal.timeout(5000)});});
 assert.deepEqual(result,[null,'SIGKILL']);assert.equal(await readFile(marker,'utf8'),'row-written-before-commit\n');edit(f.path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.deepEqual(db.prepare('SELECT * FROM runtimes').all(),before);});const recovered=new SqliteSessionStore({path:f.path});try{assert.deepEqual(recovered.identity(),identity);assert.equal(recovered.load().sessions[0].reserved,true);}finally{recovered.close();}
});
