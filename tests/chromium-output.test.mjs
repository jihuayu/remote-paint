import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,readdir,copyFile,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,delimiter} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {captureChromiumOutputDirectory,resolveChromiumOutput} from '../native/chromium-output.mjs';
import {inspectLinuxInputs} from '../native/linux-receipt.mjs';
import {packageLinux} from '../native/package-linux.mjs';

const execute=promisify(execFile),project=fileURLToPath(new URL('../',import.meta.url));
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'remote-paint-output-'))),source=join(root,'src');
 await mkdir(source);t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,source};
}
async function put(path,bytes){await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}
async function preparedFixture(t){
 const f=await fixture(t),patches={};
 for(const name of (await readdir(join(project,'native/patches'))).filter(n=>n.endsWith('.patch'))){
  const bytes=await readFile(join(project,'native/patches',name));patches[name]=createHash('sha256').update(bytes).digest('hex');
  for(const match of bytes.toString().matchAll(/^\+\+\+ b\/(.+)$/gm))await put(join(f.source,match[1]),`fixture input ${match[1]}\n`);
 }
 for(const name of await readdir(join(project,'native/chromium'))){const to=join(f.source,'components/remote_paint',name);await mkdir(dirname(to),{recursive:true});await copyFile(join(project,'native/chromium',name),to);}
 await mkdir(join(f.source,'third_party/skia'),{recursive:true});
 await put(join(f.source,'.gn'),'script_executable = "//third_party/cpython3/linux-amd64/bin/python3"\n');
 await put(join(f.source,'third_party/swiftshader/BUILD.gn'),'# Remote Paint: Mac bind-mount case diagnostic.\n');
 await put(join(f.source,'BUILD.gn'),'group("remote_paint_tools") {\n  testonly = true\n  deps = [ "//components/remote_paint:serializer_tests" ]\n}\n');
 const bin=join(f.root,'bin');await mkdir(bin);
 // Unit fixture only: isolate revision lookup; no real checkout, patch apply,
 // compiler, browser or source qualification is supplied by this fake git.
 await writeFile(join(bin,'git'),`#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='rev-parse HEAD'){console.log(process.cwd().endsWith('/skia')?'29ed1e87a0a50f3d8347e988842d9d59e7573efa':'a49e2e3d4addfd84e765b52afe230bedb81096db');}else{console.error('FAKE_GIT_NO_APPLY');process.exit(91);}\n`,{mode:0o755});
 await put(join(f.source,'out/RemotePaintLinux/remote-paint-patches.json'),'invalid legacy receipt: must never be read');
 await put(join(f.source,'out/RemotePaintLinux/args.gn'),'invalid legacy profile: must never be read');
 return {...f,patches,env:{...process.env,REMOTE_PAINT_HOST_CC:'0',PATH:bin+delimiter+process.env.PATH}};
}

test('Chromium output selection is explicit and confined to one out directory',()=>{
 for(const value of [undefined,null,'','/tmp/build','out','out/','out/.','out/..','out/a/b','out/../retained','out\\other','out/a\n','out/a\r','out/a b','out/'+ 'a'.repeat(97)])assert.throws(()=>captureChromiumOutputDirectory(value),/explicit --output/);
 for(const value of ['out/Task-20261020_v1','out/RemotePaintLinux'])assert.equal(captureChromiumOutputDirectory(value),value);
});
test('resolving a new explicit output does not create or modify directories',async t=>{
 const {source}=await fixture(t),value=await resolveChromiumOutput(source,'out/NewBuild');
 assert.deepEqual(value,{source,directory:join(source,'out/NewBuild'),relativeDirectory:'out/NewBuild'});assert.ok(Object.isFrozen(value));
 assert.deepEqual(await readdir(source),[]);
});
test('reusing a selected output preserves its existing object cache',async t=>{
 const {source}=await fixture(t),cache=join(source,'out/Selected/.ninja_log');await put(cache,'retained cache');const before=await stat(cache);
 await resolveChromiumOutput(source,'out/Selected');
 const after=await stat(cache);assert.equal(await readFile(cache,'utf8'),'retained cache');assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
});
test('source, out parent and output aliases are rejected before following them',async t=>{
 const {root,source}=await fixture(t),retained=join(root,'retained');await mkdir(retained);await put(join(retained,'sentinel'),'keep');await mkdir(join(source,'out'));
 await symlink(retained,join(source,'out/Alias'),'dir');await assert.rejects(resolveChromiumOutput(source,'out/Alias'),/not an alias/);
 await rm(join(source,'out'),{recursive:true});await symlink(retained,join(source,'out'),'dir');await assert.rejects(resolveChromiumOutput(source,'out/New'),/not an alias/);
 const sourceAlias=join(root,'source-alias');await symlink(source,sourceAlias,'dir');await assert.rejects(resolveChromiumOutput(sourceAlias,'out/New'),/not an alias/);
 assert.deepEqual(await readdir(retained),['sentinel']);assert.equal(await readFile(join(retained,'sentinel'),'utf8'),'keep');
});
test('non-directory output components cannot be overwritten',async t=>{
 const {source}=await fixture(t);await put(join(source,'out'),'file');await assert.rejects(resolveChromiumOutput(source,'out/New'),/real directory/);assert.equal(await readFile(join(source,'out'),'utf8'),'file');
 await rm(join(source,'out'));await put(join(source,'out/New'),'leaf');await assert.rejects(resolveChromiumOutput(source,'out/New'),/real directory/);assert.equal(await readFile(join(source,'out/New'),'utf8'),'leaf');
});
test('receipt and packaging APIs cannot fall back when output is omitted',async t=>{
 const {source}=await fixture(t);await assert.rejects(inspectLinuxInputs(source),/explicit --output/);await assert.rejects(packageLinux({source,cpu:'arm64'}),/explicit --output/);assert.deepEqual(await readdir(source),[]);
});
test('build entry points reject omitted output before opening a build cache',async t=>{
 const {source}=await fixture(t);
 for(const [file,args]of [
  ['native/prepare.mjs',[source,'linux-arm64']],
  ['native/build-chromium.mjs',['--source',source]],
  ['native/linux-receipt.mjs',[source,'--check-inputs']],
  ['native/package-linux.mjs',['--source',source,'--cpu','arm64','--broker','unused','--node-dir','unused']]
 ])await assert.rejects(execute(process.execPath,[join(project,file),...args]),error=>error.code===1&&/--output/.test(error.stderr));
 assert.deepEqual(await readdir(source),[]);
});
test('Linux input inspection reads and records the explicitly selected output',async t=>{
 const f=await preparedFixture(t),output=join(f.source,'out/Selected');await put(join(output,'args.gn'),await readFile(join(project,'native/linux-arm64.args.gn')));await put(join(output,'remote-paint-patches.json'),JSON.stringify(f.patches));
 const module=pathToFileURL(join(project,'native/linux-receipt.mjs')).href;
 const code=`import {inspectLinuxInputs} from ${JSON.stringify(module)};console.log(JSON.stringify(await inspectLinuxInputs(${JSON.stringify(f.source)},{outputDirectory:'out/Selected'})));`;
 const {stdout}=await execute(process.execPath,['--input-type=module','-e',code],{env:f.env});const result=JSON.parse(stdout);
 assert.equal(result.format,2);assert.equal(result.outputDirectory,'out/Selected');assert.equal(result.buildProfile,'linux-arm64');assert.deepEqual(result.patches,f.patches);
 assert.equal(await readFile(join(f.source,'out/RemotePaintLinux/args.gn'),'utf8'),'invalid legacy profile: must never be read');
});
test('preparation imports only the explicitly selected matching patch receipt',async t=>{
 const f=await preparedFixture(t);await put(join(f.source,'out/Seed/remote-paint-patches.json'),JSON.stringify(f.patches));
 await execute(process.execPath,[join(project,'native/prepare.mjs'),f.source,'linux-arm64','--output','out/New','--patch-state-from','out/Seed'],{env:f.env});
 assert.deepEqual(JSON.parse(await readFile(join(f.source,'out/New/remote-paint-patches.json'),'utf8')),f.patches);
 assert.equal(await readFile(join(f.source,'out/New/args.gn'),'utf8'),await readFile(join(project,'native/linux-arm64.args.gn'),'utf8'));
 assert.equal(await readFile(join(f.source,'out/RemotePaintLinux/remote-paint-patches.json'),'utf8'),'invalid legacy receipt: must never be read');
});
test('preparation rejects conflicting or unknown imported patch state',async t=>{
 const f=await preparedFixture(t),first=Object.keys(f.patches)[0];await put(join(f.source,'out/Selected/remote-paint-patches.json'),JSON.stringify(f.patches));await put(join(f.source,'out/Seed/remote-paint-patches.json'),JSON.stringify({...f.patches,[first]:'0'.repeat(64)}));
 const args=[join(project,'native/prepare.mjs'),f.source,'linux-arm64','--output','out/Selected','--patch-state-from','out/Seed'];
 await assert.rejects(execute(process.execPath,args,{env:f.env}),error=>/Conflicting imported/.test(error.stderr));
 await put(join(f.source,'out/Seed/remote-paint-patches.json'),JSON.stringify({'unknown.patch':'a'.repeat(64)}));
 await assert.rejects(execute(process.execPath,args,{env:f.env}),error=>/Invalid patch-state entry/.test(error.stderr));
 assert.deepEqual(JSON.parse(await readFile(join(f.source,'out/Selected/remote-paint-patches.json'),'utf8')),f.patches);
});
