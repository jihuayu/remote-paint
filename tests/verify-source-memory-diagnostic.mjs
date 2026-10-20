// Owned real Native negative fixtures. They verify diagnostic forwarding, not
// the original eight-hour failure cause or acceptance of an incomplete sample.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,unlink,mkdir,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {withOwnedTestChild} from './owned-test-child.mjs';
import {deadline} from './memory-soak-diagnostics.mjs';
import {reviveSourceMemoryError,sourceMemoryFailurePayload} from './source-memory-diagnostic.mjs';
assert.equal(process.platform,'linux');
const mode=process.argv[2]??'rpc';assert.ok(['rpc','closing'].includes(mode));
const directory=resolve(process.env.REMOTE_PAINT_SESSION_LONG_DIR);await mkdir(directory,{mode:0o700});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(name,ms=60000){const end=Date.now()+ms;while(Date.now()<end){try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await delay(20);}throw Error('Native diagnostic fixture deadline:'+name);}
let runId,diagnostic,error,sourceCleanup,sourceExit,marker,reaped,stopRequested=false,sourceClosed;
const log=await open(join(directory,'diagnostic-source.log'),'wx',0o600);
async function command(op){const id=randomUUID(),path=join(directory,'requests',id+'.json');await writeFile(path+'.tmp',JSON.stringify({id,runId,op}),{mode:0o600});await rename(path+'.tmp',path);const reply=await json('responses/'+id+'.json',30000);assert.equal(reply.id,id);await Promise.all([unlink(path),unlink(join(directory,'responses',id+'.json'))]);return reply;}
function checkDiagnostic(value){assert.equal(value.captureStatus,'complete');assert.equal(value.gate,'pss-complete');assert.equal(value.metrics.processSampling.status,'observed-stable');assert.equal(value.metrics.pss.completeObservedCohort,false);assert.equal(value.metrics.pss.bytes,null);const bad=value.metrics.processes.find(p=>p.pid===marker.pid);assert.ok(bad);assert.match(bad.pssUnavailable.code,/EACCES|EPERM/);}
async function records(){return(await readFile(join(directory,'source-memory-failures.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}
try{
 await withOwnedTestChild(()=>spawn(process.execPath,['--import','./tests/fixtures/source-memory-injector.mjs','tests/serve-session-longload.mjs'],{env:process.env,stdio:['ignore',log.fd,log.fd]}),async owned=>{
  try{
   const ready=await json('ready.json');runId=ready.runId;marker=await json('diagnostic-fault-ready.json');assert.equal(marker.dumpable,0);
   if(mode==='rpc'){
    const reply=await command('snapshot');assert.ok(reply.error,'Incomplete Source sample must stay fatal');diagnostic=sourceMemoryFailurePayload(reviveSourceMemoryError(reply));checkDiagnostic(diagnostic);assert.equal(reply.diagnosticRecord.status,'saved');assert.ok((await records()).some(r=>r.diagnostic.id===diagnostic.id&&JSON.stringify(r.diagnostic)===JSON.stringify(diagnostic)));await writeFile(join(directory,'diagnostic-rpc.json'),JSON.stringify(reply,null,2)+'\n',{flag:'wx',mode:0o600});
   }else{
    sourceClosed=once(owned,'close');stopRequested=true;assert.equal((await command('stop')).stopped,true);sourceCleanup=await json('source-stopped.json',30000);assert.equal(sourceCleanup.status,'failed');assert.deepEqual(sourceCleanup.primary.cleanupErrors.map(e=>e.step),['pin','retirement-state-metrics']);const saved=await records();assert.equal(saved.length,2);for(const record of saved){checkDiagnostic(record.diagnostic);assert.equal(record.diagnostic.context.phase,'closing');}diagnostic=saved[0].diagnostic;assert.notEqual(saved[1].diagnostic.id,diagnostic.id);assert.equal(sourceCleanup.primary.sourceClosed,true);assert.equal(sourceCleanup.primary.brokerExited,true);assert.equal(sourceCleanup.primary.browserConnected,false);assert.ok(sourceCleanup.primary.retired.length>0);assert.ok(sourceCleanup.primary.retired.every(p=>['ESRCH','ENOENT'].includes(p.retirement)));
   }
  }finally{
   if(marker){await writeFile(join(directory,'diagnostic-fault-release.json'),'{}\n',{flag:'wx',mode:0o600});reaped=await json('diagnostic-fault-reaped.json');assert.equal(reaped.code,0);}
   if(runId&&owned.exitCode===null&&owned.signalCode===null){if(!stopRequested){sourceClosed=once(owned,'close');stopRequested=true;await command('stop');}sourceCleanup??=await json('source-stopped.json',30000);const [code,signal]=await deadline(sourceClosed,30000,'Source exit');sourceExit={code,signal};}
   else sourceExit={code:owned.exitCode,signal:owned.signalCode};
  }
 });
 assert.equal(sourceCleanup.activeSessions,0);assert.equal(sourceCleanup.fixtureListening,false);assert.deepEqual(sourceExit,{code:mode==='rpc'?0:1,signal:null});
 if(mode==='rpc'){assert.equal(sourceCleanup.status,'closed');assert.equal(sourceCleanup.stats.created,sourceCleanup.stats.closed);assert.equal(sourceCleanup.pss.completeObservedCohort,true);assert.ok(sourceCleanup.remainingProcesses.every(p=>p.kind==='node'));}
 else{assert.equal(sourceCleanup.status,'failed');assert.equal(sourceCleanup.stats.created,1);assert.equal(sourceCleanup.stats.closed,0);}
}catch(e){error={name:e.name,code:e.code??null,message:e.message};}
finally{await log.close();}
const report={at:new Date().toISOString(),status:error?'failed':'passed',scope:'Controlled actual Native Source expected PSS denial: complete raw bad-row evidence on disk and private RPC or strict failed closing receipt. NOT original eight-hour root cause, pilot or acceptance.',mode,runId,sourcePid:marker?.sourcePid,badPid:marker?.pid,badCode:diagnostic?.metrics.processes.find(p=>p.pid===marker?.pid)?.pssUnavailable?.code,diagnosticId:diagnostic?.id,metricBytes:diagnostic?.metricBytes,metricsSha256:diagnostic?.metricsSha256,sourceExit,reaped,cleanup:{status:sourceCleanup?.status,activeSessions:sourceCleanup?.activeSessions,stats:sourceCleanup?.stats,sourcePssComplete:sourceCleanup?.pss?.completeObservedCohort??null,remainingKinds:sourceCleanup?.remainingProcesses?[...new Set(sourceCleanup.remainingProcesses.map(p=>p.kind))]:null,retired:sourceCleanup?.primary?.retired?.length??null},error};
await writeFile(join(directory,'diagnostic-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:report.status,mode,badCode:report.badCode,sourceExit,error}));assert.equal(report.status,'passed');
