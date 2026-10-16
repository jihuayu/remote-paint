import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node native/prepare.mjs /path/to/chromium/src');
const expected = 'a49e2e3d4addfd84e765b52afe230bedb81096db';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== expected) throw new Error(`Expected Chromium ${expected}, got ${revision}`);
const platform = process.argv[3] ?? 'mac-arm64';
if (!['mac-arm64', 'linux-arm64', 'linux-x64'].includes(platform)) throw new Error('Unknown build platform');
const output = join(source, platform === 'mac-arm64' ? 'out/RemotePaint' : 'out/RemotePaintLinux');
await mkdir(output, { recursive: true });
const statePath=join(output,'remote-paint-patches.json');
async function copyChanged(from,to){
 const bytes=await readFile(from),current=await readFile(to).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(!current||!bytes.equals(current))await writeFile(to,bytes);
}
const readState=async path=>JSON.parse(await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
const state=await readState(statePath);
// Patches modify the source tree, so a cloned, already prepared checkout keeps
// their receipt even when its toolchain/output switches platforms. Later
// patches can overlap earlier hunks; reverse-checking each alone is invalid.
if(!Object.keys(state).length){
 const previous=join(source,platform.startsWith('linux-')?'out/RemotePaint':'out/RemotePaintLinux','remote-paint-patches.json');
 Object.assign(state,await readState(previous));
}
for(const name of (await readdir(new URL('./patches/',import.meta.url))).filter(n=>n.endsWith('.patch')).sort()) {
  const patch=new URL(`./patches/${name}`,import.meta.url);
  const hash=createHash('sha256').update(await readFile(patch)).digest('hex');
  if(state[name]===hash)continue;
  if(state[name])throw new Error(`Applied patch changed: ${name}; use a clean pinned source checkout`);
  try {execFileSync('git',['apply','--reverse','--check',patch.pathname],{cwd:source,stdio:'pipe'});}
  catch {execFileSync('git',['apply',patch.pathname],{cwd:source,stdio:'inherit'});}
  state[name]=hash;await writeFile(statePath,JSON.stringify(state,null,2));
}
await writeFile(statePath,JSON.stringify(state,null,2));
await mkdir(join(source, 'components/remote_paint'), { recursive: true });
for(const name of await readdir(new URL('./chromium/',import.meta.url)))await copyChanged(new URL(`./chromium/${name}`,import.meta.url),join(source,'components/remote_paint',name));
if(platform.startsWith('linux-')){
  // Nested `gn desc` calls (notably V8 metagen) do not inherit the top-level
  // `gn gen --script-executable` override. A Mac-synced host/ contains Mach-O.
  const dotfile=join(source,'.gn'),linuxPython='script_executable = "//third_party/cpython3/linux-amd64/bin/python3"';
  let settings=await readFile(dotfile,'utf8');
  if(!settings.includes(linuxPython)){
    const original='script_executable = "//third_party/cpython3/host/bin/python3"';
    if(!settings.includes(original))throw new Error('Pinned GN Python setting changed');
    await writeFile(dotfile,settings.replace(original,linuxPython));
  }
  // OrbStack bind mounts on a case-insensitive Mac volume can report a
  // lowercase canonical Vulkan path for SwiftShader's correctly cased include.
  // Keep the diagnostic visible without making it fatal for these targets.
  const path=join(source,'third_party/swiftshader/BUILD.gn');
  let text=await readFile(path,'utf8');
  const marker='# Remote Paint: Mac bind-mount case diagnostic.';
  if(!text.includes(marker)){
    const anchor='config("swiftshader_config") {\n  cflags = []';
    if(!text.includes(anchor))throw new Error('Pinned SwiftShader config changed');
    text=text.replace(anchor,`${anchor}\n  ${marker}\n  if (is_linux && is_clang) {\n    cflags += [ "-Wno-error=nonportable-include-path" ]\n  }`);
    await writeFile(path,text);
  }
}
const rootBuild = join(source, 'BUILD.gn');
let build = await readFile(rootBuild, 'utf8');
if (!build.includes('group("remote_paint_tools")')) {
  build += '\n# Local Remote Paint targets (native/prepare.mjs).\ngroup("remote_paint_tools") {\n  testonly = true\n  deps = [ "//components/remote_paint:serializer_tests" ]\n}\n';
  await writeFile(rootBuild, build);
}
if (!build.includes('group("remote_paint_tools") {\n  testonly = true')) {
  build = build.replace('group("remote_paint_tools") {', 'group("remote_paint_tools") {\n  testonly = true');
  await writeFile(rootBuild, build);
}
const profile=platform==='linux-arm64'&&process.env.REMOTE_PAINT_HOST_CC==='1'?'linux-arm64-host-cc':platform;
await copyChanged(new URL(`./${profile}.args.gn`, import.meta.url), join(output, 'args.gn'));
console.log(`Prepared ${source}; generate ${output} and build remote_paint_tools`);
