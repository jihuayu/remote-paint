import { spawn } from 'node:child_process';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const revision='29ed1e87a0a50f3d8347e988842d9d59e7573efa';
const {values}=parseArgs({options:{'skia-root':{type:'string'},jobs:{type:'string',default:'8'}}});
const root=fileURLToPath(new URL('../',import.meta.url));
const skia=values['skia-root']?resolve(values['skia-root']):fileURLToPath(new URL('../../../work/skia/',import.meta.url));
const build=fileURLToPath(new URL('../../../work/native-build/',import.meta.url));
async function run(command,args,cwd=root){await new Promise((ok,fail)=>{const child=spawn(command,args,{cwd,stdio:'inherit'});child.on('error',fail);child.on('exit',code=>code===0?ok():fail(new Error(`${command} exited ${code}`)));});}
if(!existsSync(join(skia,'BUILD.gn')))throw new Error(`Pinned Skia ${revision} source is required at ${skia}`);
if(!existsSync(join(skia,'bin/gn')))await run('python3',['bin/fetch-gn'],skia);
await mkdir(join(skia,'out/RemotePaint'),{recursive:true});
await cp(new URL('./skia-mac.args.gn',import.meta.url),join(skia,'out/RemotePaint/args.gn'));
await run(join(skia,'bin/gn'),['gen','out/RemotePaint'],skia);
await run('ninja',['-C','out/RemotePaint','skia',`-j${values.jobs}`],skia);
await run('cmake',['-S','native','-B',build,`-DSKIA_ROOT=${skia}`,'-DCMAKE_BUILD_TYPE=Release']);
await run('cmake',['--build',build,`-j${values.jobs}`]);
await run(join(build,'skp_subset'),['--self-test']);
await mkdir(new URL('./bin/',import.meta.url),{recursive:true});
await cp(join(build,'skp_subset'),new URL('./bin/skp_subset',import.meta.url));
const binary=await readFile(new URL('./bin/skp_subset',import.meta.url));
await writeFile(new URL('./bin/build.json',import.meta.url),JSON.stringify({skiaRevision:revision,arch:process.arch,platform:process.platform,
  sha256:createHash('sha256').update(binary).digest('hex'),builtAt:new Date().toISOString()},null,2));
