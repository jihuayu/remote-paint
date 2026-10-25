// Opt-in owned-process Native integration, not a production RPC listener.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startLive} from '../../live.mjs';
import {NativeSessionResource} from '../../service/native-session-resource.mjs';
import {ClusterWorkerFence} from '../../service/cluster-worker-fence.mjs';

const nodeId=process.argv[2],incarnation=process.argv[3];let observation,resource,live,placement,retirement;
const sha=value=>createHash('sha256').update(value).digest('hex');
async function knownProcess(pid){try{const text=await readFile('/proc/'+pid+'/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);return {pid,state:fields[0],start:fields[19]};}catch(error){if(error.code==='ENOENT')return {pid,absent:true};throw error;}}
const fence=new ClusterWorkerFence({nodeId,incarnation,maxSessions:1,onExpired:async()=>{
 if(!resource){retirement={status:'closed',notStarted:true};return;}
 let pids=[],before=[],inventoryConfirmed=false;
 try{if(live){const session=await live.source.browser.newBrowserCDPSession();try{const info=await session.send('SystemInfo.getProcessInfo');pids=[...new Set([...info.processInfo.map(p=>p.id),live.source.broker.child.pid])].filter(p=>Number.isSafeInteger(p)&&p>0);before=await Promise.all(pids.map(knownProcess));inventoryConfirmed=pids.length>0;}finally{await session.detach();}}}catch{}
 const closed=await resource.close();
 if(!live){retirement={status:closed.status,notStarted:true};return;}
 const after=await Promise.all(pids.map(knownProcess));
 const processesRetired=inventoryConfirmed&&after.every((row,i)=>row.absent||row.state==='Z'||row.start!==before[i].start);
 const logical=closed.status==='closed'&&live.source.closed===true&&live.source.broker.exited===true&&!live.source.browser.isConnected();
 retirement={status:logical&&processesRetired?'closed':'unconfirmed',logicalNativeResourceClosed:logical,observedProcessesRetired:processesRetired,observedProcesses:pids.length,namespaceWideRetirementQualified:false};
}});
async function nativeFrame(){
 const ws=new WebSocket(live.streamOrigin.replace('http:','ws:')+'/stream?key='+live.key,{origin:live.origin,perMessageDeflate:false});let packets=0,timer;
 const result=new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error('Actual Native frame deadline')),10000);
  ws.on('error',reject);ws.on('message',(bytes,binary)=>{
   if(binary){packets++;return;}try{const message=JSON.parse(bytes.toString());if(message.type==='FrameCommit'){clearTimeout(timer);ws.send(JSON.stringify({type:'FrameAck',frameId:message.frameId,pageEpoch:message.pageEpoch,stage:'scene-submitted'}));resolve({frameId:message.frameId,pageEpoch:message.pageEpoch,binaryPackets:packets});}}catch(error){clearTimeout(timer);reject(error);}
  });
 });
 void result.catch(()=>{});
 try{await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer,capabilities:['frame-window-v1'],frameWindow:2}));return await result;}
 finally{clearTimeout(timer);if(ws.readyState!==3){const closed=once(ws,'close');ws.terminate();await closed.catch(()=>{});}}
}
process.on('message',async({id,method,data})=>{
 try{
  let result;
  if(method==='begin'){observation=fence.beginHeartbeat();result={started:true};}
  else if(method==='lease'){result=fence.acceptLease(observation,data.lease,{leaseMs:data.leaseMs});observation=null;}
  else if(method==='start'){
   if(resource)throw new Error('Native Worker already allocated');placement=fence.admit(data.binding);
   result=await fence.run(placement,async()=>{
    resource=new NativeSessionResource({sessionId:placement.sessionId,tenantId:placement.tenantId,request:{url:data.url},signal:fence.signal,startLive:async options=>live=await startLive({...options,port:0,nativePort:0,host:'127.0.0.1'})});
    return resource.initialize();
   });
  }
  else if(method==='work')result=await fence.run(data,async signal=>{
   const release=live.source.acquirePageRun({signal});try{
    await live.source.page.locator('#go').click();await live.source.page.waitForFunction(()=>document.querySelector('#go').textContent==='clicked');
    const marker=await live.source.page.title(),png=await live.source.page.screenshot(),frame=await nativeFrame();
    return {nodeId,marker,click:'clicked',pngSha256:sha(png),pngBytes:png.length,frame,native:live.source.nativeAutopublish===true,chromium:live.source.browser.version()};
   }finally{release();}
  });
  else if(method==='status')result={...fence.status(),ownerAborted:fence.signal.aborted,nativeStarted:!!live};
  else if(method==='settled'){if(!fence.terminal)throw new Error('Still active');await fence.terminal;result=retirement;}
  else if(method==='close'){await fence.close();result=retirement??{status:'closed',notStarted:true};}
  else throw new Error('Unknown owned test operation');
  process.send({id,ok:true,data:result});
 }catch(error){process.send({id,ok:false,error:{code:error.code??'NATIVE_FIXTURE_ERROR',outcome:error.outcome??'unknown',message:error.message}});}
});
process.on('disconnect',()=>{void fence.close().finally(()=>process.exit(retirement?.status==='unconfirmed'?1:0));});
