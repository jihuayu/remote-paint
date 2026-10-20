import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sampleProcessRss,parseProcessRss,RSS_SAMPLE_LIMITS} from './process-rss-sample.mjs';
const own=[{id:process.pid,type:'test-node'}],fixture=fileURLToPath(new URL('./fixtures/rss-sample-child.mjs',import.meta.url));
const launcher=(mode,path='unused',children=[])=>()=>{reaped(children);const child=spawn(process.execPath,[fixture,mode,path,String(process.pid)],{stdio:['ignore','pipe','pipe']});children.push(child);return child;};
function reaped(children){assert.ok(children.every(child=>child.exitCode!==null||child.signalCode!==null),'Every exact owned child must exit before retry/return');}

test('RSS samples actual current-process bytes through absolute ps',async t=>{
 const receipts=[],sample=await sampleProcessRss(own,{onAttempt:r=>receipts.push(r)});assert.equal(sample.processes.length,1);assert.equal(sample.processes[0].pid,process.pid);assert.equal(sample.processes[0].kind,'test-node');assert.ok(sample.processes[0].bytes>0);assert.equal(receipts.length,1);assert.equal(receipts[0].closed,true);assert.equal(receipts[0].exitCode,0);assert.equal(sample.sampling.phaseDeadlineMs,5000);t.diagnostic(JSON.stringify({scope:'actual ps',sampling:sample.sampling}));
});
test('RSS parsing rejects missing,duplicate,foreign andunsafe data without filling zero rows',()=>{
 assert.deepEqual(parseProcessRss(`${process.pid} 123\n`,own),[{pid:process.pid,bytes:125952,kind:'test-node'}]);
 for(const text of ['',`${process.pid} -1`,`${process.pid} abc`,`${process.pid} 9007199254740992`,`${process.pid} 2\n${process.pid} 3`,`${process.pid+1} 4`])assert.throws(()=>parseProcessRss(text,own),e=>e.code==='RSS_INVALID_OUTPUT');
 assert.throws(()=>parseProcessRss(`${process.pid} 1`,[...own,{id:process.pid+1,type:'absent'}]),e=>e.code==='RSS_MISSING_PROCESS');
 for(const rows of [[],[{id:0}],[{id:9007199254740992}],[...own,...own]])assert.throws(()=>parseProcessRss('1 1',rows),e=>e.code==='RSS_INVALID_INVENTORY');
});
test('RSS retries once only after an actual timed-out subprocess exits by SIGKILL',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-rss-')),children=[],receipts=[];
 try{const sample=await sampleProcessRss(own,{spawnProcess:launcher('timeout-once',join(directory,'counter'),children),onAttempt:r=>receipts.push(r)});assert.equal(receipts.length,2);assert.equal(receipts[0].status,'RSS_ATTEMPT_TIMEOUT');assert.equal(receipts[0].signal,'SIGKILL');assert.equal(receipts[0].closed,true);assert.equal(receipts[1].status,'passed');assert.equal(sample.processes[0].bytes,256*1024);assert.ok(sample.sampling.elapsedMs<5000);reaped(children);t.diagnostic(JSON.stringify({scope:'fault child:first deadline then fresh fixture output',receipts,elapsedMs:sample.sampling.elapsedMs}));}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});}
});
test('RSS two actual hangs fail within the unchanged phase and reap both children',async t=>{
 const children=[],receipts=[],start=performance.now();
 try{await assert.rejects(sampleProcessRss(own,{spawnProcess:launcher('always-timeout','unused',children),onAttempt:r=>receipts.push(r)}),e=>e.code==='RSS_ATTEMPT_TIMEOUT'&&e.attempts.length===2);assert.equal(receipts.length,2);assert.ok(receipts.every(r=>r.closed&&r.signal==='SIGKILL'));assert.ok(performance.now()-start<5000);reaped(children);t.diagnostic(JSON.stringify({scope:'two actual killed fault children;terminal failure',receipts,elapsedMs:performance.now()-start}));}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
test('RSS exit,syntax andoutput-limit failures do not obtain a retry',async()=>{
 for(const [mode,expected]of [['exit','RSS_PROCESS_FAILED'],['malformed','RSS_INVALID_OUTPUT'],['overflow','RSS_OUTPUT_LIMIT']]){const children=[],receipts=[];await assert.rejects(sampleProcessRss(own,{spawnProcess:launcher(mode,'unused',children),onAttempt:r=>receipts.push(r)}),e=>e.code===expected);assert.equal(children.length,1);assert.equal(receipts.length,1);assert.equal(receipts[0].status,expected);reaped(children);}
});
test('RSS missing executable fails once andrecords absence of a spawned identity',async()=>{
 const receipts=[];await assert.rejects(sampleProcessRss(own,{spawnProcess:()=>spawn('/remote-paint-missing-rss-binary',[],{stdio:['ignore','pipe','pipe']}),onAttempt:r=>receipts.push(r)}),e=>e.code==='RSS_SPAWN_FAILED');assert.equal(receipts.length,1);assert.equal(receipts[0].childPid,null);
});
test('RSS never retries an unreaped owned subprocess anddestroys its local pipe handles',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const child=new EventEmitter();let kills=0,unrefs=0;Object.assign(child,{pid:123,stdout:new PassThrough(),stderr:new PassThrough(),kill(signal){assert.equal(signal,'SIGKILL');kills++;},unref(){unrefs++;}});const receipts=[],promise=sampleProcessRss(own,{spawnProcess:()=>child,onAttempt:r=>receipts.push(r)}),rejected=assert.rejects(promise,e=>e.code==='RSS_PROCESS_NOT_REAPED'&&e.attempts.length===1);t.mock.timers.tick(RSS_SAMPLE_LIMITS.attemptMs);t.mock.timers.tick(RSS_SAMPLE_LIMITS.reapMs);await rejected;assert.equal(kills,1);assert.equal(unrefs,1);assert.equal(receipts[0].closed,false);assert.equal(child.stdout.destroyed,true);assert.equal(child.stderr.destroyed,true);
});
