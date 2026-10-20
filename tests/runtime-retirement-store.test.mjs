import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,chmod,mkdir,symlink,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fork,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {RuntimeRetirementStore,RuntimeRetirementStoreError,RUNTIME_RETIREMENT_MAX_BYTES} from '../service/runtime-retirement-store.mjs';
import {RuntimeWitnessStore} from '../service/runtime-witness-store.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
import {retirement} from './fixtures/runtime-retirement-records.mjs';
import {witness} from './fixtures/runtime-witness-records.mjs';
const code=value=>error=>error instanceof RuntimeRetirementStoreError&&error.code===value,sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x);
async function fixture(t,{namespace=false,...options}={}){
 const parent=await mkdtemp(join(tmpdir(),'rp-retirement-')),directory=join(parent,'retirement'),facts=retirement(options);t.after(()=>rm(parent,{recursive:true,force:true}));let witnessStore=null;
 if(namespace){witnessStore=new RuntimeWitnessStore({directory:join(parent,'namespace')});witnessStore.persist({...facts,witness:witness()});}
 return {parent,directory,...facts,witnessStore,store:new RuntimeRetirementStore({directory,witnessStore})};
}
const file=f=>join(f.directory,f.plan.sessionId+'-'+(f.closing.allocation.containerId??'not-dispatched')+'.retirement.json');
const read=f=>({plan:f.plan,containerId:f.closing.allocation.containerId});
test('an acknowledged undispatched closing fence persists privately and can be adopted before journalretired',async t=>{
 const f=await fixture(t,{requested:false}),receipt=f.store.persistNotDispatched(f),bytes=await readFile(file(f));assert.equal(receipt.kind,'not-dispatched');assert.equal(receipt.containerId,null);assert.equal(receipt.evidenceSha256,sha(bytes));assert.ok(Object.isFrozen(receipt));assert.equal((await readdir(f.directory)).length,1);
 const recovered=new RuntimeRetirementStore({directory:f.directory}).read({...read(f),expectedSha256:receipt.evidenceSha256});assert.deepEqual(recovered.receipt,receipt);assert.equal(recovered.record.proof.origin,'not-dispatched');assert.ok(Object.isFrozen(recovered.record.proof));assert.deepEqual(f.store.read(read(f)).receipt,receipt);
});
test('created never-started metadata requires an explicit local Start fence and fullID204/fresh404',async t=>{
 const f=await fixture(t,{unstarted:true});f.closing.allocation.version='private-version-url';const receipt=f.store.persistRemoved(f),recovered=f.store.read({...read(f),expectedSha256:receipt.evidenceSha256});assert.equal(receipt.kind,'container-removed');assert.equal(recovered.record.proof.origin,'unstarted');assert.equal(recovered.record.proof.startDispatched,false);assert.ok(!(await readFile(file(f),'utf8')).includes('private-version-url'));
});
test('a started or recovered unknown Start uses the persisted generation-bound effective namespace witness',async t=>{
 const f=await fixture(t,{namespace:true});f.startDispatched=null;const receipt=f.store.persistRemoved(f);await rm(join(f.parent,'namespace'),{recursive:true});const fresh=new RuntimeRetirementStore({directory:f.directory}),saved=fresh.read({...read(f),expectedSha256:receipt.evidenceSha256});assert.deepEqual(saved.receipt,receipt);assert.equal(saved.record.proof.origin,'namespace');assert.equal(saved.record.proof.namespace.record.witness.self.pid,7);assert.equal(saved.record.proof.namespace.record.identity.engineStartedAt,f.inspection.document.State.StartedAt);
});
test('unknown allocation cannot retire from empty inventory,404 or an undispatched claim',async t=>{
 const f=await fixture(t);for(const edit of [v=>v.closing.allocation.containerId=null,v=>v.closing.allocation.requestStarted=false,v=>v.closing.allocation.state='requested',v=>v.closing.revision=0]){const value=structuredClone(retirement());edit(value);assert.throws(()=>f.store.persistRemoved(value),code('RETIREMENT_JOURNAL'));}assert.throws(()=>f.store.persistNotDispatched(f),code('RETIREMENT_JOURNAL'));assert.equal((await readdir(f.directory)).length,0);
});
test('wrong closing identity,owner,version or nonclosing receipt never publishes a file',async t=>{
 const f=await fixture(t,{requested:false});for(const edit of [v=>v.closing.allocation.ownerKeyHash='0'.repeat(64),v=>v.closing.allocation.tenant='other',v=>v.closing.allocation.specDigest='0'.repeat(64),v=>v.closing.allocation.state='intent',v=>v.closing.allocation.version='late-ready',v=>v.closing.allocation.ownerKey='private-owner']){const value=retirement({requested:false});edit(value);assert.throws(()=>f.store.persistNotDispatched(value),code('RETIREMENT_JOURNAL'));}assert.equal((await readdir(f.directory)).length,0);
});
test('removal receipt and absence must bind the same fullCID,daemon,authorization and204 effect',async t=>{
 const f=await fixture(t,{unstarted:true});for(const edit of [v=>v.removal.containerId='0'.repeat(64),v=>v.removal.daemonId='other',v=>v.removal.httpStatus=404,v=>v.removal.alreadyAbsent=true,v=>v.removal.effectAttempted=false,v=>v.removal.authorizationRevision++,v=>v.absence.found=true,v=>v.absence.selector=v.plan.containerName,v=>v.absence.daemon.id='other',v=>v.inspection.document.State.Status='running']){const value=retirement({unstarted:true});edit(value);assert.throws(()=>f.store.persistRemoved(value),code('RETIREMENT_REMOVAL'));}assert.equal((await readdir(f.directory)).length,0);
});
test('a boolean never-started claim cannot cover a running,previously started or unknown runtime',async t=>{
 const f=await fixture(t);assert.throws(()=>f.store.persistRemoved({...f,startDispatched:false}),code('RETIREMENT_UNSTARTED'));const created=retirement({unstarted:true});assert.throws(()=>f.store.persistRemoved({...created,startDispatched:null}),code('RETIREMENT_NAMESPACE'));created.inspection.document.State.StartedAt='2026-10-19T00:00:01.000Z';assert.throws(()=>f.store.persistRemoved(created),code('RETIREMENT_UNSTARTED'));assert.equal((await readdir(f.directory)).length,0);
});
test('a restarted sameCID or changed namespace identity cannot borrow earlier evidence',async t=>{
 const f=await fixture(t,{namespace:true}),changed=structuredClone(retirement());changed.inspection.document.State.StartedAt='2026-10-19T00:00:01.000Z';assert.throws(()=>f.store.persistRemoved(changed));assert.equal((await readdir(f.directory)).length,0);
});
test('publication is immutable and duplicate persistence cannot alter acknowledged bytes',async t=>{
 const f=await fixture(t,{unstarted:true}),receipt=f.store.persistRemoved(f),bytes=await readFile(file(f));assert.throws(()=>f.store.persistRemoved(f),code('RETIREMENT_EXISTS'));assert.deepEqual(await readFile(file(f)),bytes);assert.deepEqual(f.store.read(read(f)).receipt,receipt);assert.equal((await readdir(f.directory)).length,1);
});
test('missing,pending,oversize,invalidUTF8 and partial committed files never become evidence',async t=>{
 const f=await fixture(t,{requested:false});await writeFile(join(f.directory,'.pending-dead-writer'),'{',{mode:0o600});assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_MISSING'));f.store.persistNotDispatched(f);
 for(const bytes of [Buffer.from('{'),Buffer.from([255]),Buffer.alloc(RUNTIME_RETIREMENT_MAX_BYTES+1)]){await writeFile(file(f),bytes);assert.throws(()=>f.store.read(read(f)),RuntimeRetirementStoreError);}
});
test('external bytes hash and embedded proof digest detect changed committed evidence',async t=>{
 const f=await fixture(t,{unstarted:true}),receipt=f.store.persistRemoved(f),record=JSON.parse(await readFile(file(f)));record.proof.beforeRemoval.inspectionSha256='0'.repeat(64);await writeFile(file(f),JSON.stringify(record));assert.throws(()=>f.store.read({...read(f),expectedSha256:receipt.evidenceSha256}),code('RETIREMENT_DIGEST'));assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_DIGEST'));
 record.proofSha256=sha(stable(record.proof));record.proof.absence.selector='short';record.proofSha256=sha(stable(record.proof));await writeFile(file(f),JSON.stringify(record));assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_REMOVAL'));
});
test('read rejects a different plan,CID or expected digest even with a structurally valid file',async t=>{
 const f=await fixture(t,{unstarted:true});f.store.persistRemoved(f);const other=structuredClone(f.plan);other.deploymentId='other';assert.throws(()=>f.store.read({plan:other,containerId:f.closing.allocation.containerId}));assert.throws(()=>f.store.read({plan:f.plan,containerId:'0'.repeat(64)}),code('RETIREMENT_MISSING'));assert.throws(()=>f.store.read({...read(f),expectedSha256:'invalid'}),code('RETIREMENT_DIGEST'));
});
test('private directories/files,symlinks and replaced directory identities are enforced on every operation',async t=>{
 const f=await fixture(t,{requested:false});assert.throws(()=>new RuntimeRetirementStore({directory:'relative'}),TypeError);await mkdir(join(f.parent,'public'),{mode:0o755});assert.throws(()=>new RuntimeRetirementStore({directory:join(f.parent,'public')}),code('RETIREMENT_DIRECTORY'));await symlink(f.directory,join(f.parent,'alias'));assert.throws(()=>new RuntimeRetirementStore({directory:join(f.parent,'alias')}),code('RETIREMENT_DIRECTORY'));
 f.store.persistNotDispatched(f);const bytes=await readFile(file(f));await chmod(file(f),0o644);assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_FILE'));await rm(file(f));await writeFile(join(f.parent,'elsewhere'),bytes,{mode:0o600});await symlink(join(f.parent,'elsewhere'),file(f));assert.throws(()=>f.store.read(read(f)),RuntimeRetirementStoreError);
 await rename(f.directory,join(f.parent,'original'));await mkdir(f.directory,{mode:0o700});assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_DIRECTORY'));assert.throws(()=>f.store.persistNotDispatched(f),code('RETIREMENT_DIRECTORY'));
});
test('FIFO evidence paths fail without blocking the reader',async t=>{
 const f=await fixture(t,{requested:false});assert.equal(spawnSync('mkfifo',[file(f)]).status,0);assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_FILE'));
});
test('a restrictive child umask cannot publish an acknowledged non0600 file',async t=>{
 const f=await fixture(t,{requested:false});await withOwnedTestChild(()=>fork(new URL('./fixtures/runtime-retirement-store-child.mjs',import.meta.url),[f.directory,'restrictive-umask'],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async owned=>{const [message]=await once(owned,'message',{signal:AbortSignal.timeout(5000)});assert.deepEqual(message,{event:'rejected',code:'RETIREMENT_FILE'});});assert.equal((await readdir(f.directory)).length,0);assert.throws(()=>f.store.read(read(f)),code('RETIREMENT_MISSING'));
});
test('an actual writer killed after acknowledged persistence is recoverable without a journalretired hash',async t=>{
 const f=await fixture(t,{requested:false});let receipt,child;await withOwnedTestChild(()=>child=fork(new URL('./fixtures/runtime-retirement-store-child.mjs',import.meta.url),[f.directory],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async owned=>{const [message]=await once(owned,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,'persisted');receipt=message.receipt;});assert.equal(child.signalCode,'SIGKILL');assert.deepEqual(new RuntimeRetirementStore({directory:f.directory}).read(read(f)).receipt,receipt);
});
test('actual SIGKILL after link publication before its directory sync leaves an adoptable fsynced file',async t=>{
 const f=await fixture(t,{requested:false});let child;await withOwnedTestChild(()=>child=fork(new URL('./fixtures/runtime-retirement-store-child.mjs',import.meta.url),[f.directory,'kill-after-link'],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),async owned=>{const [exit,signal]=await once(owned,'close',{signal:AbortSignal.timeout(5000)});assert.equal(exit,null);assert.equal(signal,'SIGKILL');});assert.equal(child.signalCode,'SIGKILL');const recovered=new RuntimeRetirementStore({directory:f.directory}).read(read(f));assert.equal(recovered.receipt.kind,'not-dispatched');assert.equal(recovered.receipt.evidenceSha256,sha(await readFile(file(f))));assert.ok((await readdir(f.directory)).some(name=>name.startsWith('.pending-')));
});
