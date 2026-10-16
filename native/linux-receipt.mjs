// Build-time source/binary provenance. Runtime acceptance still runs separately.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {readFile,readdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=fileURLToPath(new URL('../',import.meta.url));
const chromiumRevision='a49e2e3d4addfd84e765b52afe230bedb81096db';
const skiaRevision='29ed1e87a0a50f3d8347e988842d9d59e7573efa';
export async function fileHash(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
async function expectedSources(){
 const result={};
 for(const name of (await readdir(join(project,'native/chromium'))).sort())result[name]=await fileHash(join(project,'native/chromium',name));
 return result;
}
export async function linuxBuildProfile(args){
 for(const name of ['linux-arm64','linux-arm64-host-cc','linux-x64'])if(args===await readFile(join(project,`native/${name}.args.gn`),'utf8'))return name;
 throw new Error('Build arguments differ from the supported Linux profiles');
}
export async function inspectLinuxInputs(source){
 const revision=path=>execFileSync('git',['rev-parse','HEAD'],{cwd:path,encoding:'utf8'}).trim();
 assert.equal(revision(source),chromiumRevision);assert.equal(revision(join(source,'third_party/skia')),skiaRevision);
 const nativeSources=await expectedSources();
 for(const [name,hash] of Object.entries(nativeSources))assert.equal(await fileHash(join(source,'components/remote_paint',name)),hash,`Stale native source: ${name}`);
 const output=join(source,'out/RemotePaintLinux');
 const args=await readFile(join(output,'args.gn'),'utf8');
 const buildProfile=await linuxBuildProfile(args);
 const hostCrossCompiler=buildProfile==='linux-arm64-host-cc'?JSON.parse(await readFile(process.env.REMOTE_PAINT_HOST_CC_MANIFEST??'/cc-control/build.json','utf8')):null;
 const applied=JSON.parse(await readFile(join(output,'remote-paint-patches.json'),'utf8')),patches={},patchedSources={};
 for(const name of (await readdir(join(project,'native/patches'))).filter(n=>n.endsWith('.patch')).sort()){
  patches[name]=await fileHash(join(project,'native/patches',name));assert.equal(applied[name],patches[name]);
  const patch=await readFile(join(project,'native/patches',name),'utf8');
  for(const match of patch.matchAll(/^\+\+\+ b\/(.+)$/gm))patchedSources[match[1]]=await fileHash(join(source,match[1]));
 }
 return {format:1,target:{os:'linux',cpu:buildProfile==='linux-x64'?'x64':'arm64'},buildProfile,hostCrossCompiler,chromiumRevision,skiaRevision,nativeSources,patches,patchedSources,
  argsSha256:createHash('sha256').update(args).digest('hex'),
  hostConfiguration:{gnSha256:await fileHash(join(source,'.gn')),swiftShaderSha256:await fileHash(join(source,'third_party/swiftshader/BUILD.gn'))}};
}
export async function verifyLinuxReceipt(receipt,{browserSha256,serializerSha256,argsSha256,patches,buildProfile,cpu='arm64'}){
 assert.equal(receipt.format,1);assert.ok(['arm64','x64'].includes(cpu));assert.deepEqual(receipt.target,{os:'linux',cpu});
 assert.equal(receipt.chromiumRevision,chromiumRevision);assert.equal(receipt.skiaRevision,skiaRevision);
 assert.deepEqual(receipt.nativeSources,await expectedSources(),'Native build sources differ from the runtime project');
 assert.deepEqual(receipt.patches,patches);assert.equal(receipt.argsSha256,argsSha256);
 assert.equal(receipt.binaries.headless_shell,browserSha256);assert.equal(receipt.binaries.serializer_tests,serializerSha256);
 if(buildProfile)assert.equal(receipt.buildProfile??'linux-arm64',buildProfile);
 if(buildProfile==='linux-arm64-host-cc'){assert.equal(receipt.hostCrossCompiler.mode,'mac-arm64-clang-cross');assert.equal(receipt.hostCrossCompiler.target,'aarch64-linux-gnu');assert.match(receipt.hostCrossCompiler.compilerSha256,/^[a-f0-9]{64}$/);}
 assert.equal(receipt.incrementalGraphUpToDate,true);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.platform,'linux');
 const source=resolve(process.argv[2]??'');assert.ok(process.argv[2],'Pass the pinned Chromium source directory');
 const receipt=await inspectLinuxInputs(source),output=join(source,'out/RemotePaintLinux');
 if(process.argv.includes('--check-inputs'))console.log(JSON.stringify(receipt,null,2));
 else{
  // Catch source changes made after Ninja scanned the running build's inputs.
  const dry=execFileSync('ninja',['-C',output,'-n','remote_paint_tools','headless_shell'],{encoding:'utf8'});
  assert.ok(dry.includes('ninja: no work to do.')&&!/^\[\d/m.test(dry),'Build graph still has pending work; finish the incremental build first');
  receipt.binaries={headless_shell:await fileHash(join(output,'headless_shell')),serializer_tests:await fileHash(join(output,'serializer_tests'))};
  receipt.builtAt=new Date().toISOString();receipt.incrementalGraphUpToDate=true;
  const path=join(output,'remote-paint-build.json');await writeFile(`${path}.tmp`,JSON.stringify(receipt,null,2)+'\n');await rename(`${path}.tmp`,path);
  console.log(`Linux build provenance saved: ${path}`);
 }
}
