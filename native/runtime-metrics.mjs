import {sampleLinuxProcessTree} from './process-memory-linux.mjs';
import {sampleLinuxCgroupMemory} from './cgroup-memory-linux.mjs';
// The controller's observed descendants and actual cgroup are separate scopes.
// No browser arguments/URLs are read. Missing observations stay explicit.
export async function runtimeMetrics(source,{details=false}={}){
 const sampled=await sampleLinuxProcessTree({details}),rows=sampled.processes.map(({isChromium,...row})=>({...row,kind:row.pid===process.pid?'node':row.pid===source.broker?.child.pid?'broker':isChromium?'chromium':'helper'})),byKind={};
 for(const row of rows){const total=byKind[row.kind]??={cpuMs:0,rssBytes:0,availableRssBytes:0,sampledRssProcesses:0,processes:0};total.cpuMs+=row.cpuMs;total.processes++;if(Number.isSafeInteger(row.rssBytes)){total.availableRssBytes+=row.rssBytes;total.sampledRssProcesses++;}}
 for(const total of Object.values(byKind))total.rssBytes=sampled.sampling.status==='observed-stable'&&total.sampledRssProcesses===total.processes?total.availableRssBytes:null;
 const result={atMs:performance.now(),clockTicksPerSecond:sampled.clockTicksPerSecond,captures:source.stats.captures,byKind,processSampling:sampled.sampling};
 if(details){result.processes=rows;result.pss=sampled.pss;result.cgroup=await sampleLinuxCgroupMemory({observedPids:rows.map(row=>row.pid)});}
 return result;
}
