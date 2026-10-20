// Actual Native Source with a deliberately added same-UID undumpable child.
// This verifies evidence forwarding;it is NOT8h acceptance or its root cause.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,unlink,mkdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {withOwnedTestChild} from './owned-test-child.mjs';
import {reviveSourceMemoryError,sourceMemoryFailurePayload} from './source-memory-diagnostic.mjs';
assert.equal(process.platform,'linux');const directory=resolve(process.env.REMOTE_PAINT_SESSION_LONG_DIR);await mkdir(directory,{mode:0o700});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));async function json(name,ms=60000){const end=Date.now()+ms;while(Date.now()<end){try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await delay(20);}throw Error('Native diagnostic fixture deadline:'+name);}
let runId,child,diagnostic,error,sourceCleanup,sourceExit,marker,reaped;const log=await open(join(directory,'diagnostic-source.log'),'wx',0o600);
async function command(op){const id=randomUUID(),path=join(directory,'requests',id+'.json');await writeFile(path+'.tmp',JSON.stringify({id,runId,op}));await rename(path+'.tmp',path);const reply=await json('responses/'+id+'.json',30000);assert.equal(reply.id,id);await Promise.all([unlink(path),unlink(join(directory,'responses',id+'.json'))]);return reply;}
try{
 await withOwnedTestChild(()=>child=spawn(process.execPath,['--import','./tests/fixtures/source-memory-injector.mjs','tests/serve-session-longload.mjs'],{env:process.env,stdio:['ignore',log.fd,log.fd]}),async owned=>{
  try{
   const ready=await json('ready.json');runId=ready.runId;marker=await json('diagnostic-fault-ready.json');assert.equal(marker.dumpable,0);const reply=await command('snapshot');assert.ok(reply.error,'Actual incomplete Source sample must stay fatal');diagnostic=sourceMemoryFailurePayload(reviveSourceMemoryError(reply));assert.equal(diagnostic.captureStatus,'complete');assert.equal(diagnostic.gate,'pss-complete');assert.equal(diagnostic.metrics.processSampling.status,'observed-stable');assert.equal(diagnostic.metrics.pss.completeObservedCohort,false);assert.equal(diagnostic.metrics.pss.bytes,null);const bad=diagnostic.metrics.processes.find(p=>p.pid===marker.pid);assert.ok(bad);assert.match(bad.pssUnavailable.code,/EACCES|EPERM/);assert.equal(reply.diagnosticRecord.status,'saved');const raw=await readFile(join(directory,'source-memory-failures.jsonl'),'utf8'),records=raw.trim().split('\n').map(JSON.parse);assert.ok(records.some(r=>r.diagnostic.id===diagnostic.id&&JSON.stringify(r.diagnostic)===JSON.stringify(diagnostic)));await writeFile(join(directory,'diagnostic-rpc.json'),JSON.stringify(reply,null,2)+'\n',{flag:'wx',mode:0o600});
  }finally{
   if(marker){await writeFile(join(directory,'diagnostic-fault-release.json'),'{}\n',{flag:'wx',mode:0o600});reaped=await json('diagnostic-fault-reaped.json');assert.equal(reaped.code,0);}
   if(runId&&owned.exitCode===null&&owned.signalCode===null){const stopped=once(owned,'close');await command('stop');sourceCleanup=await json('source-stopped.json',30000);const [code,signal]=await stopped;sourceExit={code,signal};}
  }
 });
}catch(e){error={name:e.name,code:e.code??null,message:e.message};}
finally{await log.close();}
try{assert.equal(sourceCleanup?.status,'closed');assert.equal(sourceCleanup.activeSessions,0);assert.equal(sourceCleanup.fixtureListening,false);assert.equal(sourceCleanup.stats.created,sourceCleanup.stats.closed);assert.equal(sourceCleanup.pss.completeObservedCohort,true);assert.ok(sourceCleanup.remainingProcesses.every(p=>p.kind==='node'));assert.deepEqual(sourceExit,{code:0,signal:null});}catch(e){error??={name:e.name,code:e.code??null,message:e.message};}
const report={at:new Date().toISOString(),status:error?'failed':'passed',scope:'Actual Native Source/privatefileRPC expected PSS denial with an added controlled undumpable child;full bad-row diagnostic retained on Source/disk/revivedcaller and real cleanup after child reaped. NOT original8hv3 root cause,shortpilot,8h orall41 acceptance.',runId,sourcePid:marker?.sourcePid,badPid:marker?.pid,badCode:diagnostic?.metrics.processes.find(p=>p.pid===marker?.pid)?.pssUnavailable?.code,diagnosticId:diagnostic?.id,metricBytes:diagnostic?.metricBytes,metricsSha256:diagnostic?.metricsSha256,sourceExit,reaped,cleanup:{status:sourceCleanup?.status,activeSessions:sourceCleanup?.activeSessions,stats:sourceCleanup?.stats,sourcePssComplete:sourceCleanup?.pss.completeObservedCohort,remainingKinds:sourceCleanup?[...new Set(sourceCleanup.remainingProcesses.map(p=>p.kind))]:null},error};await writeFile(join(directory,'diagnostic-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:report.status,badCode:report.badCode,sourceExit,error}));assert.equal(report.status,'passed');
