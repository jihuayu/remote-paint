// Real Native runtime behind the production mTLS/Worker service adapter.
// One Session per owned test container. No Engine socket or production keys.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readlink} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {startLive} from '../../live.mjs';
import {prepareViewerAssets} from '../../live/viewer-assets.mjs';
import {NativeSessionResource} from '../../service/native-session-resource.mjs';
import {ClusterWorkerService} from '../../service/cluster-worker-service.mjs';
import {createClusterRpcServer} from '../../service/cluster-rpc.mjs';
import {readClusterTestTls} from './cluster-test-pki.mjs';

const nodeId=process.env.REMOTE_PAINT_CLUSTER_NODE,pki='/input/pki',pins=JSON.parse(await readFile(pki+'/pins.json','utf8'));
const assets=await prepareViewerAssets(),version='chromium:155.0.8059.79;wasm:'+assets.wasmSha256,entries=new Map(),listeners=new Set(),pidNamespace=await readlink('/proc/self/ns/pid');
const address=Object.values(networkInterfaces()).flat().find(row=>row.family==='IPv4'&&!row.internal)?.address;if(!address)throw new Error('No owned container interface');
const incarnation='boot-'+randomUUID();let creates=0,closes=0;
const record=()=>writeFile('/results/runtime.json',JSON.stringify({nodeId,incarnation,pidNamespace,creates,closes,entries:[...entries].map(([sessionId,e])=>({sessionId,closed:e.report?.status==='closed'}))},null,2)+'\n');
async function processIdentity(pid){try{const text=await readFile('/proc/'+pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).split(/\s+/);return {pid,state:fields[0],start:fields[19]};}catch(error){if(error.code==='ENOENT')return {pid,absent:true};throw error;}}
const provider={
 create(request){
  if([...entries.values()].some(e=>e.report?.status!=='closed'))throw new Error('Owned Native capacity');
  const entry={live:null,resource:null,report:null,closing:null,start:null};entries.set(request.sessionId,entry);creates++;
  entry.resource=new NativeSessionResource({...request,request:{url:request.url},startLive:async options=>entry.live=await startLive({...options,port:4175,nativePort:4176,host:'0.0.0.0'})});
  entry.resource.subscribeUnavailable(()=>{for(const fn of listeners)fn({sessionId:request.sessionId,tenantId:request.tenantId,region:request.region});});
  entry.start=entry.resource.initialize().then(async ready=>{await record();return ready;});return entry.start;
 },
 close({sessionId}){
  const entry=entries.get(sessionId);if(!entry)return Promise.resolve({status:'unconfirmed'});if(entry.closing)return entry.closing;
  entry.closing=Promise.resolve().then(async()=>{
   try{await entry.start;}catch{}
   let pids=[],before=[],observed=false;
   try{if(entry.live){const cdp=await entry.live.source.browser.newBrowserCDPSession();try{const info=await cdp.send('SystemInfo.getProcessInfo');pids=[...new Set([...info.processInfo.map(row=>row.id),entry.live.source.broker.child.pid])];before=await Promise.all(pids.map(processIdentity));observed=pids.length>0;}finally{await cdp.detach();}}}catch{}
   const closed=await entry.resource.close(),after=await Promise.all(pids.map(processIdentity));
   const retired=observed&&after.every((row,i)=>row.absent||row.state==='Z'||row.start!==before[i].start);
   entry.report={status:closed.status==='closed'&&retired?'closed':'unconfirmed',logicalNativeResourceClosed:closed.status==='closed',observedProcessesRetired:retired,observedProcesses:pids.length,pidNamespace,namespaceWideRetirementQualified:false};closes++;await record();return {status:entry.report.status};
  });return entry.closing;
 },
 resolveSource(request){const entry=entries.get(request.sessionId);if(!entry?.live||entry.closing)throw new Error('Owned Native Source unavailable');return {tenantId:request.tenantId,sessionId:request.sessionId,region:request.region,version,origin:entry.live.origin,streamOrigin:'http://'+address+':4176',key:entry.live.key};},
 agent(request){const entry=entries.get(request.sessionId);if(!entry||entry.closing)throw new Error('Owned Native Agent unavailable');return entry.resource.agent(request.command);},
 subscribeUnavailable(fn){listeners.add(fn);return()=>listeners.delete(fn);},
 async shutdown(){const results=await Promise.all([...entries.keys()].map(sessionId=>provider.close({sessionId})));return {status:results.every(r=>r.status==='closed')?'closed':'unconfirmed'};}
};
const service=new ClusterWorkerService({nodeId,incarnation,region:'local',version,provider,leaseMs:3000,maxSessions:16,verifyRetirement:({placement,request})=>{const report=entries.get(request.sessionId)?.report;if(report?.status!=='closed')return null;return {sha256:createHash('sha256').update(JSON.stringify({placement,report})).digest('hex')};}});
const server=createClusterRpcServer({tls:readClusterTestTls(pki,nodeId),clientSha256:[pins.controller],handle:service.handle.bind(service),timeoutMs:10000});server.listen(8443,'0.0.0.0',async()=>{await record();console.log(JSON.stringify({ready:true,nodeId,incarnation,version,pidNamespace}));});
let stopping;const stop=()=>stopping??=(async()=>{const result=await service.close();server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile('/results/shutdown.json',JSON.stringify(result)+'\n');process.exit(result.status==='closed'?0:1);})();process.once('SIGTERM',stop);process.once('SIGINT',stop);
