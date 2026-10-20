// Explicit scoped negative fixture loaded with --import ONLY by the diagnostic
// verifier. The Source implementation/metric sampler has no fault switch.
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const directory=process.env.REMOTE_PAINT_SESSION_LONG_DIR;let child;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function marker(name,ms=60000){const end=Date.now()+ms;while(Date.now()<end){try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await wait(20);}throw Error('Diagnostic marker deadline');}
process.once('exit',()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
void(async()=>{
 await marker('ready.json');child=spawn('python3',[fileURLToPath(new URL('./linux-memory-undumpable.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});const reader=createInterface({input:child.stdout});child.stderr.resume();
 try{const [line]=await once(reader,'line',{signal:AbortSignal.timeout(5000)}),value=JSON.parse(line);if(value.dumpable!==0)throw Error('Fixture was not undumpable');await writeFile(join(directory,'diagnostic-fault-ready.json'),JSON.stringify({sourcePid:process.pid,...value})+'\n',{flag:'wx',mode:0o600});await marker('diagnostic-fault-release.json');const closed=once(child,'close');child.stdin.end('close\n');const [code,signal]=await closed;await writeFile(join(directory,'diagnostic-fault-reaped.json'),JSON.stringify({pid:child.pid,code,signal})+'\n',{flag:'wx',mode:0o600});}
 finally{reader.close();}
})().catch(async()=>{try{await writeFile(join(directory,'diagnostic-fault-error.json'),JSON.stringify({code:'DIAGNOSTIC_FIXTURE_FAILED'})+'\n',{flag:'wx',mode:0o600});}catch{}if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
