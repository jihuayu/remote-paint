// Resolve the actual unified hierarchy from process membership and mountinfo;
// never assume /sys/fs/cgroup is this process's cgroup or a Session total.
import {open,constants} from 'node:fs/promises';
import {join} from 'node:path';
import {readLinuxMemoryText,LINUX_MEMORY_LIMITS} from './process-memory-linux.mjs';
const fail=(code,message,fields={})=>Object.assign(new Error(message),{code,...fields});
const numeric=value=>{if(!/^(0|[1-9][0-9]*)$/.test(value))throw fail('LINUX_CGROUP_FORMAT','Invalid cgroup counter');const n=Number(value);if(!Number.isSafeInteger(n))throw fail('LINUX_CGROUP_PRECISION','Unsafe cgroup counter');return n;};
const decode=value=>value.replace(/\\(040|011|012|134)/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
const validPath=value=>value.startsWith('/')&&!/[\x00-\x1f\x7f]/.test(value)&&!value.split('/').some(part=>part==='..'||part==='.');
export function resolveLinuxCgroupLocation(membership,mountinfo){
 const rows=membership.trim().split('\n').filter(line=>line.startsWith('0::'));if(rows.length!==1)throw fail('LINUX_CGROUP_MEMBERSHIP','Unified cgroup membership is unavailable or ambiguous');const cgroupPath=rows[0].slice(3);if(!validPath(cgroupPath))throw fail('LINUX_CGROUP_MEMBERSHIP','Invalid cgroup membership path');
 const candidates=[];for(const line of mountinfo.trim().split('\n')){const parts=line.split(' - ');if(parts.length!==2||parts[1].split(' ')[0]!=='cgroup2')continue;const fields=parts[0].split(' ');if(fields.length<6)throw fail('LINUX_CGROUP_MOUNT','Invalid cgroup mount record');const mountRoot=decode(fields[3]),mountpoint=decode(fields[4]);if(!validPath(mountRoot)||!validPath(mountpoint))throw fail('LINUX_CGROUP_MOUNT','Invalid cgroup mount path');if(mountRoot!=='/'&&cgroupPath!==mountRoot&&!cgroupPath.startsWith(mountRoot+'/'))continue;const relative=mountRoot==='/'?cgroupPath.slice(1):cgroupPath.slice(mountRoot.length).replace(/^\//,'');candidates.push({cgroupPath,mountRoot,mountpoint,directory:join(mountpoint,relative)});}
 candidates.sort((a,b)=>b.mountRoot.length-a.mountRoot.length||Number(b.mountpoint==='/sys/fs/cgroup')-Number(a.mountpoint==='/sys/fs/cgroup')||a.mountpoint.localeCompare(b.mountpoint));if(!candidates.length)throw fail('LINUX_CGROUP_MOUNT','No visible unified cgroup mount covers process membership');return candidates[0];
}
export function parseLinuxCgroupCounters(text){
 const result={};for(const line of text.trim()?text.trim().split('\n'):[]){const m=line.match(/^([a-z][a-z0-9_]*)\s+([0-9]+)$/);if(!m||Object.hasOwn(result,m[1]))throw fail('LINUX_CGROUP_FORMAT','Invalid or duplicate cgroup counter');result[m[1]]=numeric(m[2]);}if(!Object.keys(result).length)throw fail('LINUX_CGROUP_FORMAT','Empty cgroup counters');return result;
}
export function parseLinuxCgroupProcs(text){
 const rows=text.trim()?text.trim().split(/\s+/):[];if(rows.length>LINUX_MEMORY_LIMITS.processes)throw fail('LINUX_CGROUP_PROCESS_LIMIT','Cgroup membership exceeded1024 entries');const pids=new Set();let invisibleEntries=0,duplicateEntries=0;
 for(const value of rows){const n=numeric(value);if(n>2147483647)throw fail('LINUX_CGROUP_FORMAT','Invalid cgroup process ID');if(n===0){invisibleEntries++;continue;}if(pids.has(n))duplicateEntries++;pids.add(n);}return {pids:[...pids].sort((a,b)=>a-b),invisibleEntries,duplicateEntries};
}
const names=['memory.current','memory.peak','memory.max','memory.events','memory.swap.current','memory.swap.max','memory.stat'];
let active;
export async function sampleLinuxCgroupMemory({observedPids=[]}={}){
 if(process.platform!=='linux')throw fail('LINUX_CGROUP_PLATFORM','Linux cgroup observer requires Linux');if(active)throw fail('LINUX_CGROUP_BUSY','A cgroup sample is still active');const controller=new AbortController(),started=performance.now();let timer;
 const work=(async()=>{let directory,location;try{
   const membership=await readLinuxMemoryText('/proc/self/cgroup',controller.signal);location=resolveLinuxCgroupLocation(membership,await readLinuxMemoryText('/proc/self/mountinfo',controller.signal));directory=await open(location.directory,constants.O_RDONLY|constants.O_DIRECTORY);const path=`/proc/self/fd/${directory.fd}`,before=parseLinuxCgroupProcs(await readLinuxMemoryText(path+'/cgroup.procs',controller.signal)),result={};
   for(const name of names){try{const text=(await readLinuxMemoryText(path+'/'+name,controller.signal)).trim();result[name]=['memory.events','memory.stat'].includes(name)?parseLinuxCgroupCounters(text):text==='max'&&['memory.max','memory.swap.max'].includes(name)?'max':numeric(text);}
    catch(error){if(controller.signal.aborted)throw controller.signal.reason;result[name]={unavailable:error.code??'LINUX_CGROUP_READ'};}}
   const after=parseLinuxCgroupProcs(await readLinuxMemoryText(path+'/cgroup.procs',controller.signal)),afterMembership=await readLinuxMemoryText('/proc/self/cgroup',controller.signal);if(membership!==afterMembership||!before.pids.includes(process.pid)||!after.pids.includes(process.pid))throw fail('LINUX_CGROUP_CHANGED','Process cgroup membership changed while reading');
   const observed=new Set(observedPids);result.provenance={provider:'linux-pinned-cgroup-v1',status:'observed',...location,processMembershipConfirmed:true,elapsedMs:performance.now()-started,deadlineMs:5000,membersBefore:before,membersAfter:after,membershipWitnessStable:JSON.stringify(before)===JSON.stringify(after),outsideObservedPids:after.pids.filter(pid=>!observed.has(pid)),scope:'Actual cgroup and descendants resolved from process membership+mountinfo. Includes kernel/filecache and processes outside the observed tree. PID membership lists are live temporal witnesses,not atomic or unique Session attribution.'};return result;
  }catch(error){if(controller.signal.aborted)throw controller.signal.reason;if(['LINUX_CGROUP_PRECISION','LINUX_MEMORY_PRECISION','LINUX_MEMORY_FILE_LIMIT','LINUX_CGROUP_PROCESS_LIMIT'].includes(error.code))throw error;return Object.fromEntries([...names.map(name=>[name,{unavailable:error.code??'LINUX_CGROUP_READ'}]),['provenance',{provider:'linux-pinned-cgroup-v1',status:'unavailable',code:error.code??'LINUX_CGROUP_READ',...(location?{...location}:{}),elapsedMs:performance.now()-started,scope:'Cgroup location/ownership could not be verified;no root-mount fallback.'}]]);}
  finally{await directory?.close();}
 })();active=work;work.finally(()=>{if(active===work)active=null;}).catch(()=>{});
 try{const result=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{const error=fail('LINUX_CGROUP_TIMEOUT','Cgroup memory sample exceeded5s');controller.abort(error);reject(error);},5000);})]);if(performance.now()-started>5000)throw fail('LINUX_CGROUP_TIMEOUT','Cgroup memory sample exceeded5s');return result;}
 finally{clearTimeout(timer);}
}
