import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {atomicJson,deadline} from './memory-soak-diagnostics.mjs';

assert.equal(process.platform,'linux');
const output=resolve('artifacts/memory-diagnostics');await mkdir(output,{recursive:true});
const variants=[];let child;
const json=path=>readFile(path,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
async function until(operation,label,milliseconds=20000){const end=Date.now()+milliseconds;while(Date.now()<end){const value=await operation();if(value)return value;await delay(25);}throw new Error(`${label} timed out`);}
async function identity(pid){try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');return Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
try{
 for(const fault of [null,'renderer-crash','cleanup-error']){
  const directory=await mkdtemp(join(output,`${fault??'normal'}-`));
  child=spawn(process.execPath,['tests/serve-memory-soak.mjs'],{env:{...process.env,REMOTE_PAINT_MEMORY_DIR:directory,REMOTE_PAINT_MEMORY_PORT:'0',REMOTE_PAINT_MEMORY_DIAGNOSTIC_INTERVAL:'1000',REMOTE_PAINT_MEMORY_TEST_FAULT:fault??''},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);const exited=once(child,'close');
  const ready=await until(()=>json(join(directory,'ready.json')),'Source readiness');
  const command=async op=>{const id=randomUUID();await atomicJson(join(directory,'requests'),`${id}.json`,{runId:ready.runId,id,op});const reply=await until(()=>json(join(directory,'responses',`${id}.json`)),`${op} response`);assert.equal(reply.error,undefined);return reply;};
  const before=await command('metrics');assert.equal(before.health.pageCrashed,false);assert.equal(before.state.pageStateError,undefined);
  assert.ok(before.metrics.pss.bytes>0);assert.equal(before.metrics.pss.sampledProcesses,before.metrics.pss.totalProcesses);assert.equal(before.metrics.pss.completeObservedCohort,true);assert.equal(before.metrics.processSampling.status,'observed-stable');assert.equal(before.metrics.processSampling.provider,'linux-pinned-proc-v1');
  assert.ok(before.metrics.processes.some(row=>row.kind==='broker'&&row.pssBytes>0));assert.ok(before.metrics.processes.some(row=>row.chromiumRole==='renderer'&&row.pssBytes>0));
  assert.ok(Number.isSafeInteger(before.metrics.cgroup['memory.current']));assert.equal(typeof before.metrics.cgroup['memory.events'].oom_kill,'number');assert.equal(before.metrics.cgroup.provenance.status,'observed');assert.equal(before.metrics.cgroup.provenance.processMembershipConfirmed,true);assert.ok(Number.isSafeInteger(before.metrics.cgroup['memory.stat'].anon));assert.ok(Number.isSafeInteger(before.metrics.cgroup['memory.stat'].file));
  await delay(1150);
  let afterCrash;
  if(fault==='renderer-crash'){
   afterCrash=await command('crash');assert.equal(afterCrash.health.pageCrashed,true);assert.match(afterCrash.state.pageStateError,/crash/i);
   const later=await command('snapshot');assert.equal(later.health.pageCrashed,true);assert.ok(later.metrics.pss.bytes>0,'Dead page prevented independent process sample');assert.equal(later.metrics.pss.completeObservedCohort,true);
   const events=(await readFile(join(directory,'source-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(events.some(event=>event.type==='page-crash'&&!event.expectedDuringClose));assert.ok(events.some(event=>event.type==='target-crash'&&!event.expectedDuringClose));
  }
  await command('stop');const [code,signal]=await deadline(exited,20000,'Source process exit');
  await writeFile(join(directory,'stdout.log'),stdout);await writeFile(join(directory,'stderr.log'),stderr);
  assert.equal(code,fault==='cleanup-error'?1:0);assert.equal(signal,null);
  const receipt=await json(join(directory,'source-stopped.json'));assert.equal(receipt.runId,ready.runId);assert.equal(receipt.status,fault==='cleanup-error'?'failed':'closed');assert.equal(receipt.fixtureListening,false);assert.equal(receipt.sourceClosed,true);assert.equal(receipt.brokerClosed,true);assert.ok(receipt.remainingProcesses.every(row=>row.kind==='node'));assert.equal(receipt.processSampling.status,'observed-stable');assert.equal(receipt.pss.completeObservedCohort,true);
  if(fault==='cleanup-error'){assert.match(receipt.steps[0].error,/Injected soak cleanup failure/);assert.equal(receipt.steps.find(step=>step.name==='fixture').status,'closed');assert.equal(receipt.steps.find(step=>step.name==='diagnostics').status,'closed');}
  await until(async()=>{for(const row of before.metrics.processes)if(await identity(row.pid)===row.startTicks)return false;return true;},'Owned process identities retirement');
  const samples=(await readFile(join(directory,'source-runtime.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(samples.some(sample=>sample.reason==='interval'));assert.equal(samples.at(-1).reason,'cleanup');
  variants.push({fault:fault??'none',runId:ready.runId,exitCode:code,processes:before.metrics.processes.map(({pid,startTicks,kind,chromiumRole,pssBytes})=>({pid,startTicks,kind,chromiumRole,pssBytes})),samples:samples.length,sourceCleanup:receipt,crashObserved:!!afterCrash?.health.pageCrashed});child=null;
 }
 const report={at:new Date().toISOString(),status:'passed',scope:'Three actual native Linux Sources: normal stop, real Page.crash renderer fault, and injected post-Live cleanup error. Independent per-process PSS/cgroup sampling and crash events survive a dead page; fixture/diagnostics cleanup continues after close errors; every sampled /proc pid+start identity exits. No memory-growth or eight-hour pass claim.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),variants};
 await writeFile(join(output,'contract.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,variants:variants.map(({fault,samples,crashObserved,exitCode})=>({fault,samples,crashObserved,exitCode}))}));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({at:new Date().toISOString(),error:error.stack,variants},null,2));throw error;}
finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await deadline(once(child,'close'),20000,'failed test cleanup').catch(()=>child.kill('SIGKILL'));}}
