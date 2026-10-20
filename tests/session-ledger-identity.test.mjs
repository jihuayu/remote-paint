import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,copyFile,rename,chmod,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {SqliteSessionStore,SessionStoreError,sessionStoreSupported} from '../service/session-store.mjs';
import {records} from './fixtures/session-store-records.mjs';
import {provider,intent,requested} from './fixtures/session-runtime-records.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=value=>e=>e instanceof SessionStoreError&&e.code===value;
const DatabaseSync=sessionStoreSupported?createRequire(import.meta.url)('node:sqlite').DatabaseSync:null;
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'rp-ledger-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,path:join(directory,'state.sqlite')};}
function edit(path,action){const db=new DatabaseSync(path);try{return action(db);}finally{db.close();}}
async function legacy(path,{corrupt=false}={}){await writeFile(path,'',{flag:'wx',mode:0o600});const batch=records();edit(path,db=>{db.exec(requireSql);for(const row of batch.sessions)db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(row.sessionId,row.tenant,corrupt?'{broken':JSON.stringify(row));for(const row of batch.operations)db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(row.operation.operationId,row.operation.sessionId,row.tenant,JSON.stringify(row));for(const row of batch.bindings)db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(row.tenant,row.keyHash,row.operationId,JSON.stringify(row));});return batch;}
const requireSql=await readFile(new URL('./fixtures/session-ledger-v1.sql',import.meta.url),'utf8');
test('new durable instance identity is immutable,lossless and stable across commits and real reopen',enabled,async t=>{
 const {path}=await fixture(t);let store=new SqliteSessionStore({path});const id=store.identity();assert.match(id.instanceId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.deepEqual(Object.keys(id).sort(),['file','instanceId','schema']);assert.equal(id.schema,'session-ledger-instance-v1');assert.match(id.file.device,/^[0-9]+$/);assert.match(id.file.inode,/^[1-9][0-9]*$/);assert.ok(Object.isFrozen(id)&&Object.isFrozen(id.file));assert.ok(!JSON.stringify(id).includes(path));store.commit(records());assert.deepEqual(store.identity(),id);store.close();assert.throws(()=>store.identity(),code('STATE_CLOSED'));
 store=new SqliteSessionStore({path});try{assert.deepEqual(store.identity(),id);assert.deepEqual(store.load(),{revision:1,...records()});}finally{store.close();}
});
test('a byte-copied ledger retains UUID but cannot borrow the original private file identity',enabled,async t=>{
 const {path,directory}=await fixture(t),store=new SqliteSessionStore({path});store.commit(records());const id=store.identity();store.close();const copied=join(directory,'copy.sqlite');await copyFile(path,copied);const other=new SqliteSessionStore({path:copied});try{assert.equal(other.identity().instanceId,id.instanceId);assert.notDeepEqual(other.identity().file,id.file);assert.deepEqual(other.load(),{revision:1,...records()});}finally{other.close();}
});
test('a deleted and recreated empty ledger has a fresh instance rather than the old deployment identity',enabled,async t=>{
 const {path}=await fixture(t),store=new SqliteSessionStore({path});const id=store.identity();store.close();await rm(path);const next=new SqliteSessionStore({path});try{assert.notEqual(next.identity().instanceId,id.instanceId);assert.equal(next.load().sessions.length,0);}finally{next.close();}
});
test('v1 migration initializes identity atomically while preserving Session data and both revisions',enabled,async t=>{
 const {path}=await fixture(t),batch=await legacy(path);let store=new SqliteSessionStore({path});const id=store.identity();assert.deepEqual(store.load(),{revision:1,...batch});store.close();edit(path,db=>{assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(db.prepare("SELECT value FROM metadata WHERE name='revision'").get().value,'1');assert.equal(db.prepare("SELECT value FROM metadata WHERE name='runtime_revision'").get().value,'0');assert.equal(db.prepare("SELECT value FROM metadata WHERE name='instance_id'").get().value,id.instanceId);});store=new SqliteSessionStore({path});try{assert.deepEqual(store.identity(),id);}finally{store.close();}
});
test('older v2 identity backfill preserves unknown dispatched ownership and enforces close-only recovery',enabled,async t=>{
 const {path}=await fixture(t),store=new SqliteSessionStore({path}),owner=Symbol('before'),batch=records();store.claimRuntimeProvider(owner,provider);store.commit(batch);const row=intent(batch);store.commitRuntime(row,{owner});store.commitRuntime(requested(row),{owner});const before=store.loadRuntime({owner}),oldId=store.identity();store.releaseRuntimeProvider(owner);store.close();edit(path,db=>db.exec("DELETE FROM metadata WHERE name='instance_id'"));const recovered=new SqliteSessionStore({path}),next=Symbol('recovered');try{assert.notEqual(recovered.identity().instanceId,oldId.instanceId);assert.deepEqual(recovered.identity().file,oldId.file);assert.deepEqual(recovered.load(),{revision:1,...batch});recovered.claimRuntimeProvider(next,provider);const value=recovered.loadRuntime({owner:next});assert.equal(value.revision,before.revision);assert.deepEqual(value.allocations,before.allocations);assert.deepEqual(value.recoveryRequired,[row.sessionId]);assert.throws(()=>recovered.commitRuntime(requested(row),{owner:next}),code('STATE_RUNTIME_RECOVERY_REQUIRED'));}finally{recovered.releaseRuntimeProvider(next);recovered.close();}
});
test('corrupt older v2 records are rejected before identity backfill without dropping ownership',enabled,async t=>{
 const {path}=await fixture(t),store=new SqliteSessionStore({path});store.commit(records());store.close();edit(path,db=>{db.exec("DELETE FROM metadata WHERE name='instance_id'");db.prepare('UPDATE sessions SET body=?').run('{broken');});assert.throws(()=>new SqliteSessionStore({path}),code('STATE_CORRUPT'));edit(path,db=>{assert.equal(db.prepare("SELECT value FROM metadata WHERE name='instance_id'").get(),undefined);assert.equal(db.prepare('SELECT body FROM sessions').get().body,'{broken');assert.equal(db.prepare("SELECT value FROM metadata WHERE name='revision'").get().value,'1');});
});
test('corrupt older v2 runtime indexes cannot acquire a freshly backfilled instance ID',enabled,async t=>{
 const {path}=await fixture(t),store=new SqliteSessionStore({path}),owner=Symbol('before'),batch=records();store.claimRuntimeProvider(owner,provider);store.commit(batch);store.commitRuntime(intent(batch),{owner});store.releaseRuntimeProvider(owner);store.close();edit(path,db=>{db.exec("DELETE FROM metadata WHERE name='instance_id'");db.prepare('UPDATE runtimes SET container_name=?').run('wrong-index');});assert.throws(()=>new SqliteSessionStore({path}),code('STATE_CORRUPT'));edit(path,db=>{assert.equal(db.prepare("SELECT value FROM metadata WHERE name='instance_id'").get(),undefined);assert.equal(db.prepare('SELECT container_name FROM runtimes').get().container_name,'wrong-index');assert.equal(JSON.parse(db.prepare('SELECT body FROM sessions').get().body).reserved,true);});
});
test('malformed persisted IDs fail without inventing a replacement instance',enabled,async t=>{
 const {path}=await fixture(t),store=new SqliteSessionStore({path});store.close();for(const value of ['', 'private-invalid-uuid','00000000-0000-0000-0000-000000000000']){edit(path,db=>db.prepare("UPDATE metadata SET value=? WHERE name='instance_id'").run(value));assert.throws(()=>new SqliteSessionStore({path}),code('STATE_IDENTITY'));edit(path,db=>assert.equal(db.prepare("SELECT value FROM metadata WHERE name='instance_id'").get().value,value));}
});
test('live path replacement fences all data operations while valid owners can release and close the old handle',enabled,async t=>{
 const {path,directory}=await fixture(t),store=new SqliteSessionStore({path}),runtimeOwner=Symbol('runtime'),registryOwner=Symbol('registry');store.claimRuntimeProvider(runtimeOwner,provider);store.claimRegistry(registryOwner);const id=store.identity();await rename(path,join(directory,'original.sqlite'));await copyFile(join(directory,'original.sqlite'),path);
 for(const call of [()=>store.identity(),()=>store.load({owner:registryOwner}),()=>store.commit({}, {owner:registryOwner}),()=>store.loadRuntime({owner:runtimeOwner}),()=>store.claimRegistry(registryOwner)])assert.throws(call,code('STATE_IDENTITY'));
 store.releaseRuntimeProvider(runtimeOwner);store.releaseRegistry(registryOwner);store.close();const copied=new SqliteSessionStore({path});try{assert.equal(copied.identity().instanceId,id.instanceId);assert.notDeepEqual(copied.identity().file,id.file);}finally{copied.close();}
});
test('identity faults stay fenced after the original file is restored until the owner explicitly closes',enabled,async t=>{
 const {path,directory}=await fixture(t),store=new SqliteSessionStore({path}),id=store.identity(),saved=join(directory,'original.sqlite');await rename(path,saved);assert.throws(()=>store.identity(),code('STATE_IDENTITY'));await rename(saved,path);assert.throws(()=>store.identity(),code('STATE_IDENTITY'));store.close();const next=new SqliteSessionStore({path});try{assert.deepEqual(next.identity(),id);}finally{next.close();}
});
test('nonprivate permissions,hardlink aliases and symlink replacement are detected on the live handle',enabled,async t=>{
 for(const mode of ['permissions','hardlink','symlink']){const {path,directory}=await fixture(t),store=new SqliteSessionStore({path});try{if(mode==='permissions')await chmod(path,0o644);else if(mode==='hardlink')await link(path,join(directory,'alias.sqlite'));else{const original=join(directory,'original.sqlite');await rename(path,original);await symlink(original,path);}assert.throws(()=>store.identity(),code('STATE_IDENTITY'));assert.throws(()=>store.commit(records()),code('STATE_IDENTITY'));}finally{store.close();}}
});
async function killedIdentity(path,mode){let child,message;await withOwnedTestChild(()=>child=fork(new URL('./fixtures/session-ledger-identity-child.mjs',import.meta.url),[path,mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async owned=>{[message]=await once(owned,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,'identity-acknowledged');assert.throws(()=>new SqliteSessionStore({path}),code('STATE_IN_USE'));});assert.equal(child.signalCode,'SIGKILL');return message;}
test('actual writer SIGKILL after committed intent preserves the acknowledged instance on restart',enabled,async t=>{
 const {path}=await fixture(t),message=await killedIdentity(path,'commit'),store=new SqliteSessionStore({path});try{assert.deepEqual(store.identity(),message.identity);assert.equal(message.revision,1);assert.deepEqual(store.load(),{revision:1,...records()});}finally{store.close();}
});
test('actual writer SIGKILL after older v2 backfill does not mint another identity on recovery',enabled,async t=>{
 const {path}=await fixture(t),initial=new SqliteSessionStore({path});initial.commit(records());initial.close();edit(path,db=>db.exec("DELETE FROM metadata WHERE name='instance_id'"));const message=await killedIdentity(path,'inspect'),store=new SqliteSessionStore({path});try{assert.deepEqual(store.identity(),message.identity);assert.equal(store.load().revision,1);}finally{store.close();}
});
