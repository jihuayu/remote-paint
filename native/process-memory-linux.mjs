// Linux process observer. Live temporal witnesses are not an atomic/frozen
// system snapshot. Missing PSS is unavailable, never a zero-filled total.
import {open,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
export const LINUX_MEMORY_LIMITS=Object.freeze({phaseMs:5000,attempts:2,processes:1024,tasksPerProcess:4096,fileBytes:65536,issueDetails:32});
const clockTicks=process.platform==='linux'?Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8',timeout:2000})):null;
const fail=(code,message,fields={})=>Object.assign(new Error(message),{code,...fields});
const unsigned=(value,label)=>{if(!/^(0|[1-9][0-9]*)$/.test(value))throw fail('LINUX_MEMORY_FORMAT',`Invalid ${label}`);const n=Number(value);if(!Number.isSafeInteger(n))throw fail('LINUX_MEMORY_PRECISION',`Unsafe ${label}`);return n;};
const pidNumber=value=>{const n=Number(value);if(!Number.isInteger(n)||n<1||n>2147483647)throw fail('LINUX_MEMORY_PID','Invalid Linux process ID');return n;};
const bytes=(value,label)=>{const n=unsigned(value,label)*1024;if(!Number.isSafeInteger(n))throw fail('LINUX_MEMORY_PRECISION',`Unsafe ${label} bytes`);return n;};
const line=(text,label,{optional=false,unit=''}={})=>{const rows=text.split('\n').filter(s=>s.startsWith(label+':'));if(!rows.length&&optional)return null;if(rows.length!==1)throw fail('LINUX_MEMORY_FIELD',`Missing or duplicate ${label}`,{field:label});const m=rows[0].match(new RegExp(`^${label}:\\s+([0-9]+)${unit?` ${unit}`:''}\\s*$`));if(!m)throw fail('LINUX_MEMORY_FIELD',`Invalid ${label}`,{field:label});return unit==='kB'?bytes(m[1],label):unsigned(m[1],label);};
export function parseLinuxStat(text,expectedPid){
 expectedPid=pidNumber(expectedPid);const end=text.lastIndexOf(')'),begin=text.indexOf('(');if(begin<2||end<=begin||text.slice(0,begin).trim()!==String(expectedPid))throw fail('LINUX_MEMORY_IDENTITY','Linux stat process identity mismatch',{pid:expectedPid});
 const fields=text.slice(end+1).trim().split(/\s+/);if(fields.length<22||!/^[RSDZTtXxKWPI]$/.test(fields[0]))throw fail('LINUX_MEMORY_FORMAT','Incomplete Linux stat');
 const ppid=unsigned(fields[1],'parent PID'),startTicks=unsigned(fields[19],'start ticks'),userTicks=unsigned(fields[11],'user ticks'),systemTicks=unsigned(fields[12],'system ticks');if(startTicks<=0||ppid>2147483647||!Number.isSafeInteger(userTicks+systemTicks))throw fail('LINUX_MEMORY_IDENTITY','Invalid Linux start/parent identity');
 return {pid:expectedPid,ppid,startTicks,state:fields[0],cpuTicks:userTicks+systemTicks,isChromium:text.slice(begin+1,end).includes('headless')};
}
export function parseLinuxStatus(text,expectedPid){
 expectedPid=pidNumber(expectedPid);const pid=line(text,'Pid'),tgid=line(text,'Tgid'),ppid=line(text,'PPid'),uidRows=text.split('\n').filter(s=>s.startsWith('Uid:'));
 if(pid!==expectedPid||tgid!==expectedPid||uidRows.length!==1)throw fail('LINUX_MEMORY_IDENTITY','Linux status process identity mismatch',{pid:expectedPid});const m=uidRows[0].match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);if(!m)throw fail('LINUX_MEMORY_FIELD','Invalid process UID',{field:'Uid'});
 return {pid,ppid,uids:m.slice(1).map(v=>{const n=unsigned(v,'UID');if(n>4294967295)throw fail('LINUX_MEMORY_IDENTITY','Invalid process UID');return n;}),statusRssBytes:line(text,'VmRSS',{optional:true,unit:'kB'})};
}
export function parseLinuxRollup(text){const result={};for(const[key,label]of[['rollupRssBytes','Rss'],['pssBytes','Pss'],['privateCleanBytes','Private_Clean'],['privateDirtyBytes','Private_Dirty'],['swapPssBytes','SwapPss']])result[key]=line(text,label,{unit:'kB'});return result;}
export function parseLinuxChildren(text){
 const result=new Set();for(const value of text.trim()?text.trim().split(/\s+/):[]){if(!/^[1-9][0-9]*$/.test(value))throw fail('LINUX_MEMORY_FORMAT','Invalid child process inventory');result.add(pidNumber(value));if(result.size>LINUX_MEMORY_LIMITS.processes)throw fail('LINUX_MEMORY_PROCESS_LIMIT','Child process inventory exceeded1024');}return [...result];
}
function check(signal){if(signal?.aborted)throw signal.reason??fail('LINUX_MEMORY_ABORTED','Linux memory read aborted');}
function identity(stat,status){if(stat.ppid!==status.ppid)throw fail('LINUX_MEMORY_IDENTITY','Linux stat/status parent changed',{pid:stat.pid});return {provider:'linux-proc-start-v1',pid:stat.pid,ppid:stat.ppid,startTicks:stat.startTicks,uids:status.uids};}
const sameIdentity=(a,b)=>b&&Array.isArray(b.uids)&&b.uids.length===4&&a.pid===b.pid&&a.ppid===b.ppid&&a.startTicks===b.startTicks&&a.uids.every((v,n)=>v===b.uids[n]);
// Internal bounded descriptor reader. Only the mount-table wrapper permits
// continuations;smaps_rollup and process records retain their single-read rule.
export async function readLinuxMemoryDescriptor(file,signal,{continuations=false}={}){
 check(signal);const buffer=Buffer.allocUnsafeSlow(LINUX_MEMORY_LIMITS.fileBytes+1);let bytesRead=0;
 for(;;){
  const part=await file.read(buffer,bytesRead,buffer.length-bytesRead,null);check(signal);bytesRead+=part.bytesRead;
  if(bytesRead>LINUX_MEMORY_LIMITS.fileBytes)throw fail('LINUX_MEMORY_FILE_LIMIT','Linux process file exceeded64KiB');
  if(!part.bytesRead)return buffer.toString('utf8',0,bytesRead);
  if(!continuations){const tail=Buffer.alloc(1),more=await file.read(tail,0,1,null);check(signal);if(more.bytesRead)throw fail('LINUX_MEMORY_FILE_LIMIT','Linux process file required a partial continuation');return buffer.toString('utf8',0,bytesRead);}
 }
}
async function readLinuxMemoryFile(path,signal,continuations){
 check(signal);const file=await open(path,'r');try{return await readLinuxMemoryDescriptor(file,signal,{continuations});}finally{await file.close();}
}
export async function readLinuxMemoryText(path,signal){return readLinuxMemoryFile(path,signal,false);}
// proc mountinfo uses seq_file and can return multiple legal chunks even when
// the whole table is below64KiB. Read one open descriptor through EOF;the
// cgroup sampler also requires the complete before/after mount tables to match.
export async function readLinuxMountinfoText(signal){return readLinuxMemoryFile('/proc/self/mountinfo',signal,true);}
export class LinuxProcessProbe{
 static async open(pid,{signal}={}){
  if(process.platform!=='linux')throw fail('LINUX_MEMORY_PLATFORM','Linux proc observer requires Linux');pid=pidNumber(pid);check(signal);const directory=await open(`/proc/${pid}`,constants.O_RDONLY|constants.O_DIRECTORY);if(signal?.aborted){await directory.close();check(signal);}return new LinuxProcessProbe(pid,directory,signal);
 }
 constructor(pid,directory,signal){this.pid=pid;this.directory=directory;this.signal=signal;this.closed=false;this.busy=false;this.path=`/proc/self/fd/${directory.fd}`;}
 async sample({details=true,children=true,expectedParent,expectedIdentity}={}){
  if(this.closed)throw fail('LINUX_MEMORY_CLOSED','Linux process probe is closed');if(this.busy)throw fail('LINUX_MEMORY_BUSY','Linux process probe already sampling');this.busy=true;
  try{
   const before=parseLinuxStat(await readLinuxMemoryText(this.path+'/stat',this.signal),this.pid),status=parseLinuxStatus(await readLinuxMemoryText(this.path+'/status',this.signal),this.pid),first=identity(before,status);
   if(expectedParent!==undefined&&first.ppid!==expectedParent||expectedIdentity&&!sameIdentity(first,expectedIdentity))throw fail('LINUX_MEMORY_IDENTITY','Linux expected process identity changed',{pid:this.pid});
   const row={pid:this.pid,ppid:first.ppid,startTicks:first.startTicks,state:before.state,identity:first,cpuTicks:before.cpuTicks,isChromium:before.isChromium,statusRssBytes:status.statusRssBytes,rssBytes:status.statusRssBytes};
   if(details){try{Object.assign(row,parseLinuxRollup(await readLinuxMemoryText(this.path+'/smaps_rollup',this.signal)));row.rssBytes=row.rollupRssBytes;}
    catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM','LINUX_MEMORY_FIELD','LINUX_MEMORY_PRECISION','LINUX_MEMORY_FORMAT'].includes(error.code))throw error;row.pssUnavailable={code:error.code,...(error.field?{field:error.field}:{})};}}
   const childIds=new Set(),issues=[];let issueCount=0;if(children){check(this.signal);const tasks=await readdir(this.path+'/task');check(this.signal);if(tasks.length>LINUX_MEMORY_LIMITS.tasksPerProcess)throw fail('LINUX_MEMORY_TASK_LIMIT','Process task inventory exceeded4096');
    for(const task of tasks){if(!/^[1-9][0-9]*$/.test(task))throw fail('LINUX_MEMORY_FORMAT','Invalid task ID');try{for(const pid of parseLinuxChildren(await readLinuxMemoryText(`${this.path}/task/${task}/children`,this.signal))){childIds.add(pid);if(childIds.size>LINUX_MEMORY_LIMITS.processes)throw fail('LINUX_MEMORY_PROCESS_LIMIT','Process children exceeded1024');}}
     catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;issueCount++;if(issues.length<LINUX_MEMORY_LIMITS.issueDetails)issues.push({pid:this.pid,task:Number(task),code:error.code});}}
   }
   const after=parseLinuxStat(await readLinuxMemoryText(this.path+'/stat',this.signal),this.pid),afterStatus=parseLinuxStatus(await readLinuxMemoryText(this.path+'/status',this.signal),this.pid);if(!sameIdentity(first,identity(after,afterStatus)))throw fail('LINUX_MEMORY_IDENTITY','Linux process identity changed while reading',{pid:this.pid});
   check(this.signal);return {row,children:[...childIds].sort((a,b)=>a-b),issues,issueCount};
  }finally{this.busy=false;}
 }
 async close(){if(!this.closed){this.closed=true;await this.directory.close();}}
}
async function tree(rootPid,{details,signal,expectedRootIdentity}){
 const queue=[{pid:rootPid,parent:undefined}],seen=new Map([[rootPid,undefined]]),rows=[],issues=[];let issueCount=0;
 const issue=value=>{issueCount++;if(issues.length<LINUX_MEMORY_LIMITS.issueDetails)issues.push(value);};
 while(queue.length){check(signal);const{pid,parent}=queue.shift();let probe;
  try{probe=await LinuxProcessProbe.open(pid,{signal});const sampled=await probe.sample({details,expectedParent:parent,expectedIdentity:pid===rootPid?expectedRootIdentity:undefined});rows.push(sampled.row);issueCount+=sampled.issueCount;for(const value of sampled.issues)if(issues.length<LINUX_MEMORY_LIMITS.issueDetails)issues.push(value);
   for(const child of sampled.children){if(seen.has(child)){if(seen.get(child)!==pid)issue({pid:child,code:'LINUX_MEMORY_DUPLICATE_PARENT'});continue;}seen.set(child,pid);if(seen.size>LINUX_MEMORY_LIMITS.processes)throw fail('LINUX_MEMORY_PROCESS_LIMIT','Observed process tree exceeded1024');queue.push({pid:child,parent:pid});}}
  catch(error){if(pid===rootPid||!['ENOENT','ESRCH','EACCES','EPERM','LINUX_MEMORY_IDENTITY'].includes(error.code))throw error;issue({pid,parent,code:error.code});}
  finally{await probe?.close();}
 }
 return {rows:rows.sort((a,b)=>a.pid-b.pid),observedPids:[...seen.keys()].sort((a,b)=>a-b),issues,issueCount};
}
const identitiesEqual=(a,b)=>a.length===b.length&&a.every((r,n)=>sameIdentity(r.identity,b[n].identity));
const sumPss=rows=>{let sum=0;for(const row of rows){sum+=row.pssBytes;if(!Number.isSafeInteger(sum))throw fail('LINUX_MEMORY_PRECISION','Unsafe aggregate PSS bytes');}return sum;};
let active;
export async function sampleLinuxProcessTree({rootPid=process.pid,details=true,expectedRootIdentity}={}){
 if(process.platform!=='linux')throw fail('LINUX_MEMORY_PLATFORM','Linux proc observer requires Linux');rootPid=pidNumber(rootPid);if(active)throw fail('LINUX_MEMORY_BUSY','A Linux process sample is still active');if(!Number.isFinite(clockTicks)||clockTicks<=0)throw fail('LINUX_MEMORY_CLOCK','Invalid Linux clock tick frequency');
 const started=performance.now(),controller=new AbortController(),attempts=[];let timer;
 const work=(async()=>{
  let captured,witness,stable=false,boundRoot=expectedRootIdentity;
  for(let attempt=1;attempt<=LINUX_MEMORY_LIMITS.attempts;attempt++){
   const begin=performance.now();captured=await tree(rootPid,{details,signal:controller.signal,expectedRootIdentity:boundRoot});boundRoot??=captured.rows.find(row=>row.pid===rootPid).identity;witness=await tree(rootPid,{details:false,signal:controller.signal,expectedRootIdentity:boundRoot});stable=captured.issueCount===0&&witness.issueCount===0&&identitiesEqual(captured.rows,witness.rows);
   attempts.push({attempt,elapsedMs:performance.now()-begin,status:stable?'observed-stable':'changed-or-incomplete',capturedProcesses:captured.observedPids.length,witnessProcesses:witness.observedPids.length,issueCount:captured.issueCount+witness.issueCount,issues:[...captured.issues,...witness.issues].slice(0,LINUX_MEMORY_LIMITS.issueDetails)});if(stable)break;
  }
  check(controller.signal);if(performance.now()-started>LINUX_MEMORY_LIMITS.phaseMs)throw fail('LINUX_MEMORY_TIMEOUT','Linux process memory sample exceeded5s');const rows=captured.rows.map(row=>({...row,cpuMs:1000*row.cpuTicks/clockTicks})),available=rows.filter(row=>Number.isSafeInteger(row.pssBytes)),complete=details&&stable&&available.length===captured.observedPids.length;
  return {processes:rows,clockTicksPerSecond:clockTicks,sampling:{provider:'linux-pinned-proc-v1',status:stable?'observed-stable':'incomplete',rootPid,rootIdentity:rows.find(row=>row.pid===rootPid)?.identity,elapsedMs:performance.now()-started,deadlineMs:LINUX_MEMORY_LIMITS.phaseMs,observedProcesses:captured.observedPids.length,readProcesses:rows.length,attempts,scope:'Live pinned-proc-directory reads with before/after PID/startTicks/UID/parent identity and matching observed descendant witnesses;task children may omit exiting processes. Not atomic,not frozen,not a complete-system census.'},...(details?{pss:{bytes:complete?sumPss(available):null,availableBytes:sumPss(available),completeObservedCohort:complete,sampledProcesses:available.length,totalProcesses:captured.observedPids.length,unavailable:rows.filter(row=>row.pssUnavailable).map(row=>({pid:row.pid,...row.pssUnavailable})),scope:'Proportional bytes over the explicitly observed cohort;not unique physical session memory. Missing fields/permission/identity/unstable cohort prevent a complete total.'}}:{})};
 })();active=work;work.finally(()=>{if(active===work)active=null;}).catch(()=>{});
 try{const result=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=fail('LINUX_MEMORY_TIMEOUT','Linux process memory sample exceeded5s',{deadlineMs:LINUX_MEMORY_LIMITS.phaseMs});controller.abort(error);reject(error);},LINUX_MEMORY_LIMITS.phaseMs);})]);if(performance.now()-started>LINUX_MEMORY_LIMITS.phaseMs)throw fail('LINUX_MEMORY_TIMEOUT','Linux process memory sample exceeded5s');return result;}
 finally{clearTimeout(timer);}
}
