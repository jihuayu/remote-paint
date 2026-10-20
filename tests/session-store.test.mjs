import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {SqliteSessionStore,SessionStoreError,sessionStoreSupported} from '../service/session-store.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
import {records} from './fixtures/session-store-records.mjs';
const enabled={skip:!sessionStoreSupported},code=expected=>error=>error instanceof SessionStoreError&&error.code===expected;
async function directory(t){const path=await mkdtemp(join(tmpdir(),'remote-paint-session-ledger-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('atomic Session, operation and hashed binding survive closing and reopening the actual SQLite ledger',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite');let store=new SqliteSessionStore({path});const batch=records();assert.deepEqual(store.commit(batch),{revision:1});assert.deepEqual(store.load(),{revision:1,...batch});assert.equal((await stat(path)).mode&0o777,0o600);store.close();store.close();assert.throws(()=>store.load(),code('STATE_CLOSED'));
 store=new SqliteSessionStore({path});t.after(()=>store.close());assert.deepEqual(store.load(),{revision:1,...batch});assert.equal((await readFile(path)).includes(Buffer.from('https://')),false);
});

test('exclusive ownership survives commits and rejects a second live service owner until close',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());store.commit(records());assert.throws(()=>new SqliteSessionStore({path}),code('STATE_IN_USE'));store.commit({});assert.throws(()=>new SqliteSessionStore({path}),code('STATE_IN_USE'));store.close();const next=new SqliteSessionStore({path});t.after(()=>next.close());assert.equal(next.load().sessions.length,1);
});

test('foreign-key, tenant and capacity failures roll back the complete transaction',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path,maxSessions:1});t.after(()=>store.close());const a=records();store.commit(a);
 const invalid=records('b');invalid.operations[0].tenant='other';assert.throws(()=>store.commit(invalid),code('STATE_WRITE'));assert.deepEqual(store.load(),{revision:1,...a});
 assert.throws(()=>store.commit(records('b')),code('STATE_CAPACITY'));assert.deepEqual(store.load(),{revision:1,...a});
 const binding={...a.bindings[0],tenant:'other'};assert.throws(()=>store.commit({bindings:[binding]}),code('STATE_WRITE'));assert.deepEqual(store.load(),{revision:1,...a});
});

test('accepted keys, Session identity and terminal operation outcomes cannot be rewritten',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());const a=records();store.commit(a);
 assert.throws(()=>store.commit({bindings:[{...a.bindings[0],fingerprint:'c'.repeat(64)}]}),code('STATE_CONFLICT'));
 assert.throws(()=>store.commit({sessions:[{...a.sessions[0],region:'elsewhere'}]}),code('STATE_CONFLICT'));
 const done=structuredClone(a.operations[0]);done.operation.status='succeeded';const ready={...a.sessions[0],state:'ready',version:'fixture-v1',readyAt:a.sessions[0].createdAt,expiresAt:'2026-10-18T00:15:00.000Z'};store.commit({sessions:[ready],operations:[done]});assert.throws(()=>store.commit({operations:a.operations}),code('STATE_CONFLICT'));
 const ended={...ready,state:'closed',reserved:false,closeReason:'released'};store.commit({sessions:[ended]});assert.throws(()=>store.commit({sessions:a.sessions}),code('STATE_CONFLICT'));assert.equal(store.load().sessions[0].state,'closed');
});

test('invalid metadata and existing empty or foreign databases fail closed without inventing a new ledger',enabled,async t=>{
 const dir=await directory(t),empty=join(dir,'empty.sqlite');await writeFile(empty,'',{mode:0o600});assert.throws(()=>new SqliteSessionStore({path:empty}),code('STATE_SCHEMA'));assert.equal((await readFile(empty)).length,0);
 const path=join(dir,'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());const bad=records();bad.sessions[0].source={private:'handle'};assert.throws(()=>store.commit(bad),code('STATE_INVALID'));assert.deepEqual(store.load(),{revision:0,sessions:[],operations:[],bindings:[]});
 let read=0;const accessor=records();Object.defineProperty(accessor.sessions[0],'version',{get(){read++;return 'secret';},enumerable:true});assert.throws(()=>store.commit(accessor),code('STATE_INVALID'));assert.equal(read,0);
 assert.throws(()=>store.commit({sessions:Array(1001).fill(records().sessions[0])}),code('STATE_BATCH_LIMIT'));
 const foreign=join(dir,'foreign.sqlite'),{DatabaseSync}=createRequire(import.meta.url)('node:sqlite');const db=new DatabaseSync(foreign);db.exec('CREATE TABLE unrelated(secret TEXT)');db.close();await chmod(foreign,0o600);const before=await readFile(foreign);assert.throws(()=>new SqliteSessionStore({path:foreign}),code('STATE_SCHEMA'));assert.deepEqual(await readFile(foreign),before);
});

test('stored corruption, schema loss and unexpected private-file permissions are rejected',enabled,async t=>{
 const dir=await directory(t),path=join(dir,'state.sqlite');let store=new SqliteSessionStore({path});store.commit(records());store.close();const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');let db=new DatabaseSync(path);db.prepare('UPDATE sessions SET body=?').run('{broken');db.close();store=new SqliteSessionStore({path});assert.throws(()=>store.load(),code('STATE_CORRUPT'));store.close();
 db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=OFF;DROP TABLE bindings;DROP TABLE operations;DROP TABLE sessions;DROP TABLE metadata');db.close();assert.throws(()=>new SqliteSessionStore({path}),code('STATE_SCHEMA'));
 const insecure=join(dir,'insecure.sqlite');await writeFile(insecure,'',{mode:0o600});await chmod(insecure,0o644);assert.throws(()=>new SqliteSessionStore({path:insecure}),code('STATE_PERMISSIONS'));
});

async function crashChild(path,mode,event,onLive=()=>{}){
 let owned;
 const fixture=fileURLToPath(new URL('./fixtures/session-store-child.mjs',import.meta.url));
 await withOwnedTestChild(()=>{owned=fork(fixture,[path,mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});return owned;},async child=>{
  const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,event);onLive();
 });
 assert.equal(owned.signalCode,'SIGKILL');assert.equal(owned.connected,false);
}
test('committed intent survives actual writer SIGKILL and its file lock is released',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite');await crashChild(path,'commit','committed',()=>assert.throws(()=>new SqliteSessionStore({path}),code('STATE_IN_USE')));const store=new SqliteSessionStore({path});t.after(()=>store.close());assert.deepEqual(store.load(),{revision:1,...records()});
});

test('an actual killed writer cannot expose its uncommitted Session update',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),initial=new SqliteSessionStore({path});initial.commit(records());initial.close();await crashChild(path,'uncommitted','uncommitted');const recovered=new SqliteSessionStore({path});t.after(()=>recovered.close());assert.deepEqual(recovered.load(),{revision:1,...records()});
});


test('a transaction cannot publish ready metadata without the matching successful creation operation',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());const a=records();store.commit(a);
 const ready={...a.sessions[0],state:'ready',version:'fixture-v1',readyAt:a.sessions[0].createdAt,expiresAt:'2026-10-18T00:15:00.000Z'};
 assert.throws(()=>store.commit({sessions:[ready]}),code('STATE_REFERENCE'));assert.deepEqual(store.load(),{revision:1,...a});
 const binding={...a.bindings[0],keyHash:'d'.repeat(64),defaults:{region:'elsewhere',ttlSeconds:900}};assert.throws(()=>store.commit({bindings:[binding]}),code('STATE_REFERENCE'));assert.deepEqual(store.load(),{revision:1,...a});
});

test('Session operation pointers and hashed bindings must reference the same tenant and Session',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());const a=records();a.operations[0].operation.operationId='different-operation';a.bindings[0].operationId='different-operation';
 assert.throws(()=>store.commit(a),code('STATE_REFERENCE'));assert.deepEqual(store.load(),{revision:0,sessions:[],operations:[],bindings:[]});
});

test('a Session without its original creation binding cannot be committed or loaded',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite');let store=new SqliteSessionStore({path});const batch=records();assert.throws(()=>store.commit({sessions:batch.sessions,operations:batch.operations}),code('STATE_REFERENCE'));assert.equal(store.load().sessions.length,0);store.commit(batch);store.close();const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),db=new DatabaseSync(path);db.exec('DELETE FROM bindings');db.close();store=new SqliteSessionStore({path});assert.throws(()=>store.load(),code('STATE_CORRUPT'));store.close();
});

test('Registry claim tokens prevent concurrent, stale or ownerless mutations',enabled,async t=>{
 const path=join(await directory(t),'state.sqlite'),store=new SqliteSessionStore({path});t.after(()=>store.close());const owner=Symbol('one'),other=Symbol('two');store.claimRegistry(owner);assert.throws(()=>store.claimRegistry(other),code('STATE_IN_USE'));assert.throws(()=>store.load(),code('STATE_IN_USE'));assert.throws(()=>store.commit(records()),code('STATE_IN_USE'));assert.throws(()=>store.close(),code('STATE_IN_USE'));store.commit(records(),{owner});store.releaseRegistry(owner);assert.throws(()=>store.commit({}, {owner}),code('STATE_IN_USE'));assert.equal(store.load().sessions.length,1);
});
