import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const ticks=process.platform==='linux'?Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'})):null;
// Linux proof processes only: enumerate descendants of this Node controller,
// and report aggregate counters without exposing browser arguments or URLs.
export async function runtimeMetrics(source){
 if(process.platform!=='linux')throw new Error('Linux process metrics required');
 const rows=[];
 const visit=async pid=>{
  try{
   const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   const status=await readFile(`/proc/${pid}/status`,'utf8');
   rows.push({pid,kind:pid===process.pid?'node':pid===source.broker?.child.pid?'broker':stat.slice(stat.indexOf('(')+1,stat.lastIndexOf(')')).includes('headless')?'chromium':'helper',cpuMs:1000*(Number(fields[11])+Number(fields[12]))/ticks,rssBytes:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]??0)*1024});
   const tasks=await readdir(`/proc/${pid}/task`),children=new Set();
   for(const task of tasks){const ids=await readFile(`/proc/${pid}/task/${task}/children`,'utf8').catch(()=> '');for(const id of ids.trim().split(/\s+/))if(id)children.add(Number(id));}
   await Promise.all([...children].map(visit));
  }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
 };
 await visit(process.pid);
 const byKind={};for(const row of rows){const total=byKind[row.kind]??={cpuMs:0,rssBytes:0,processes:0};total.cpuMs+=row.cpuMs;total.rssBytes+=row.rssBytes;total.processes++;}
 return {atMs:performance.now(),clockTicksPerSecond:ticks,captures:source.stats.captures,byKind};
}
