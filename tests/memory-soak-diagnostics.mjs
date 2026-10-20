import {appendFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {runtimeMetrics} from '../native/runtime-metrics.mjs';

export async function atomicJson(directory,name,value){
 const path=join(directory,name);await writeFile(`${path}.tmp`,JSON.stringify(value));await rename(`${path}.tmp`,path);
}
export async function deadline(operation,milliseconds,label){
 let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} diagnostic timed out`)),milliseconds);})]);}finally{clearTimeout(timer);}
}
// No page evaluation or Broker request is needed to sample a dead renderer.
// Serial writes avoid racing an interval, a crash event and final cleanup.
export async function startMemoryDiagnostics({source,directory,runId,interval=10000}){
 const session=await source.browser.newBrowserCDPSession();
 const health={pageCrashed:false,browserDisconnected:false,brokerExited:false};
 let closing=false,stopped=false,timer,writes=Promise.resolve(),last=null;
 const persist=operation=>{const result=writes.then(operation);writes=result.catch(error=>console.error(`Memory diagnostic persistence failed: ${error.message}`));return result;};
 const snapshot=async()=>{
  const metricsStartedAt=new Date().toISOString(),metrics=await runtimeMetrics(source,{details:true}),metricsFinishedAt=new Date().toISOString();
  const info=await deadline(session.send('SystemInfo.getProcessInfo'),2000,'process roles').catch(error=>({error:error.message}));
  if(info.processInfo){const roles=new Map(info.processInfo.map(p=>[Number(p.id),p.type]));for(const row of metrics.processes)if(row.kind==='chromium'&&roles.has(row.pid))row.chromiumRole=roles.get(row.pid);metrics.processRolesWitness={metricsStartedAt,metricsFinishedAt,rolesFinishedAt:new Date().toISOString(),scope:'CDP PID roles observed after pinned-proc memory reads;not an atomic role/start-identity correlation.'};}
  else metrics.processRolesError=info.error;
  return {at:new Date().toISOString(),runId,closing,health:{...health},metrics};
 };
 const sample=reason=>persist(async()=>{last={...await snapshot(),reason};await appendFile(join(directory,'source-runtime.jsonl'),JSON.stringify(last)+'\n');await atomicJson(directory,'source-health.json',last);return last;});
 const event=(type,fields={})=>persist(async()=>{const value={at:new Date().toISOString(),runId,type,expectedDuringClose:closing,...fields};await appendFile(join(directory,'source-events.jsonl'),JSON.stringify(value)+'\n');}).then(()=>sample(type)).catch(error=>console.error(error.stack));
 const pageCrash=()=>{health.pageCrashed=true;void event('page-crash');};
 const pageClose=()=>void event('page-close');
 const disconnected=()=>{health.browserDisconnected=true;void event('browser-disconnected');};
 const brokerExit=(code,signal)=>{health.brokerExited=true;void event('broker-exit',{code,signal});};
 const targetCrash=({targetId,status,errorCode})=>void event('target-crash',{targetId,status,errorCode});
 source.page.on('crash',pageCrash);source.page.on('close',pageClose);source.browser.on('disconnected',disconnected);source.broker?.child.on('exit',brokerExit);session.on('Target.targetCrashed',targetCrash);
 await session.send('Target.setDiscoverTargets',{discover:true});
 await sample('startup');
 const poll=async()=>{try{await sample('interval');}catch(error){console.error(error.stack);}finally{if(!stopped)timer=setTimeout(()=>void poll(),interval);}};
 timer=setTimeout(()=>void poll(),interval);
 return {health,sample,get last(){return last;},beginClose(){closing=true;stopped=true;clearTimeout(timer);},async stop(){
  stopped=true;clearTimeout(timer);await writes;await sample('cleanup');await writes;
  source.page.off('crash',pageCrash);source.page.off('close',pageClose);source.browser.off('disconnected',disconnected);source.broker?.child.off('exit',brokerExit);session.off('Target.targetCrashed',targetCrash);await session.detach().catch(()=>{});
 }};
}
