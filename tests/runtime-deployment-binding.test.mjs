import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readdir,readFile,writeFile,copyFile,rename,chmod,symlink,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fork,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {RuntimeDeploymentBindingStore,RuntimeDeploymentBindingError,RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES} from '../service/runtime-deployment-binding.mjs';
import {SqliteSessionStore,sessionStoreSupported} from '../service/session-store.mjs';
import {DockerMetadataClient} from '../service/docker-metadata-client.mjs';
import {deployment} from './fixtures/runtime-deployment-records.mjs';
import {records} from './fixtures/session-store-records.mjs';
import {provider,intent,requested} from './fixtures/session-runtime-records.mjs';
import {withOwnedTestChild} from './owned-test-child.mjs';
const enabled={skip:!sessionStoreSupported},code=value=>e=>e instanceof RuntimeDeploymentBindingError&&e.code===value,sha=x=>createHash('sha256').update(x).digest('hex'),prefix='org.remote-paint.runtime.';
const send=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
async function fixture(t,{handler,daemonId='daemon-fixture'}={}){
 const parent=await mkdtemp(join(tmpdir(),'rp-deployment-')),directory=join(parent,'binding'),path=join(parent,'state.sqlite'),socketPath=join(parent,'engine.sock'),seen=[],sockets=new Set();let store=new SqliteSessionStore({path});
 const server=createServer((req,res)=>{seen.push({method:req.method,url:req.url});if(handler)handler(req,res,seen);else send(res,req.url.endsWith('/info')?{ID:daemonId,OSType:'linux',Architecture:'arm64'}:[]);});server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});await new Promise(resolve=>server.listen(socketPath,resolve));const metadata=new DockerMetadataClient({socketPath,daemonId,timeoutMs:1000});
 t.after(async()=>{await metadata.close();store.close();for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));await rm(parent,{recursive:true,force:true});});return {parent,directory,path,socketPath,metadata,seen,get store(){return store;},replaceStore(next){store=next;},configuration:deployment()};
}
const file=f=>join(f.directory,sha(f.configuration.region)+'.deployment.json');
const bootstrap=f=>RuntimeDeploymentBindingStore.bootstrap(f),open=f=>new RuntimeDeploymentBindingStore({directory:f.directory}).open(f);
const boundProvider=f=>({region:f.configuration.region,deploymentId:f.configuration.deploymentId,daemonId:f.configuration.daemonId,createdAt:provider.createdAt});
test('explicit bootstrap persists a private immutable config/ledger binding;resume performs no Engine request',enabled,async t=>{
 const f=await fixture(t),first=await bootstrap(f),bytes=await readFile(file(f));assert.equal(first.receipt.fileSha256,sha(bytes));assert.deepEqual(first.record.binding.ledger,f.store.identity());assert.ok(Object.isFrozen(first.record.binding.ledger.file));assert.equal((await stat(file(f))).mode&0o777,0o600);assert.equal((await stat(f.directory)).mode&0o777,0o700);assert.deepEqual(open(f),first);assert.equal(f.seen.length,3);assert.ok(f.seen.every(x=>x.method==='GET'));f.store.close();f.replaceStore(new SqliteSessionStore({path:f.path}));assert.deepEqual(open(f),first);
});
test('ordinary resume never creates a missing directory,binding or pending file',enabled,async t=>{
 const f=await fixture(t);assert.throws(()=>open(f),code('DEPLOYMENT_DIRECTORY'));await assert.rejects(stat(f.directory),e=>e.code==='ENOENT');await mkdir(f.directory,{mode:0o700});assert.throws(()=>open(f),code('DEPLOYMENT_MISSING'));assert.deepEqual(await readdir(f.directory),[]);assert.equal(f.seen.length,0);
});
test('a second bootstrap cannot overwrite acknowledged bytes or silently act as resume',enabled,async t=>{
 const f=await fixture(t),first=await bootstrap(f),bytes=await readFile(file(f)),seen=f.seen.length;await assert.rejects(bootstrap(f),code('DEPLOYMENT_EXISTS'));assert.deepEqual(await readFile(file(f)),bytes);assert.deepEqual(open(f),first);assert.equal(f.seen.length,seen);
});
test('copied,recreated and UUID-backfilled ledgers cannot borrow the original deployment binding',enabled,async t=>{
 for(const mode of ['copied','recreated','backfilled']){const f=await fixture(t),first=await bootstrap(f);f.store.close();const original=join(f.parent,'original.sqlite');await rename(f.path,original);if(mode!=='recreated')await copyFile(original,f.path);if(mode==='backfilled'){const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite'),db=new DatabaseSync(f.path);db.exec("DELETE FROM metadata WHERE name='instance_id'");db.close();}f.replaceStore(new SqliteSessionStore({path:f.path}));assert.throws(()=>open(f),code('DEPLOYMENT_BINDING'));assert.equal(f.seen.length,3);assert.equal(first.receipt.ledger.instanceId,JSON.parse(await readFile(file(f))).binding.ledger.instanceId);}
});
test('configuration drift in engine,image,sources,paths,environment or worker entry is rejected on resume',enabled,async t=>{
 const f=await fixture(t);await bootstrap(f);for(const change of [{daemonId:'other'},{deploymentId:'other'},{imageId:'sha256:'+'f'.repeat(64)},{projectManifestSha256:'f'.repeat(64)},{browserManifestSha256:'f'.repeat(64)},{projectPath:'/other/project'},{browserPath:'/other/browser'},{imageEnvironment:['PATH=/other/bin']},{workerEntry:'other.mjs'}])assert.throws(()=>open({...f,configuration:{...f.configuration,...change}}),code('DEPLOYMENT_BINDING'));assert.equal(f.seen.length,3);
});
test('private environment values and paths are hashed rather than persisted as credentials',enabled,async t=>{
 const f=await fixture(t);f.configuration.imageEnvironment.push('PRIVATE_EXAMPLE=private-fixture-secret');f.configuration.projectPath='/private-fixture-project';await bootstrap(f);const bytes=await readFile(file(f),'utf8');assert.ok(!bytes.includes('private-fixture-secret')&&!bytes.includes('/private-fixture-project')&&!bytes.includes('imageEnvironment'));assert.deepEqual(open(f).record.binding.ledger,f.store.identity());
});
test('owned candidates block explicit initialization and cannot be hidden by an empty journal',enabled,async t=>{
 const config=deployment(),candidate={Id:'a'.repeat(64),Labels:{[prefix+'deployment']:config.deploymentId,[prefix+'region']:config.region,[prefix+'schema']:'session-runtime-v1',[prefix+'daemon']:config.daemonId}};
 const f=await fixture(t,{handler:(req,res)=>send(res,req.url.endsWith('/info')?{ID:config.daemonId,OSType:'linux',Architecture:'arm64'}:[candidate])});await assert.rejects(bootstrap(f),code('DEPLOYMENT_ORPHANS'));assert.equal(f.store.load().sessions.length,0);assert.deepEqual(await readdir(f.directory),[]);const owner=Symbol('next');f.store.claimRuntimeProvider(owner,boundProvider(f));f.store.releaseRuntimeProvider(owner);
});
test('target-region Session history and unknown dispatched rows block initialization before inventory',enabled,async t=>{
 for(const runtime of [false,true]){const f=await fixture(t),batch=records(),owner=Symbol('old');if(runtime)f.store.claimRuntimeProvider(owner,provider);f.store.commit(batch);if(runtime){const row=intent(batch);f.store.commitRuntime(row,{owner});f.store.commitRuntime(requested(row),{owner});f.store.releaseRuntimeProvider(owner);}await assert.rejects(bootstrap(f),code('DEPLOYMENT_NOT_EMPTY'));assert.equal(f.seen.length,0);assert.deepEqual(await readdir(f.directory),[]);assert.equal(f.store.load().sessions[0].reserved,true);}
});
test('bootstrap rechecks target Session history after inventory and releases its temporary owner',enabled,async t=>{
 let f;f=await fixture(t,{handler:(req,res)=>{if(req.url.includes('/containers/json')){f.store.commit(records());send(res,[]);}else send(res,{ID:'daemon-fixture',OSType:'linux',Architecture:'arm64'});}});await assert.rejects(bootstrap(f),code('DEPLOYMENT_NOT_EMPTY'));assert.deepEqual(await readdir(f.directory),[]);const owner=Symbol('released');f.store.claimRuntimeProvider(owner,boundProvider(f));f.store.releaseRuntimeProvider(owner);
});
test('same-region concurrent bootstrap is fenced before a second inventory and never overwrites',enabled,async t=>{
 let entered,release;const atInventory=new Promise(r=>entered=r),gate=new Promise(r=>release=r),f=await fixture(t,{handler:async(req,res)=>{if(req.url.endsWith('/info'))send(res,{ID:'daemon-fixture',OSType:'linux',Architecture:'arm64'});else{entered();await gate;send(res,[]);}}});const first=bootstrap(f);await atInventory;await assert.rejects(bootstrap(f),code('DEPLOYMENT_BOOTSTRAP'));release();const result=await first;assert.equal(f.seen.length,3);assert.deepEqual(open(f),result);
});
test('wrong pinned engine and inventory HTTP errors cannot publish a binding',enabled,async t=>{
 const wrong=await fixture(t,{daemonId:'other'});await assert.rejects(bootstrap(wrong),code('DEPLOYMENT_ENGINE_CHANGED'));assert.deepEqual(await readdir(wrong.directory),[]);
 const failed=await fixture(t,{handler:(req,res)=>send(res,req.url.endsWith('/info')?{ID:'daemon-fixture',OSType:'linux',Architecture:'arm64'}:{message:'private-error'},req.url.endsWith('/info')?200:500)});await assert.rejects(bootstrap(failed),code('DEPLOYMENT_BOOTSTRAP'));assert.deepEqual(await readdir(failed.directory),[]);
});
test('aborted bootstrap publishes no binding and leaves no live regional owner',enabled,async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort(new Error('private-abort'));await assert.rejects(RuntimeDeploymentBindingStore.bootstrap({...f,signal:controller.signal}),code('DEPLOYMENT_BOOTSTRAP'));assert.deepEqual(await readdir(f.directory),[]);const owner=Symbol('next');f.store.claimRuntimeProvider(owner,boundProvider(f));f.store.releaseRuntimeProvider(owner);
});
test('invalid scopes,getters,worker entries or raw request fields fail before creating state',enabled,async t=>{
 const f=await fixture(t);let reads=0;const getter={...f.configuration};Object.defineProperty(getter,'daemonId',{enumerable:true,get(){reads++;return 'secret';}});
 for(const configuration of [getter,{...f.configuration,ownerKey:'secret'},{...f.configuration,workerEntry:null},{...f.configuration,workerEntry:'../bad.mjs'},{...f.configuration,region:'bad\0region'}])await assert.rejects(RuntimeDeploymentBindingStore.bootstrap({...f,configuration}));await assert.rejects(RuntimeDeploymentBindingStore.bootstrap({...f,signal:{}}),TypeError);assert.equal(reads,0);await assert.rejects(stat(f.directory),e=>e.code==='ENOENT');assert.equal(f.seen.length,0);
});
test('partial,pending,oversize,invalidUTF8 and changed binding records cannot be resumed',enabled,async t=>{
 const f=await fixture(t);await mkdir(f.directory,{mode:0o700});await writeFile(join(f.directory,'.pending-writer'),'{',{mode:0o600});assert.throws(()=>open(f),code('DEPLOYMENT_MISSING'));await bootstrap(f);const original=await readFile(file(f));
 for(const bytes of [Buffer.from('{'),Buffer.from([255]),Buffer.alloc(RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES+1)]){await writeFile(file(f),bytes);assert.throws(()=>open(f),RuntimeDeploymentBindingError);}
 const changed=JSON.parse(original);changed.binding.ledger.instanceId='00000000-0000-4000-8000-000000000000';await writeFile(file(f),JSON.stringify(changed));assert.throws(()=>open(f),code('DEPLOYMENT_BINDING'));await writeFile(file(f),original);assert.ok(open(f).receipt.fileSha256);
});
test('nonprivate files,symlink/FIFO paths and replaced directory identities are rejected',enabled,async t=>{
 const f=await fixture(t);await bootstrap(f);const files=new RuntimeDeploymentBindingStore({directory:f.directory}),original=await readFile(file(f));await chmod(file(f),0o644);assert.throws(()=>files.open(f),code('DEPLOYMENT_FILE'));await rm(file(f));await writeFile(join(f.parent,'elsewhere'),original,{mode:0o600});await symlink(join(f.parent,'elsewhere'),file(f));assert.throws(()=>files.open(f),RuntimeDeploymentBindingError);await rm(file(f));assert.equal(spawnSync('mkfifo',[file(f)]).status,0);assert.throws(()=>files.open(f),code('DEPLOYMENT_FILE'));await rename(f.directory,join(f.parent,'old-directory'));await mkdir(f.directory,{mode:0o700});assert.throws(()=>files.open(f),code('DEPLOYMENT_DIRECTORY'));
});
async function childBootstrap(f,mode,action){f.store.close();await mkdir(f.directory,{mode:0o700});let child;await withOwnedTestChild(()=>child=fork(new URL('./fixtures/runtime-deployment-binding-child.mjs',import.meta.url),[f.directory,f.path,f.socketPath,mode],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']}),owned=>action(owned));assert.equal(child.signalCode,'SIGKILL');f.replaceStore(new SqliteSessionStore({path:f.path}));return child;}
test('actual writer SIGKILL after bootstrap keeps the same resumable binding and ledger identity',enabled,async t=>{
 const f=await fixture(t);let message;await childBootstrap(f,'normal',async child=>{[message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.equal(message.event,'bootstrap-published');});assert.deepEqual(open(f).receipt,message.receipt);assert.deepEqual(f.store.identity(),message.identity);assert.equal(f.seen.length,3);
});
test('actual SIGKILL after no-overwrite link before directorysync is adopted only through ordinary resume',enabled,async t=>{
 const f=await fixture(t);await childBootstrap(f,'kill-after-link',async child=>{const [exit,signal]=await once(child,'close',{signal:AbortSignal.timeout(5000)});assert.equal(exit,null);assert.equal(signal,'SIGKILL');});const resumed=open(f);assert.equal(resumed.receipt.fileSha256,sha(await readFile(file(f))));assert.equal(f.seen.length,3);await assert.rejects(bootstrap(f),code('DEPLOYMENT_EXISTS'));
});
test('restrictive childumask cannot publish an acknowledged non0600 binding',enabled,async t=>{
 const f=await fixture(t);await childBootstrap(f,'restrictive-umask',async child=>{const [message]=await once(child,'message',{signal:AbortSignal.timeout(5000)});assert.deepEqual(message,{event:'bootstrap-rejected',code:'DEPLOYMENT_FILE'});});assert.deepEqual(await readdir(f.directory),[]);assert.throws(()=>open(f),code('DEPLOYMENT_MISSING'));
});
