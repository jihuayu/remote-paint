// Intake of one actual browser download, selected by an explicit next-event window.
// The browser has already spooled the file before path() resolves. These limits
// bound our retained bytes, not Chromium's writes or Playwright's raw messages.
import {constants} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {AgentInputError} from './input.mjs';
import {captureAgentObservationContext} from './agent-observation.mjs';
export const AGENT_DOWNLOAD_LIMITS=Object.freeze({defaultBytes:1048576,maxBytes:4194304,defaultTimeoutMs:10000,maxTimeoutMs:30000,chunkBytes:3072});
const fail=(code='INVALID_AGENT_OBSERVATION')=>{throw new AgentInputError(code,'not-dispatched');};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const downloadId=v=>typeof v==='string'&&/^dl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function data(v,fields){try{if(!v||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail();const keys=Reflect.ownKeys(v),d=Object.getOwnPropertyDescriptors(v);if(keys.some(k=>!fields.includes(k)||!Object.hasOwn(d[k],'value')))fail();return Object.fromEntries(keys.map(k=>[k,d[k].value]));}catch{fail();}}
export function captureManagedAgentDownload(limits={}){const v=data(limits,['maxBytes','timeoutMs']),maxBytes=Object.hasOwn(v,'maxBytes')?v.maxBytes:AGENT_DOWNLOAD_LIMITS.defaultBytes,timeoutMs=Object.hasOwn(v,'timeoutMs')?v.timeoutMs:AGENT_DOWNLOAD_LIMITS.defaultTimeoutMs;if(!integer(maxBytes,1,AGENT_DOWNLOAD_LIMITS.maxBytes)||!integer(timeoutMs,50,AGENT_DOWNLOAD_LIMITS.maxTimeoutMs))fail();return Object.freeze({limits:Object.freeze({maxBytes,timeoutMs})});}
export function captureManagedAgentDownloadId(value){if(!downloadId(value))fail();return value;}
export function captureManagedAgentDownloadRead(id,offset,maxBytes=AGENT_DOWNLOAD_LIMITS.chunkBytes){captureManagedAgentDownloadId(id);if(!integer(offset,0,AGENT_DOWNLOAD_LIMITS.maxBytes)||!integer(maxBytes,1,AGENT_DOWNLOAD_LIMITS.chunkBytes))fail();return Object.freeze({downloadId:id,offset,maxBytes});}
function result(value){if(Buffer.byteLength(JSON.stringify(value))>6144)fail('AGENT_OBSERVATION_LIMIT');return Object.freeze(value);}
function name(value){if(typeof value!=='string')fail('AGENT_DOWNLOAD_FAILED');const base=value.slice(0,512).split(/[\\/]/).at(-1).normalize('NFC').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').replace(/^\.+|[ .]+$/g,'');return Array.from(base).slice(0,64).join('')||'download.bin';}
const baseFields=['stage','binding','document','version','downloadId'],metadataFields=[...baseFields,'scope','armedAt','limits'];
function reply(value,fields){try{const v=data(value,fields);if(Reflect.ownKeys(v).length!==fields.length)fail('AGENT_INVALID_REPLY');return v;}catch{fail('AGENT_INVALID_REPLY');}}
const time=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function checkedContext(v,expected){let context;try{context=captureAgentObservationContext({binding:v.binding,document:v.document});}catch{fail('AGENT_INVALID_REPLY');}if(typeof v.version!=='string'||v.version.length<1||v.version.length>256||!downloadId(v.downloadId)||expected.binding&&Object.keys(expected.binding).some(k=>context.binding[k]!==expected.binding[k])||expected.document&&Object.keys(expected.document).some(k=>context.document[k]!==expected.document[k])||expected.downloadId&&v.downloadId!==expected.downloadId||expected.downloadRead&&v.downloadId!==expected.downloadRead.downloadId)fail('AGENT_INVALID_REPLY');return context;}
function metadata(value,expected,stages){let stage;try{stage=Object.getOwnPropertyDescriptor(value,'stage')?.value;}catch{fail('AGENT_INVALID_REPLY');}const ready=stage==='download-ready',v=reply(value,ready?[...metadataFields,'completedAt','fileName','mimeType','byteLength','sha256']:metadataFields),ctx=checkedContext(v,expected);let request;try{request=captureManagedAgentDownload(v.limits);}catch{fail('AGENT_INVALID_REPLY');}
 if(!stages.includes(stage)||v.scope!=='next-owned-page-download'||!time(v.armedAt)||Reflect.ownKeys(v.limits).length!==2||expected.download&&Object.keys(request.limits).some(k=>request.limits[k]!==expected.download.limits[k]))fail('AGENT_INVALID_REPLY');
 if(ready&&(!time(v.completedAt)||Date.parse(v.completedAt)<Date.parse(v.armedAt)||typeof v.fileName!=='string'||v.fileName.length<1||v.fileName.length>128||name(v.fileName)!==v.fileName||v.mimeType!=='application/octet-stream'||!integer(v.byteLength,0,request.limits.maxBytes)||!hash(v.sha256)||v.byteLength===0&&v.sha256!==createHash('sha256').digest('hex')))fail('AGENT_INVALID_REPLY');return result({...v,...ctx,limits:request.limits});
}
export const captureAgentDownloadArmed=(value,expected={})=>metadata(value,expected,['download-armed']);
export const captureAgentDownloadInfo=(value,expected={})=>metadata(value,expected,['download-pending','download-ready']);
export function captureAgentDownloadChunk(value,expected={}){
 const v=reply(value,[...baseFields,'sha256','completedAt','offset','byteLength','totalBytes','data','complete']),ctx=checkedContext(v,expected),q=expected.downloadRead;
 if(v.stage!=='download-chunk'||!hash(v.sha256)||!time(v.completedAt)||!integer(v.offset,0,AGENT_DOWNLOAD_LIMITS.maxBytes)||!integer(v.totalBytes,0,AGENT_DOWNLOAD_LIMITS.maxBytes)||!integer(v.byteLength,0,AGENT_DOWNLOAD_LIMITS.chunkBytes)||v.offset+v.byteLength>v.totalBytes||typeof v.data!=='string'||v.data.length>4096||v.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)||Buffer.byteLength(v.data,'base64')!==v.byteLength||Buffer.from(v.data,'base64').toString('base64')!==v.data||typeof v.complete!=='boolean'||v.complete!==(v.offset+v.byteLength===v.totalBytes)||v.byteLength===0&&!v.complete||v.totalBytes===0&&v.sha256!==createHash('sha256').digest('hex')||q&&(v.offset!==q.offset||v.byteLength!==Math.min(q.maxBytes,v.totalBytes-q.offset)))fail('AGENT_INVALID_REPLY');return result({...v,...ctx});
}
export function captureAgentDownloadReleased(value,expected={}){const v=reply(value,baseFields),ctx=checkedContext(v,expected);if(v.stage!=='download-released')fail('AGENT_INVALID_REPLY');return result({...v,...ctx});}
const errorCode=error=>error instanceof AgentInputError?error.code:'AGENT_DOWNLOAD_FAILED';
export function createAgentDownloadOwner({page,binding,version}){
 if(!page||typeof version!=='string'||version.length<1||version.length>256)fail('AGENT_OBSERVATION_UNAVAILABLE');
 let record=null,closed=false,closing=null;
 function forgetListeners(r){page.off('download',r.accept);page.off('framenavigated',r.navigate);page.off('close',r.pageClosed);clearTimeout(r.timer);r.timer=null;}
 function cancel(r,code){
  if(!r.error)r.error=code;r.bytes=null;forgetListeners(r);
  if(r.download&&r.completedAt===undefined&&!r.cancelWork){r.cancelWork=Promise.resolve().then(()=>r.download.cancel()).catch(()=>{r.cancelFailed=true;});}
 }
 async function unlinkSpool(r){if(!r.path)return;try{await unlink(r.path);}catch(error){if(error.code!=='ENOENT')throw error;}r.path=null;}
 async function receive(r,download){
  let file,candidate=null,cleanupFailed=false;
  try{
   // Only this Page's trusted Download event supplies a path. No caller path,
   // URL, selector, evaluation or second HTTP request can enter this reader.
   const path=await download.path();if(typeof path!=='string'||path.length>4096||!isAbsolute(path))fail('AGENT_DOWNLOAD_FAILED');r.path=path;r.check();if(r.error)fail(r.error);
   file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||!integer(stat.size,0,r.limits.maxBytes))fail(stat.isFile()&&stat.size>r.limits.maxBytes?'AGENT_DOWNLOAD_LIMIT':'AGENT_DOWNLOAD_FAILED');
   r.check();if(r.error)fail(r.error);candidate=Buffer.alloc(stat.size);const hash=createHash('sha256');let offset=0;
   while(offset<stat.size){r.check();if(r.error)fail(r.error);const {bytesRead}=await file.read(candidate,offset,Math.min(AGENT_DOWNLOAD_LIMITS.chunkBytes,stat.size-offset),offset);if(bytesRead===0)fail('AGENT_DOWNLOAD_FAILED');hash.update(candidate.subarray(offset,offset+bytesRead));offset+=bytesRead;}
   const tail=Buffer.alloc(1);if((await file.read(tail,0,1,offset)).bytesRead!==0)fail('AGENT_DOWNLOAD_LIMIT');r.check();if(r.error)fail(r.error);const end=await file.stat();if(end.size!==stat.size||end.ino!==stat.ino||end.dev!==stat.dev||end.mtimeMs!==stat.mtimeMs||end.ctimeMs!==stat.ctimeMs||end.nlink!==1)fail('AGENT_DOWNLOAD_FAILED');
   r.sha256=hash.digest('hex');r.fileName=name(download.suggestedFilename());
  }catch(error){r.error??=errorCode(error);candidate=null;}
  finally{
   try{await file?.close();}catch{cleanupFailed=true;}
   try{await unlinkSpool(r);}catch{cleanupFailed=true;}
   // path() settles only when the real browser download finishes or fails.
   // A canceled path has no successful artifact path to unlink; Chromium owns
   // retiring its partial spool. This is not a pre-write disk-budget proof.
   if(!r.error){try{await download.delete();}catch{cleanupFailed=true;}}
   if(r.cancelWork)await r.cancelWork;
   if(cleanupFailed){r.cleanupFailed=true;r.error='AGENT_DOWNLOAD_FAILED';candidate=null;}
   forgetListeners(r);
  }
  if(!r.error){try{r.check();}catch(error){r.error=errorCode(error);candidate=null;}}
  r.bytes=r.error?null:candidate;r.phase=r.error?'failed':'ready';r.completedAt=new Date().toISOString();
 }
 function owned(id,context){captureManagedAgentDownloadId(id);const ctx=captureAgentObservationContext(context),r=record;if(closed)fail('AGENT_RUN_CLOSED');if(!r||r.downloadId!==id||Object.keys(binding).some(k=>ctx.binding[k]!==binding[k])||Object.keys(r.document).some(k=>ctx.document[k]!==r.document[k]))fail('STALE_AGENT_DOWNLOAD');return r;}
 function base(r){return {binding,document:r.document,version,downloadId:r.downloadId};}
 return Object.freeze({
  arm(context,request,check){
   if(closed)fail('AGENT_RUN_CLOSED');if(record)fail('AGENT_DOWNLOAD_BUSY');if(typeof page.on!=='function'||typeof page.off!=='function')fail('AGENT_OBSERVATION_UNAVAILABLE');const ctx=captureAgentObservationContext(context);if(Object.keys(binding).some(k=>ctx.binding[k]!==binding[k])||typeof check!=='function')fail('AGENT_INVALID_CONTEXT');const limits=captureManagedAgentDownload(request.limits).limits;check();
   const r={downloadId:'dl_'+randomUUID(),document:ctx.document,limits,armedAt:new Date().toISOString(),phase:'armed',bytes:null,work:null,cancelWork:null,path:null,error:null,check};
   r.accept=download=>{if(record!==r||closed||r.error)return;page.off('download',r.accept);try{if(download.page()!==page)fail('AGENT_TARGET_CHANGED');r.download=download;r.check();r.phase='receiving';r.work=receive(r,download);void r.work.catch(()=>{});}catch(error){cancel(r,errorCode(error));if(r.download){r.work=receive(r,download);void r.work.catch(()=>{});}}};
   r.navigate=()=>cancel(r,'STALE_AGENT_PAGE');r.pageClosed=()=>cancel(r,'AGENT_TARGET_CHANGED');
   record=r;page.on('download',r.accept);page.on('framenavigated',r.navigate);page.on('close',r.pageClosed);r.timer=setTimeout(()=>cancel(r,'AGENT_DOWNLOAD_TIMEOUT'),limits.timeoutMs);
   return captureAgentDownloadArmed({stage:'download-armed',...base(r),scope:'next-owned-page-download',armedAt:r.armedAt,limits});
  },
  info(id,context){const r=owned(id,context);r.check();if(r.error)fail(r.error);return captureAgentDownloadInfo({stage:r.phase==='ready'?'download-ready':'download-pending',...base(r),scope:'next-owned-page-download',armedAt:r.armedAt,limits:r.limits,...(r.phase==='ready'?{completedAt:r.completedAt,fileName:r.fileName,mimeType:'application/octet-stream',byteLength:r.bytes.length,sha256:r.sha256}:{})});},
  read(request,context){const r=owned(request.downloadId,context);r.check();if(r.error)fail(r.error);if(r.phase!=='ready')fail('AGENT_DOWNLOAD_BUSY');if(request.offset>r.bytes.length)fail('INVALID_AGENT_OBSERVATION');const end=Math.min(request.offset+request.maxBytes,r.bytes.length),bytes=r.bytes.subarray(request.offset,end);return captureAgentDownloadChunk({stage:'download-chunk',...base(r),sha256:r.sha256,completedAt:r.completedAt,offset:request.offset,byteLength:bytes.length,totalBytes:r.bytes.length,data:bytes.toString('base64'),complete:end===r.bytes.length});},
  async release(id,context){const r=owned(id,context);cancel(r,'AGENT_DOWNLOAD_CANCELLED');await r.work;await r.cancelWork;await unlinkSpool(r);if(r.cleanupFailed)fail('AGENT_DOWNLOAD_FAILED');if(record===r)record=null;return captureAgentDownloadReleased({stage:'download-released',...base(r)});},
  close(){if(closing)return closing;closed=true;const r=record;if(r)cancel(r,'AGENT_RUN_CLOSED');closing=(async()=>{await r?.work;await r?.cancelWork;if(r)await unlinkSpool(r);if(r?.cleanupFailed)fail('AGENT_DOWNLOAD_FAILED');record=null;})();return closing;},
  status:()=>Object.freeze({closed,tickets:record?1:0,phase:record?.phase??null,bytes:record?.bytes?.length??0,actualPending:!!record&&(record.phase==='armed'&&!record.error||!!record.work&&record.completedAt===undefined),spoolCleanupPending:!!record?.path})
 });
}
