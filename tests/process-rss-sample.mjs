import {spawn} from 'node:child_process';
export const RSS_SAMPLE_LIMITS=Object.freeze({attemptMs:2000,reapMs:250,attempts:2,phaseMs:5000,stdoutBytes:64*1024,stderrBytes:8192,processes:1024});
const failure=(code,message)=>Object.assign(new Error(message),{code});
function inventory(processInfo){
 if(!Array.isArray(processInfo)||!processInfo.length||processInfo.length>RSS_SAMPLE_LIMITS.processes)throw failure('RSS_INVALID_INVENTORY','Invalid RSS process inventory');
 const requested=new Map();for(const row of processInfo){const pid=Number(row.id);if(!Number.isSafeInteger(pid)||pid<=0||requested.has(pid))throw failure('RSS_INVALID_INVENTORY','Invalid RSS process identity');requested.set(pid,row.type);}return requested;
}
export function parseProcessRss(text,processInfo){
 const requested=inventory(processInfo),seen=new Set(),processes=[];
 for(const line of text.trim().split('\n')){
  const match=/^\s*([1-9]\d*)\s+(\d+)\s*$/.exec(line);if(!match)throw failure('RSS_INVALID_OUTPUT','Invalid RSS process output');
  const pid=Number(match[1]),bytes=Number(match[2])*1024;if(!requested.has(pid)||seen.has(pid)||!Number.isSafeInteger(bytes)||bytes<0)throw failure('RSS_INVALID_OUTPUT','Unexpected or invalid RSS process row');seen.add(pid);processes.push({pid,bytes,kind:requested.get(pid)});
 }
 if(seen.size!==requested.size)throw failure('RSS_MISSING_PROCESS','RSS inventory changed or requested processes are missing');return processes;
}
function attempt(ids,spawnProcess){
 const started=performance.now(),startedAt=new Date().toISOString();
 return new Promise(resolve=>{
  let child,stdout='',stderrBytes=0,timer,reapTimer,done=false,timedOut=false,terminating=false,problem;
  const finish=(code,signal,closed)=>{
   if(done)return;done=true;clearTimeout(timer);clearTimeout(reapTimer);
   child?.stdout?.off('data',onOutput);child?.stderr?.off('data',onErrorOutput);
   if(!closed){child?.stdout?.destroy();child?.stderr?.destroy();child?.unref();}
   const elapsedMs=performance.now()-started;
   const error=!closed?failure('RSS_PROCESS_NOT_REAPED','RSS subprocess did not close after SIGKILL'):problem??(timedOut||elapsedMs>RSS_SAMPLE_LIMITS.attemptMs?failure('RSS_ATTEMPT_TIMEOUT','RSS subprocess exceeded its2s deadline'):code!==0?failure('RSS_PROCESS_FAILED','RSS subprocess failed'):null);
   resolve({stdout:error?null:stdout,error,receipt:{startedAt,elapsedMs,childPid:child?.pid??null,closed,exitCode:code??null,signal:signal??null,status:error?.code??'passed',timeoutMs:RSS_SAMPLE_LIMITS.attemptMs,reapGraceMs:RSS_SAMPLE_LIMITS.reapMs,stdoutBytes:Buffer.byteLength(stdout),stderrBytes}});stdout='';
  };
  const kill=()=>{if(terminating||done)return;terminating=true;clearTimeout(timer);reapTimer=setTimeout(()=>finish(null,null,false),RSS_SAMPLE_LIMITS.reapMs);try{child.kill('SIGKILL');}catch{problem??=failure('RSS_KILL_FAILED','RSS subprocess termination failed');}};
  const onOutput=bytes=>{if(done||problem)return;if(Buffer.byteLength(stdout)+bytes.length>RSS_SAMPLE_LIMITS.stdoutBytes){problem=failure('RSS_OUTPUT_LIMIT','RSS stdout limit exceeded');kill();return;}stdout+=bytes.toString('utf8');};
  const onErrorOutput=bytes=>{if(done||problem)return;stderrBytes+=bytes.length;if(stderrBytes>RSS_SAMPLE_LIMITS.stderrBytes&&!problem){problem=failure('RSS_OUTPUT_LIMIT','RSS stderr limit exceeded');kill();}};
  try{child=spawnProcess('/bin/ps',['-o','pid=,rss=','-p',ids.join(',')],{stdio:['ignore','pipe','pipe']});}catch{problem=failure('RSS_SPAWN_FAILED','RSS subprocess could not start');finish(null,null,true);return;}
  child.stdout.on('data',onOutput);child.stderr.on('data',onErrorOutput);child.once('error',()=>{problem=failure('RSS_SPAWN_FAILED','RSS subprocess could not start');if(!child.pid)finish(null,null,true);});child.once('close',(code,signal)=>finish(code,signal,true));
  timer=setTimeout(()=>{timedOut=true;kill();},RSS_SAMPLE_LIMITS.attemptMs);
 });
}
// Retry only an observed deadline whose exact owned subprocess has closed.
// Missing/invalid data,spawn/exit errors andan unreaped child fail immediately.
// Every successful result is freshly measured; no previous sample substitutes.
export async function sampleProcessRss(processInfo,{spawnProcess=spawn,onAttempt=async()=>{}}={}){
 const requested=inventory(processInfo),ids=[...requested.keys()],started=performance.now(),attempts=[];
 for(let n=1;n<=RSS_SAMPLE_LIMITS.attempts;n++){
  const result=await attempt(ids,spawnProcess);let processes;
  if(!result.error)try{processes=parseProcessRss(result.stdout,processInfo);}catch(error){result.error=error;}
  const receipt={attempt:n,...result.receipt,status:result.error?.code??'passed'};attempts.push(receipt);await onAttempt(receipt);
  if(performance.now()-started>RSS_SAMPLE_LIMITS.phaseMs){const error=failure('RSS_PHASE_DEADLINE','RSS sample exceeded its5s phase deadline');error.attempts=attempts;throw error;}
  if(!result.error)return {processes,sampling:{requestedPids:ids,attempts,elapsedMs:performance.now()-started,phaseDeadlineMs:RSS_SAMPLE_LIMITS.phaseMs}};
  if(result.error.code!=='RSS_ATTEMPT_TIMEOUT'||!result.receipt.closed||n===RSS_SAMPLE_LIMITS.attempts){result.error.attempts=attempts;throw result.error;}
 }
}
