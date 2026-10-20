import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {LinuxProcessProbe,sampleLinuxProcessTree,parseLinuxStat,parseLinuxStatus,parseLinuxRollup,parseLinuxChildren,LINUX_MEMORY_LIMITS} from '../native/process-memory-linux.mjs';
const linux={skip:process.platform!=='linux'},fixture=fileURLToPath(new URL('./fixtures/native-memory-child.mjs',import.meta.url)),treeFixture=fileURLToPath(new URL('./fixtures/linux-memory-tree.mjs',import.meta.url));
const receive=async(child,event)=>{for(;;){const[m]=await once(child,'message');if(m.event===event)return m;}};
async function stop(child,{tree=false}={}){if(child.exitCode!==null||child.signalCode!==null)return;const end=once(child,'close');tree?child.send('close'):child.kill('SIGKILL');let timer;try{await Promise.race([end,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Owned Linux fixture cleanup timed out'));},5000);})]);}finally{clearTimeout(timer);}}
const stat=()=>{const fields=Array(50).fill('0');fields[0]='S';fields[1]='1';fields[11]='12';fields[12]='3';fields[19]='100';return `42 (headless ) name) ${fields.join(' ')}\n`;};
const status=()=>`Name:\tfixture\nTgid:\t42\nPid:\t42\nPPid:\t1\nUid:\t0\t0\t0\t0\nVmRSS:\t1024 kB\n`;
const rollup=()=>`000000-ffffff ---p 00000000 00:00 0 [rollup]\nRss:                 1024 kB\nPss:                  512 kB\nPrivate_Clean:         10 kB\nPrivate_Dirty:        100 kB\nSwapPss:                0 kB\n`;
test('Linux stat/status parser binds PID,parent,start and all UIDs despite parentheses in comm;rejects invalid identities',()=>{
 assert.equal(parseLinuxStat(stat(),42).startTicks,100);assert.equal(parseLinuxStat(stat(),42).cpuTicks,15);assert.deepEqual(parseLinuxStatus(status(),42).uids,[0,0,0,0]);
 for(const text of [stat().replace('42 (','43 ('),stat().replace('100','0'),stat().replace(' S ',' ? '),stat().replace(' S 1 ',' S 9007199254740992 '),stat().slice(0,40)])assert.throws(()=>parseLinuxStat(text,42));
 for(const text of [status().replace('Tgid:\t42','Tgid:\t43'),status()+'Uid:\t0\t0\t0\t0\n',status().replace('Uid:\t0','Uid:\t4294967296'),status().replace('VmRSS:\t1024','VmRSS:\t9007199254740992')])assert.throws(()=>parseLinuxStatus(text,42));
 assert.equal(parseLinuxStatus(status().replace('VmRSS:\t1024 kB\n',''),42).statusRssBytes,null);
});
test('Linux rollup requires every exact field;missing,duplicate,invalid and unsafe values never become zero-filled PSS',()=>{
 const parsed=parseLinuxRollup(rollup());assert.equal(parsed.pssBytes,512*1024);assert.equal(parsed.swapPssBytes,0);
 for(const text of [rollup().replace(/^Pss:.*\n/m,''),rollup()+'Pss: 1 kB\n',rollup().replace('512 kB','-1 kB'),rollup().replace('512 kB','9007199254740992 kB'),rollup().replace('512 kB','512 MB'),rollup().replace(/^SwapPss:.*\n/m,'')])assert.throws(()=>parseLinuxRollup(text));
});
test('Linux children inventory is bounded,unique and rejects unsafe or malformed process IDs',()=>{
 assert.deepEqual(parseLinuxChildren(' 12 13 12\n'),[12,13]);assert.deepEqual(parseLinuxChildren(''),[]);for(const text of ['0','-1','2147483648','12 bad',Array.from({length:1025},(_,n)=>n+1).join(' ')])assert.throws(()=>parseLinuxChildren(text));
});
test('actual touched64MiB Linux child raises PSS/private dirty/RSS and keeps the same pinned process identity',linux,async t=>{
 const child=fork(fixture,['allocate'],{execArgv:['--expose-gc'],stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready');let probe;
 try{await ready;probe=await LinuxProcessProbe.open(child.pid);const before=(await probe.sample({children:false})).row;assert.equal(before.pssUnavailable,undefined);const response=receive(child,'allocated');child.send('allocate');const own=await response,after=(await probe.sample({children:false,expectedIdentity:before.identity})).row;
  assert.deepEqual(after.identity,before.identity);assert.equal(after.ppid,process.pid);assert.ok(after.pssBytes-before.pssBytes>=48*1024*1024);assert.ok(after.privateDirtyBytes-before.privateDirtyBytes>=48*1024*1024);assert.ok(after.rssBytes-before.rssBytes>=48*1024*1024);assert.ok(Math.abs(own.rssBytes-after.rssBytes)<16*1024*1024);assert.equal(after.identity.uids[0],process.getuid());t.diagnostic(JSON.stringify({scope:'ActualLinux64MiBtouchedallocation;pinnedprocFD;notamemoryreleasepromise',before,after}));
 }finally{await probe?.close();await stop(child);}
});
test('actual dead process stays dead through its pinned proc FD;no cached row or fresh PID substitution',linux,async()=>{
 const child=fork(fixture,['allocate'],{stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready');let probe;
 try{await ready;probe=await LinuxProcessProbe.open(child.pid);const first=(await probe.sample({children:false})).row;await stop(child);await assert.rejects(probe.sample({children:false,expectedIdentity:first.identity}),e=>['ESRCH','ENOENT'].includes(e.code));}
 finally{await probe?.close();await stop(child);}await assert.rejects(probe.sample(),e=>e.code==='LINUX_MEMORY_CLOSED');
});
test('actual parent/child temporal inventories,PSS coverage,expected-root identity and one pending sample stay bounded',linux,async t=>{
 const child=fork(treeFixture,[],{stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready');try{
  const info=await ready,first=await sampleLinuxProcessTree({rootPid:child.pid});assert.equal(first.sampling.status,'observed-stable');assert.equal(first.pss.completeObservedCohort,true);assert.equal(first.pss.sampledProcesses,2);assert.deepEqual(first.processes.map(p=>p.pid).sort((a,b)=>a-b),[child.pid,info.leafPid].sort((a,b)=>a-b));assert.equal(first.processes.find(p=>p.pid===info.leafPid).ppid,child.pid);assert.ok(first.pss.bytes>0);assert.ok(first.sampling.elapsedMs<5000);
  await assert.rejects(sampleLinuxProcessTree({rootPid:child.pid,expectedRootIdentity:{...first.sampling.rootIdentity,startTicks:first.sampling.rootIdentity.startTicks+1}}),e=>e.code==='LINUX_MEMORY_IDENTITY');const a=sampleLinuxProcessTree({rootPid:child.pid}),b=sampleLinuxProcessTree({rootPid:child.pid});await assert.rejects(b,e=>e.code==='LINUX_MEMORY_BUSY');await a;
  const stopped=receive(child,'leaf-stopped');child.send('stop-leaf');await stopped;const last=await sampleLinuxProcessTree({rootPid:child.pid,expectedRootIdentity:first.sampling.rootIdentity});assert.equal(last.pss.completeObservedCohort,true);assert.equal(last.pss.totalProcesses,1);assert.deepEqual(last.processes.map(p=>p.pid),[child.pid]);t.diagnostic(JSON.stringify({scope:'Actualownedparent+leaf/freshcompleteobservedcohort/leafreaped',first:first.sampling,last:last.sampling,limits:LINUX_MEMORY_LIMITS}));
 }finally{await stop(child,{tree:true});}
});
test('actual same-UID undumpable target reports unavailable PSS and null complete total instead of a fabricated zero',linux,async t=>{
 const child=spawn('python3',[fileURLToPath(new URL('./fixtures/linux-memory-undumpable.py',import.meta.url))],{stdio:['pipe','pipe','pipe']}),lines=createInterface({input:child.stdout});try{
  const[line]=await once(lines,'line'),ready=JSON.parse(line);assert.equal(ready.dumpable,0);assert.equal(ready.uid,process.getuid());const sampled=await sampleLinuxProcessTree({rootPid:child.pid});if(sampled.pss.completeObservedCohort){t.skip('Host CAP_SYS_PTRACE permits actual undumpable target;denial not induced');return;}
  assert.equal(sampled.sampling.status,'observed-stable');assert.equal(sampled.pss.bytes,null);assert.equal(sampled.pss.availableBytes,0);assert.equal(sampled.pss.sampledProcesses,0);assert.equal(sampled.pss.totalProcesses,1);assert.match(sampled.pss.unavailable[0].code,/EACCES|EPERM/);assert.equal(sampled.processes[0].pssBytes,undefined);t.diagnostic(JSON.stringify({scope:'ActualPR_SET_DUMPABLE0/sameUID/kerneldenial;nozerosubstitution',sampling:sampled.sampling,pss:sampled.pss}));
 }finally{lines.close();await stop(child);}
});
test('actual repeated probes close proc and data FDs on success and on expected-identity rejection',linux,async()=>{
 const child=fork(fixture,['allocate'],{stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready');try{await ready;let probe=await LinuxProcessProbe.open(child.pid);await probe.sample({children:false});await probe.close();const before=(await readdir('/proc/self/fd')).length;
  for(let n=0;n<20;n++){probe=await LinuxProcessProbe.open(child.pid);try{const sampled=await probe.sample({children:false});await assert.rejects(probe.sample({children:false,expectedIdentity:{...sampled.row.identity,startTicks:sampled.row.startTicks+1}}),e=>e.code==='LINUX_MEMORY_IDENTITY');}finally{await probe.close();}}
  assert.ok((await readdir('/proc/self/fd')).length<=before+1,'Repeated probes leaked file descriptors');
 }finally{await stop(child);}
});
test('actual sampler-host SIGSTOP beyond5s is a deadline failure after resume and never a late successful sample',linux,async t=>{
 const child=fork(new URL('./fixtures/linux-memory-phase.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']}),ready=receive(child,'ready');try{
  await ready;const result=receive(child,'result'),started=performance.now();await new Promise(resolve=>setTimeout(resolve,5500));assert.equal(child.kill('SIGCONT'),true);const receipt=await result;assert.equal(receipt.passed,false);assert.equal(receipt.code,'LINUX_MEMORY_TIMEOUT');assert.ok(performance.now()-started>=5000);t.diagnostic(JSON.stringify({scope:'ExplicitactualobserverhostSIGSTOP/SIGCONT;unchanged5sdeadline',elapsedMs:performance.now()-started,receipt}));
 }finally{await stop(child);}
});
