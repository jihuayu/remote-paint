import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,truncate,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {verifyRuntimeSourceManifest,RUNTIME_SOURCE_LIMITS} from '../service/runtime-source-manifest.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
async function fixture(t,files={'worker.mjs':'export const worker=1;'},document){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-source-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const root=join(directory,'project'),manifest=join(directory,'manifest.json');await mkdir(root);
 for(const [name,data]of Object.entries(files)){await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),data);}
 const value=document??{schema:'runtime-source-files-v1',files:Object.fromEntries(Object.entries(files).map(([name,data])=>[name,sha(data)]))},text=JSON.stringify(value);
 await writeFile(manifest,text);return {root,manifest,expectedSha256:sha(text)};
}
test('reads actual nested source bytes and requires the configured Worker entry',async t=>{
 const f=await fixture(t,{'worker.mjs':'worker','service/module.mjs':'module'});
 assert.deepEqual(await verifyRuntimeSourceManifest({...f,requiredFiles:['worker.mjs']}),{manifestSha256:f.expectedSha256,files:2,bytes:12});
 await assert.rejects(verifyRuntimeSourceManifest({...f,requiredFiles:['missing.mjs']}),{code:'SOURCE_REQUIRED'});
});
test('manifest binding and per-file digests independently reject changed bytes',async t=>{
 const f=await fixture(t);await assert.rejects(verifyRuntimeSourceManifest({...f,expectedSha256:'0'.repeat(64)}),{code:'SOURCE_MANIFEST_DIGEST'});
 await writeFile(join(f.root,'worker.mjs'),'changed');await assert.rejects(verifyRuntimeSourceManifest(f),{code:'SOURCE_BYTES'});
});
test('empty fixture browser manifest is allowed but cannot stand in for required Native sources',async t=>{
 const f=await fixture(t,{});assert.equal((await verifyRuntimeSourceManifest(f)).files,0);
 await assert.rejects(verifyRuntimeSourceManifest({...f,requiredFiles:['headless_shell']}),{code:'SOURCE_REQUIRED'});
});
test('rejects path traversal, absolute names, control bytes and noncanonical relative paths',async t=>{
 for(const name of ['../outside','/outside','a//b','a/./b','a/../b','a\\b','a\nb']){
  const f=await fixture(t,{}, {schema:'runtime-source-files-v1',files:{[name]:sha('x')}});
  await assert.rejects(verifyRuntimeSourceManifest(f),{code:'SOURCE_MANIFEST_FORMAT'});
 }
});
test('rejects final symlinks and escaping directory symlinks, even with matching bytes',async t=>{
 const f=await fixture(t,{}),outside=join(f.root,'..','outside');await mkdir(outside);await writeFile(join(outside,'worker'),'x');
 for(const name of ['worker','linked/worker']){
  if(name==='worker')await symlink(join(outside,'worker'),join(f.root,name));else await symlink(outside,join(f.root,'linked'));
  const value=JSON.stringify({schema:'runtime-source-files-v1',files:{[name]:sha('x')}});await writeFile(f.manifest,value);
  await assert.rejects(verifyRuntimeSourceManifest({...f,expectedSha256:sha(value)}),{code:'SOURCE_ROOT'});
 }
});
test('rejects a symlinked root and a symlinked manifest',async t=>{
 const f=await fixture(t),link=join(f.root,'..','root-link');await symlink(f.root,link);
 await assert.rejects(verifyRuntimeSourceManifest({...f,root:link}),{code:'SOURCE_ROOT'});
 const manifestLink=join(f.root,'..','manifest-link');await symlink(f.manifest,manifestLink);
 await assert.rejects(verifyRuntimeSourceManifest({...f,manifest:manifestLink}),{code:'SOURCE_READ'});
});
test('bounds sparse file size before reading its bytes and bounds manifest count/bytes',async t=>{
 const f=await fixture(t,{'worker.mjs':''});await truncate(join(f.root,'worker.mjs'),RUNTIME_SOURCE_LIMITS.fileBytes+1);
 await assert.rejects(verifyRuntimeSourceManifest(f),{code:'SOURCE_FILE_LIMIT'});
 const many=await fixture(t,{}, {schema:'runtime-source-files-v1',files:Object.fromEntries(Array.from({length:RUNTIME_SOURCE_LIMITS.files+1},(_,i)=>['f'+i,sha('')]))});
 await assert.rejects(verifyRuntimeSourceManifest(many),{code:'SOURCE_FILE_COUNT'});
 await writeFile(f.manifest,' '.repeat(RUNTIME_SOURCE_LIMITS.manifestBytes+1));
 await assert.rejects(verifyRuntimeSourceManifest(f),{code:'SOURCE_FILE_LIMIT'});
});
test('rejects malformed schema, digest values, missing files and extra manifest fields',async t=>{
 for(const document of [{schema:'other',files:{}},{schema:'runtime-source-files-v1',files:{worker:'invalid'}},{schema:'runtime-source-files-v1',files:{},extra:true}]){
  const f=await fixture(t,{},document);await assert.rejects(verifyRuntimeSourceManifest(f),{code:'SOURCE_MANIFEST_FORMAT'});
 }
 const missing=await fixture(t,{}, {schema:'runtime-source-files-v1',files:{missing:sha('')}});
 await assert.rejects(verifyRuntimeSourceManifest(missing),{code:'SOURCE_MANIFEST_READ'});
});
