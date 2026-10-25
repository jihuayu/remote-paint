// Run with the archive's Node on its actual target architecture. No downloads.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {verifyElf} from '../native/package-linux.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';

const root=resolve(process.argv[2]);
const build=JSON.parse(await readFile(join(root,'BUILD.json'),'utf8'));
assert.equal(process.platform,'linux');
assert.equal(process.arch,build.cpu,'Smoke must execute on the packaged CPU');
assert.match(process.version,/^v22\./);
for(const file of ['browser/headless_shell','browser/serializer_tests','app/native/bin/remote-paint-broker','node/bin/node'])await verifyElf(join(root,file),build.cpu);
const fixture=await startDynamicFixture();
let child,closed,stopTimer,launchTimer,stdout='',stderr='',phase='startup';
const redacted=text=>text.replace(/--remote-paint-token=[^\s]*/g,'--remote-paint-token=<redacted>').replace(/([?#&]key=)[^\s"']*/g,'$1<redacted>');
try{
 child=spawn(join(root,'start.sh'),['--port','0','--url',fixture.url],{cwd:root,stdio:['ignore','pipe','pipe']});
 closed=once(child,'close');
 const url=await new Promise((resolve,reject)=>{
  launchTimer=setTimeout(()=>reject(new Error('Packaged launcher did not become ready in 60 seconds')),60000);
  child.on('error',reject);
  child.on('close',code=>reject(new Error(`Packaged launcher exited before readiness: ${code}; ${redacted(stderr.slice(-1000))}`)));
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-4096);});
  child.stdout.on('data',data=>{
   stdout=(stdout+data).slice(-4096);
   const match=stdout.match(/Live Remote Paint Viewer: (http:\/\/[^\s]+)/);
   if(match){clearTimeout(launchTimer);resolve(new URL(match[1]));}
  });
 });
 assert.equal(url.hostname,'127.0.0.1','Launcher must default to loopback');
 phase='viewer';
 const page=await fetch(url,{signal:AbortSignal.timeout(5000)});
 assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
 assert.match(await page.text(),/<canvas/i);
 phase='wasm';
 const wasm=await fetch(new URL('/vendor/canvaskit.wasm',url),{signal:AbortSignal.timeout(10000)});
 assert.equal(wasm.status,200);assert.match(wasm.headers.get('content-type'),/application\/wasm/);
 const reader=wasm.body.getReader();
 try{const first=await reader.read();assert.equal(Buffer.from(first.value).subarray(0,4).toString('hex'),'0061736d');}
 finally{await reader.cancel();}
 phase='shutdown';child.kill('SIGTERM');
 stopTimer=setTimeout(()=>child.kill('SIGKILL'),15000);
 const [code,signal]=await closed;clearTimeout(stopTimer);
 assert.equal(signal,null,'Launcher must shut down gracefully');assert.equal(code,0,`Launcher shutdown failed; stderr: ${redacted(stderr)}`);
 await mkdir('artifacts/package',{recursive:true});
 const report={verifiedAt:new Date().toISOString(),revision:build.projectRevision,cpu:build.cpu,node:process.version,launcher:true,loopback:true,viewer:true,canvasKitWasm:true,gracefulShutdown:true};
 await writeFile('artifacts/package/launcher.json',JSON.stringify(report,null,2)+'\n');
 console.log(report);
}catch(error){
 await mkdir('artifacts/package',{recursive:true});
 await writeFile('artifacts/package/launcher-stderr.log',redacted(stderr));
 await writeFile('artifacts/package/launcher-error.json',JSON.stringify({verifiedAt:new Date().toISOString(),phase,cpu:process.arch,node:process.version,error:redacted(error.message)},null,2)+'\n');
 throw error;
}finally{
 clearTimeout(launchTimer);clearTimeout(stopTimer);
 if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed.catch(()=>{});}
 await fixture.close();
}
