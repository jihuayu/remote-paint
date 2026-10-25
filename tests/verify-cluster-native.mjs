import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {ClusterPlacementStore} from '../service/cluster-placement.mjs';

const output=resolve(process.argv[2]??'outputs/cluster-native-proof');await mkdir(output,{recursive:true});
const sha=v=>createHash('sha256').update(v).digest('hex'),binding=r=>Object.fromEntries(['tenantId','sessionId','nodeId','generation','epoch'].map(k=>[k,r[k]]));
const workers=[],receipts=new Map();let store,server,directory,keepB=true,heartbeatB,result,cleanupOutcomes;
function worker(nodeId){
 const incarnation='boot-'+randomUUID(),child=fork(new URL('./fixtures/cluster-native-worker.mjs',import.meta.url),[nodeId,incarnation],{stdio:['ignore','ignore','pipe','ipc']});let ordinal=0,stderr='',exit;
 child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-32768);});const pending=new Map();
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Owned Native Worker exited'));}pending.clear();resolve(exit);}));
 child.on('message',message=>{const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);if(message.ok)item.resolve(message.data);else item.reject(Object.assign(new Error(message.error.message),message.error));});
 const call=(method,data)=>new Promise((resolve,reject)=>{if(exit){reject(new Error('Owned Native Worker already exited'));return;}const id=++ordinal,item={resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error('Owned Native IPC deadline: '+method));},20000)};pending.set(id,item);child.send({id,method,data},error=>{if(error){clearTimeout(item.timer);pending.delete(id);reject(error);}});});
 const value={nodeId,incarnation,call,async close(){if(exit)return exit;try{const closed=await call('close');assert.equal(closed.status,'closed','owned Native resource retirement');}finally{child.disconnect();const outcome=await Promise.race([exited,delay(5000,undefined,{ref:false}).then(()=>null)]);if(!outcome){child.kill('SIGKILL');await exited;}}return exit;},async logs(){await writeFile(output+'/'+nodeId+'-stderr.log',stderr);}};workers.push(value);return value;
}
try{
 assert.equal(process.platform,'linux');assert.ok(process.env.REMOTE_PAINT_CHROMIUM);assert.ok(process.env.REMOTE_PAINT_BROKER);
 const assets=await prepareViewerAssets(),browserVersion=process.env.REMOTE_PAINT_TEST_BROWSER_VERSION;assert.match(browserVersion??'',/^\d+\.\d+\.\d+\.\d+$/);
 const version='chromium:'+browserVersion+';wasm:'+assets.wasmSha256,leaseMs=4000;
 directory=await mkdtemp(join(tmpdir(),'remote-paint-cluster-native-'));const path=join(directory,'placement.sqlite'),fd=await open(path,'wx',0o600);await fd.close();
 store=new ClusterPlacementStore({database:new DatabaseSync(path),leaseMs,verifyRetirement:(placement,receipt)=>{const saved=receipts.get(placement.sessionId);return !!saved&&Object.keys(saved.placement).every(key=>saved.placement[key]===placement[key])&&saved.native.status==='closed'&&saved.workerExit.code===0&&receipt.sha256===sha(JSON.stringify(saved));}});
 server=createServer((req,res)=>{const marker=req.url==='/a'?'cluster-worker-a':'cluster-worker-b';res.setHeader('content-type','text/html');res.end('<!doctype html><title>'+marker+'</title><style>body{background:'+(req.url==='/a'?'#def':'#fed')+'}button{font-size:28px}</style><h1>'+marker+'</h1><button id="go" onclick="this.textContent=\'clicked\'">go</button>');});server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 const a=worker('node-a'),b=worker('node-b');
 const register=async w=>{await w.call('begin');const lease=store.registerNode({nodeId:w.nodeId,incarnation:w.incarnation,region:'local',arch:process.arch,version,capacity:1});await w.call('lease',{lease,leaseMs});return lease;};
 await register(a);const leaseB=await register(b);
 const request=sessionId=>({tenantId:'tenant-native',sessionId,region:'local',arch:process.arch,version});
 const first=store.reserve(request('ses_'+randomUUID())),second=store.reserve(request('ses_'+randomUUID()));assert.equal(first.nodeId,a.nodeId);assert.equal(second.nodeId,b.nodeId);
 heartbeatB=(async()=>{while(keepB){await delay(400);if(!keepB)break;await b.call('begin');const lease=store.heartbeat(leaseB);await b.call('lease',{lease,leaseMs});}})();void heartbeatB.catch(()=>{});
 for(const [w,row,suffix]of [[a,first,'/a'],[b,second,'/b']]){const ready=await w.call('start',{binding:binding(row),url:origin+suffix});assert.equal(ready.version,version);store.ready(binding(row));}
 const byNode=new Map(workers.map(w=>[w.nodeId,w]));
 const routeWork=async row=>{const route=store.route(request(row.sessionId));return byNode.get(route.nodeId).call('work',binding(route));};
 const firstWork=await routeWork(first),secondWork=await routeWork(second);assert.equal(firstWork.marker,'cluster-worker-a');assert.equal(secondWork.marker,'cluster-worker-b');
 for(const result of [firstWork,secondWork]){assert.equal(result.native,true);assert.equal(result.chromium,browserVersion);assert.equal(result.click,'clicked');assert.ok(result.pngBytes>100);assert.ok(result.frame.frameId>0);assert.ok(result.frame.binaryPackets>0);}
 assert.notEqual(firstWork.pngSha256,secondWork.pngSha256);console.log(JSON.stringify({stage:'real-native-workers-routed',workers:2,actualFrameCommits:true,clicks:2}));
 const until=performance.now()+12000;let lost;do{lost=await a.call('status');if(lost.state==='expired')break;assert.ok(performance.now()<until,'Native Worker expiry deadline');await delay(50);}while(true);
 const retired=await a.call('settled');assert.equal(retired.status,'closed');assert.equal(retired.observedProcessesRetired,true);
 while(store.status().quarantined===0){assert.ok(performance.now()<until);await delay(5);}
 assert.throws(()=>store.route(request(first.sessionId)),e=>e.code==='CLUSTER_SESSION_UNAVAILABLE');assert.equal(store.status().heldSlots,2);
 await assert.rejects(a.call('work',binding(first)),e=>e.code==='CLUSTER_WORKER_LEASE'&&e.outcome==='not-dispatched');
 const stillB=await routeWork(second);assert.equal(stillB.marker,'cluster-worker-b');assert.equal(store.reserve(request(first.sessionId)).state,'quarantined');
 const workerExit=await a.close();assert.equal(workerExit.code,0);const saved={placement:binding(first),native:retired,workerExit};receipts.set(first.sessionId,saved);store.confirmRetired(binding(first),{sha256:sha(JSON.stringify(saved))});assert.equal(store.status().heldSlots,1);
 result={status:'passed',version,firstWork,secondWork,afterAExpiredB:stillB,expiredWorker:retired,expiredWorkerExit:workerExit,oldRouteDenied:true,oldWorkerOperationDenied:true,capacityHeldUntilNativeAndWorkerExit:true,oldSessionNotReplayed:true,realNativeResources:true,actualChromiumWorkers:2,actualRustBrokers:2,actualNativeFrameCommits:true,existingNativeSessionResource:true,controller:'real private SQLite',transport:'owned Node IPC within one existing private Docker container',sharedKernel:true,perSessionContainerIsolationQualified:false,remoteAuthenticatedTransportQualified:false,productionClusterDeploymentQualified:false,dockerBuilds:0,chromiumCompiles:0};

}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{keepB=false;await heartbeatB?.catch(()=>{});cleanupOutcomes=await Promise.allSettled(workers.reverse().map(async w=>{try{return {nodeId:w.nodeId,exit:await w.close()};}finally{await w.logs();}}));await writeFile(output+'/cleanup.json',JSON.stringify(cleanupOutcomes,null,2)+'\n');if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}store?.close();if(directory)await rm(directory,{recursive:true,force:true});}

if(!cleanupOutcomes.every(row=>row.status==='fulfilled'&&row.value.exit.code===0&&row.value.exit.signal===null)){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',message:'Owned Native Worker cleanup incomplete',cleanupOutcomes},null,2)+'\n');throw new Error('Owned Native Worker cleanup incomplete');}
result.cleanup=cleanupOutcomes.map(row=>row.value);await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',nativeWorkers:2,expiryAndRoutingIsolation:true,allOwnedWorkersExitedZero:true,remoteCluster:false}));
