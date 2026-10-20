import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {captureChromiumOutputDirectory,resolveChromiumOutput} from './chromium-output.mjs';
const {values}=parseArgs({options:{source:{type:'string'},output:{type:'string'},'patch-state-from':{type:'string'},jobs:{type:'string',default:'10'},gn:{type:'string'}}});
captureChromiumOutputDirectory(values.output);
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('This build configuration is for single-device Apple Silicon macOS');
if(!values.source)throw new Error('Usage: node native/build-chromium.mjs --source SOURCE --output out/name [--patch-state-from out/previous] [--gn GN]');
const selected=await resolveChromiumOutput(values.source,values.output),source=selected.source;
const root=fileURLToPath(new URL('../',import.meta.url));
async function run(command,args,cwd=source){await new Promise((ok,fail)=>{const p=spawn(command,args,{cwd,stdio:'inherit'});p.once('error',fail);p.once('exit',c=>c===0?ok():fail(new Error(`${command} exited ${c}`)));});}
await run(process.execPath,['native/prepare.mjs',source,'mac-arm64','--output',selected.relativeDirectory,...(values['patch-state-from']?['--patch-state-from',values['patch-state-from']]:[])],root);
const gn=values.gn??[join(source,'buildtools/mac-arm64/gn'),join(source,'buildtools/mac/gn')].find(existsSync)??'gn';
await run(gn,['gen',selected.directory]);
await run('ninja',['-C',selected.directory,`-j${values.jobs}`,'remote_paint_tools','headless_shell']);
await run(join(selected.directory,'serializer_tests'),[]);
console.log(`Native browser ready: ${join(selected.directory,'headless_shell')}`);
