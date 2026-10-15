import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
const {values}=parseArgs({options:{source:{type:'string'},jobs:{type:'string',default:'10'},gn:{type:'string'}}});
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This build configuration is for single-device Apple Silicon macOS');
if(!values.source)throw new Error('Usage: node native/build-chromium.mjs --source /path/to/chromium/src [--gn /path/to/gn]');
const source=resolve(values.source);const root=fileURLToPath(new URL('../',import.meta.url));
async function run(command,args,cwd=source){await new Promise((ok,fail)=>{const p=spawn(command,args,{cwd,stdio:'inherit'});p.once('error',fail);p.once('exit',c=>c===0?ok():fail(new Error(`${command} exited ${c}`)));});}
await run(process.execPath,['native/prepare.mjs',source],root);
const gn=values.gn??[join(source,'buildtools/mac-arm64/gn'),join(source,'buildtools/mac/gn')].find(existsSync)??'gn';
await run(gn,['gen','out/RemotePaint']);
await run('ninja',['-C','out/RemotePaint',`-j${values.jobs}`,'remote_paint_tools','headless_shell']);
await run(join(source,'out/RemotePaint/serializer_tests'),[]);
console.log(`Native browser ready: ${join(source,'out/RemotePaint/headless_shell')}`);
