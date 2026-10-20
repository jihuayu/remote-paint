import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const ticks=process.platform==='linux'?Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'})):null;
// Linux proof processes only: enumerate descendants of this Node controller,
// and report aggregate counters without exposing browser arguments or URLs.
export async function runtimeMetrics(source,{details=false}={}){
 if(process.platform!=='linux')throw new Error('Linux process metrics required');
 const rows=[];
 const visit=async pid=>{
  try{
   const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   const status=await readFile(`/proc/${pid}/status`,'utf8');
   const row={pid,kind:pid===process.pid?'node':pid===source.broker?.child.pid?'broker':stat.slice(stat.indexOf('(')+1,stat.lastIndexOf(')')).includes('headless')?'chromium':'helper',cpuMs:1000*(Number(fields[11])+Number(fields[12]))/ticks,rssBytes:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024};
   if(details){
    row.startTicks=Number(fields[19]);row.state=fields[0];
    try{
     const rollup=await readFile(`/proc/${pid}/smaps_rollup`,'utf8');
     for(const [key,label]of [['pssBytes','Pss'],['privateCleanBytes','Private_Clean'],['privateDirtyBytes','Private_Dirty'],['swapPssBytes','SwapPss']])row[key]=Number(rollup.match(new RegExp(`^${label}:\\s+(\\d+)`,'m'))?.[1]??0)*1024;
    }catch(error){if(!['ENOENT','ESRCH','EACCES','EPERM'].includes(error.code))throw error;row.pssUnavailable=error.code;}
   }
   rows.push(row);
   const tasks=await readdir(`/proc/${pid}/task`),children=new Set();
   for(const task of tasks){const ids=await readFile(`/proc/${pid}/task/${task}/children`,'utf8').catch(()=> '');for(const id of ids.trim().split(/\s+/))if(id)children.add(Number(id));}
   await Promise.all([...children].map(visit));
  }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
 };
 await visit(process.pid);
 const byKind={};for(const row of rows){const total=byKind[row.kind]??={cpuMs:0,rssBytes:0,processes:0};total.cpuMs+=row.cpuMs;total.rssBytes+=row.rssBytes;total.processes++;}
 const result={atMs:performance.now(),clockTicksPerSecond:ticks,captures:source.stats.captures,byKind};
 if(details){
  result.processes=rows;
  result.pss={bytes:rows.reduce((sum,row)=>sum+(row.pssBytes??0),0),sampledProcesses:rows.filter(row=>Number.isFinite(row.pssBytes)).length,totalProcesses:rows.length};
  // This is the controller's cgroup, not a sum of process RSS. Container
  // namespaces commonly expose its directory as the root of this mount.
  result.cgroup={};
  for(const name of ['memory.current','memory.peak','memory.max','memory.events','memory.swap.current','memory.swap.max']){
   try{const value=(await readFile(`/sys/fs/cgroup/${name}`,'utf8')).trim();result.cgroup[name]=name==='memory.events'?Object.fromEntries(value.split('\n').map(line=>{const [key,count]=line.split(/\s+/);return [key,Number(count)];})):value==='max'?'max':Number(value);}
   catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;result.cgroup[name]={unavailable:error.code};}
  }
 }
 return result;
}
