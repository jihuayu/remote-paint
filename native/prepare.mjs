import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node native/prepare.mjs /path/to/chromium/src');
const expected = 'a49e2e3d4addfd84e765b52afe230bedb81096db';
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
if (revision !== expected) throw new Error(`Expected Chromium ${expected}, got ${revision}`);
const output = join(source, 'out/RemotePaint');
await mkdir(output, { recursive: true });
const statePath=join(output,'remote-paint-patches.json');
const state=JSON.parse(await readFile(statePath,'utf8').catch(error=>{if(error.code==='ENOENT')return '{}';throw error;}));
for(const name of (await readdir(new URL('./patches/',import.meta.url))).filter(n=>n.endsWith('.patch')).sort()) {
  const patch=new URL(`./patches/${name}`,import.meta.url);
  const hash=createHash('sha256').update(await readFile(patch)).digest('hex');
  if(state[name]===hash)continue;
  if(state[name])throw new Error(`Applied patch changed: ${name}; use a clean pinned source checkout`);
  try {execFileSync('git',['apply','--reverse','--check',patch.pathname],{cwd:source,stdio:'pipe'});}
  catch {execFileSync('git',['apply',patch.pathname],{cwd:source,stdio:'inherit'});}
  state[name]=hash;await writeFile(statePath,JSON.stringify(state,null,2));
}
await mkdir(join(source, 'components/remote_paint'), { recursive: true });
await cp(new URL('./chromium/', import.meta.url), join(source, 'components/remote_paint'), { recursive: true });
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
await cp(new URL('./mac-arm64.args.gn', import.meta.url), join(output, 'args.gn'));
console.log(`Prepared ${source}; generate out/RemotePaint and build remote_paint_tools`);
