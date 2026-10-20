// Private, currently unwired adapter for the original Source Page's CDP lane.
// No filesystem path, URL refetch, Playwright Download or whole-file Buffer.
import {AgentInputError} from './input.mjs';
import {captureAgentObservationContext} from './agent-observation.mjs';
import {AGENT_DOWNLOAD_LIMITS,captureManagedAgentDownload,captureManagedAgentDownloadId,captureManagedAgentDownloadRead,captureAgentDownloadFileName,captureAgentDownloadArmed,captureAgentDownloadInfo,captureAgentDownloadChunk,captureAgentDownloadReleased} from './agent-download.mjs';

const fail=(code='AGENT_DOWNLOAD_FAILED')=>{throw new AgentInputError(code,'not-dispatched');};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max,min=0)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const ticket=v=>text(v,39,39)&&/^dl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const code=e=>e instanceof AgentInputError?e.code:'AGENT_DOWNLOAD_FAILED';
const deadlineMs=30000;
function exact(value,fields){
 try{
  if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
  const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
  if(keys.length!==fields.length||keys.some(k=>!fields.includes(k)||!Object.hasOwn(descriptors[k],'value')))fail();
  return Object.fromEntries(keys.map(k=>[k,descriptors[k].value]));
 }catch{fail();}
}
function identity(value,r,fields){
 const v=exact(value,['descriptorVersion','currentDocumentToken',...fields]);
 if(v.descriptorVersion!==1||v.currentDocumentToken!==r.nativeDocument)fail();
 if(fields.includes('ticket')&&(!ticket(v.ticket)||r.ticket&&v.ticket!==r.ticket))fail();
 return v;
}
function bounded(work,onTimeout){
 let timer;
 const expiry=new Promise((_,reject)=>{timer=setTimeout(()=>{onTimeout();reject(new AgentInputError('AGENT_DOWNLOAD_FAILED','unknown'));},deadlineMs);});
 return Promise.race([work,expiry]).finally(()=>clearTimeout(timer));
}

// send must already be bound to the original capture transport. The fourth arm
// argument must be its actual document witness, supplied by trusted Source code.
// Source integration must also fence capture/CDP identity before selecting this
// owner. Agent request DTOs cannot provide either capability.
export function createNativeAgentDownloadOwner({page,binding,version,send,token}){
 if(!page||typeof page.on!=='function'||typeof page.off!=='function'||typeof send!=='function'||!text(token,256,32)||!text(version,256,1))fail('AGENT_OBSERVATION_UNAVAILABLE');
 const bound=Object.freeze({...binding});
 let record=null,ordinary=null,cleanup=null,closed=false,closing=null;
 function forget(r){page.off('framenavigated',r.navigate);page.off('close',r.pageClosed);clearTimeout(r.timer);r.timer=null;}
 function params(r){return {descriptorVersion:1,token,documentToken:r.nativeDocument,ticket:r.ticket};}
 function invoke(lane,method,value){
  if(lane==='ordinary'?ordinary:cleanup)fail('AGENT_DOWNLOAD_BUSY');
  const actual=Promise.resolve().then(()=>send(method,Object.freeze(value)));
  if(lane==='ordinary')ordinary=actual;else cleanup=actual;
  // Only actual settlement clears admission. An observer deadline cannot do so.
  void actual.finally(()=>{if(lane==='ordinary'&&ordinary===actual)ordinary=null;if(lane==='cleanup'&&cleanup===actual)cleanup=null;}).catch(()=>{});
  return actual;
 }
 function retire(r){
  if(r.retireWork)return r.retireWork;
  if(!r.ticket)fail();
  let expired=false;
  const loop=(async()=>{
   for(;;){
    if(expired)fail();
    const raw=await invoke('cleanup','Page.releaseRemotePaintDownload',params(r));
    if(expired)fail();
    const v=identity(raw,r,['ticket','released']);
    if(typeof v.released!=='boolean')fail();
    if(v.released){r.retired=true;return;}
    // false is a pending physical receipt, never permission to drop the ticket.
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  })();
  r.retireWork=bounded(loop,()=>{expired=true;r.cleanupFailed=true;});
  void r.retireWork.catch(()=>{r.cleanupFailed=true;});
  return r.retireWork;
 }
 function cancel(r,error){
  r.error??=error;r.ready=null;forget(r);r.phase='failed';
  if(r.ticket&&!r.retired){try{void retire(r).catch(()=>{});}catch{r.cleanupFailed=true;}}
 }
 function check(r){if(closed)fail('AGENT_RUN_CLOSED');r.check();if(r.error)fail(r.error);}
 function owned(id,context){
  captureManagedAgentDownloadId(id);const ctx=captureAgentObservationContext(context),r=record;
  if(closed)fail('AGENT_RUN_CLOSED');
  if(!r||r.ticket!==id||Object.keys(bound).some(k=>ctx.binding[k]!==bound[k])||Object.keys(r.document).some(k=>ctx.document[k]!==r.document[k]))fail('STALE_AGENT_DOWNLOAD');
  return r;
 }
 const base=r=>({binding:bound,document:r.document,version,downloadId:r.ticket});
 const metadata=r=>({scope:'next-owned-page-download',armedAt:r.armedAt,limits:r.limits});
 function request(r,action){
  return (async()=>{try{return await action();}catch(e){const failure=r.error??code(e);cancel(r,failure);throw e instanceof AgentInputError&&e.code===failure?e:new AgentInputError(failure,'not-dispatched');}})();
 }
 const owner={
  arm(context,requestValue,guard,nativeDocumentToken){
   if(closed)fail('AGENT_RUN_CLOSED');if(record||ordinary||cleanup)fail('AGENT_DOWNLOAD_BUSY');
   const ctx=captureAgentObservationContext(context),limits=captureManagedAgentDownload(requestValue.limits).limits;
   if(typeof guard!=='function'||Object.keys(bound).some(k=>ctx.binding[k]!==bound[k]))fail('AGENT_INVALID_CONTEXT');
   if(!text(nativeDocumentToken,64,1))fail('AGENT_OBSERVATION_UNAVAILABLE');guard();
   const r={document:ctx.document,nativeDocument:nativeDocumentToken,limits,check:guard,ticket:null,armedAt:new Date().toISOString(),phase:'discovering',error:null,ready:null,armDispatched:false,armDone:false,retired:false,cleanupFailed:false};
   r.navigate=()=>cancel(r,'STALE_AGENT_PAGE');r.pageClosed=()=>cancel(r,'AGENT_TARGET_CHANGED');
   record=r;page.on('framenavigated',r.navigate);page.on('close',r.pageClosed);
   r.timer=setTimeout(()=>cancel(r,'AGENT_DOWNLOAD_TIMEOUT'),limits.timeoutMs);
   r.armWork=request(r,async()=>{
    try{
     const descriptor=identity(await invoke('ordinary','Page.getRemotePaintDownloadBridge',{token,documentToken:r.nativeDocument}),r,['transfersReady','maxItems','maxFileBytes']);
     if(descriptor.transfersReady!==true||descriptor.maxItems!==4||descriptor.maxFileBytes!==AGENT_DOWNLOAD_LIMITS.maxBytes)fail('AGENT_OBSERVATION_UNAVAILABLE');
     check(r);r.armDispatched=true;
     const armed=identity(await invoke('ordinary','Page.armRemotePaintDownload',{descriptorVersion:1,token,documentToken:r.nativeDocument,maxBytes:limits.maxBytes,timeoutMs:limits.timeoutMs}),r,['ticket']);
     // Save the actual ticket before the post-reply guard. End/navigation can
     // invalidate data access while this original slot still requires cleanup.
     r.ticket=armed.ticket;check(r);r.phase='armed';
     return captureAgentDownloadArmed({stage:'download-armed',...base(r),...metadata(r)});
    }finally{
     r.armDone=true;
     if(!r.armDispatched){forget(r);if(record===r)record=null;}
    }
   });
   return r.armWork;
  },
  info(id,context){
   const r=owned(id,context);check(r);if(ordinary)fail('AGENT_DOWNLOAD_BUSY');
   return request(r,async()=>{
    const v=identity(await invoke('ordinary','Page.getRemotePaintDownloadInfo',params(r)),r,['ticket','phase','error','byteLength','sha256','suggestedFilename']);
    check(r);
    if(!['armed','pending','ready','retiring','failed'].includes(v.phase)||!['','cancelled','timeout','unavailable','io','limit'].includes(v.error)||!integer(v.byteLength,0,AGENT_DOWNLOAD_LIMITS.maxBytes)||!text(v.sha256,64)||!text(v.suggestedFilename,513)||Buffer.byteLength(v.suggestedFilename)>1539)fail();
    if(v.error||v.phase==='retiring'||v.phase==='failed')fail(({cancelled:'AGENT_DOWNLOAD_CANCELLED',timeout:'AGENT_DOWNLOAD_TIMEOUT',limit:'AGENT_DOWNLOAD_LIMIT'})[v.error]??'AGENT_DOWNLOAD_FAILED');
    if(v.phase==='ready'){
     const ready=captureAgentDownloadInfo({stage:'download-ready',...base(r),...metadata(r),completedAt:r.ready?.completedAt??new Date().toISOString(),fileName:captureAgentDownloadFileName(v.suggestedFilename),mimeType:'application/octet-stream',byteLength:v.byteLength,sha256:v.sha256});
     if(r.ready&&(ready.sha256!==r.ready.sha256||ready.byteLength!==r.ready.byteLength||ready.fileName!==r.ready.fileName))fail();
     r.ready=ready;r.phase='ready';clearTimeout(r.timer);r.timer=null;return ready;
    }
    if(r.ready||v.byteLength!==0||v.sha256!=='')fail();
    r.phase=v.phase;
    return captureAgentDownloadInfo({stage:'download-pending',...base(r),...metadata(r)});
   });
  },
  read(requestValue,context){
   const q=captureManagedAgentDownloadRead(requestValue.downloadId,requestValue.offset,requestValue.maxBytes),r=owned(q.downloadId,context);check(r);if(ordinary)fail('AGENT_DOWNLOAD_BUSY');
   const ready=r.ready;if(!ready)fail('AGENT_DOWNLOAD_BUSY');if(q.offset>ready.byteLength)fail('INVALID_AGENT_OBSERVATION');
   return request(r,async()=>{
    const v=identity(await invoke('ordinary','Page.readRemotePaintDownload',{...params(r),offset:q.offset,maxBytes:q.maxBytes}),r,['ticket','offset','nextOffset','eof','data']);
    check(r);
    if(!integer(v.nextOffset,0,ready.byteLength)||v.offset!==q.offset||typeof v.eof!=='boolean')fail();
    return captureAgentDownloadChunk({stage:'download-chunk',...base(r),sha256:ready.sha256,completedAt:ready.completedAt,offset:v.offset,byteLength:v.nextOffset-v.offset,totalBytes:ready.byteLength,data:v.data,complete:v.eof},{downloadRead:q});
   });
  },
  release(id,context){
   const r=owned(id,context);if(r.releaseWork)return r.releaseWork;
   cancel(r,'AGENT_DOWNLOAD_CANCELLED');
   const actual=(async()=>{
    await retire(r);const pending=ordinary;if(pending)try{await pending;}catch{}
    if(r.cleanupFailed||!r.retired)fail();if(record===r)record=null;
    return captureAgentDownloadReleased({stage:'download-released',...base(r)});
   })();
   r.releaseWork=bounded(actual,()=>{r.cleanupFailed=true;});return r.releaseWork;
  },
  close(){
   if(closing)return closing;closed=true;const r=record;if(r)cancel(r,'AGENT_RUN_CLOSED');
   const actual=(async()=>{
    if(r&&!r.armDone)try{await r.armWork;}catch{}
    if(r?.armDispatched){if(!r.ticket)fail();await retire(r);}
    const pending=ordinary;if(pending)try{await pending;}catch{}
    if(r&&(r.cleanupFailed||r.armDispatched&&!r.retired))fail();
    if(record===r)record=null;
   })();
   closing=bounded(actual,()=>{if(r)r.cleanupFailed=true;});return closing;
  },
  status:()=>Object.freeze({closed,tickets:record?1:0,phase:record?.phase??null,bytes:0,actualPending:!!ordinary||!!cleanup||!!record&&(!record.armDone||!record.error&&record.phase!=='ready'),spoolCleanupPending:!!record?.armDispatched&&!record.retired})
 };
 return Object.freeze(owner);
}
