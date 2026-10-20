// Run-owned Source viewport PNGs; control frames carry only metadata or small chunks.
import {createHash} from 'node:crypto';
import {AgentInputError} from './input.mjs';
import {captureAgentObservationContext} from './agent-observation.mjs';
export const AGENT_SCREENSHOT_LIMITS=Object.freeze({defaultBytes:1024*1024,maxBytes:4*1024*1024,dimension:2048,pixels:4*1024*1024,chunkBytes:3072});
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max,string=(v,max,min=0)=>typeof v==='string'&&v.length>=min&&v.length<=max;
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$').test(v),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=(code='AGENT_INVALID_REPLY')=>{throw new AgentInputError(code,'not-dispatched');};
function data(v,fields,required=fields,code='AGENT_INVALID_REPLY'){
 try{if(!v||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail(code);const keys=Reflect.ownKeys(v),d=Object.getOwnPropertyDescriptors(v);if(keys.some(k=>!fields.includes(k)||!Object.hasOwn(d[k],'value'))||required.some(k=>!Object.hasOwn(d,k)))fail(code);return Object.fromEntries(keys.map(k=>[k,d[k].value]));}catch{fail(code);}
}
export function captureManagedAgentScreenshot(limits={}){const v=data(limits,['maxBytes'],[],'INVALID_AGENT_OBSERVATION'),maxBytes=Object.hasOwn(v,'maxBytes')?v.maxBytes:AGENT_SCREENSHOT_LIMITS.defaultBytes;if(!integer(maxBytes,1,AGENT_SCREENSHOT_LIMITS.maxBytes))fail('INVALID_AGENT_OBSERVATION');return Object.freeze({limits:Object.freeze({maxBytes})});}
export function captureManagedAgentScreenshotRead(screenshotId,offset,maxBytes=AGENT_SCREENSHOT_LIMITS.chunkBytes){if(!id(screenshotId,'shot')||!integer(offset,0,AGENT_SCREENSHOT_LIMITS.maxBytes)||!integer(maxBytes,1,AGENT_SCREENSHOT_LIMITS.chunkBytes))fail('INVALID_AGENT_OBSERVATION');return Object.freeze({screenshotId,offset,maxBytes});}
export function captureManagedAgentScreenshotId(screenshotId){if(!id(screenshotId,'shot'))fail('INVALID_AGENT_OBSERVATION');return screenshotId;}
function context(v,expected){let ctx;try{ctx=captureAgentObservationContext({binding:v.binding,document:v.document});}catch{fail();}if(expected.binding&&Object.keys(expected.binding).some(k=>ctx.binding[k]!==expected.binding[k])||expected.document&&Object.keys(expected.document).some(k=>ctx.document[k]!==expected.document[k])||!string(v.version,256,1))fail();return ctx;}
function finish(v){const result=Object.freeze(v);if(Buffer.byteLength(JSON.stringify(result))>6144)fail('AGENT_OBSERVATION_LIMIT');return result;}
export function captureAgentScreenshotResult(value,expected={}){
 const v=data(value,['stage','binding','document','observationId','revision','observedAt','version','scope','limits','url','title','truncated','screenshotId','mimeType','width','height','byteLength','sha256']),ctx=context(v,expected);let request;try{request=captureManagedAgentScreenshot(v.limits);}catch{fail();}
 if(v.stage!=='screenshot-observed'||v.scope!=='main-frame-viewport-source-pixels'||!id(v.observationId,'obs')||!integer(v.revision,1)||!string(v.observedAt,32,1)||!Number.isFinite(Date.parse(v.observedAt))||new Date(v.observedAt).toISOString()!==v.observedAt||Reflect.ownKeys(v.limits).length!==1||expected.screenshot&&request.limits.maxBytes!==expected.screenshot.limits.maxBytes||!string(v.url,1024)||!string(v.title,256)||typeof v.truncated!=='boolean'||!id(v.screenshotId,'shot')||v.mimeType!=='image/png'||!integer(v.width,1,AGENT_SCREENSHOT_LIMITS.dimension)||!integer(v.height,1,AGENT_SCREENSHOT_LIMITS.dimension)||v.width*v.height>AGENT_SCREENSHOT_LIMITS.pixels||!integer(v.byteLength,1,request.limits.maxBytes)||!hash(v.sha256))fail();return finish({...v,...ctx,limits:request.limits});
}
const base64=v=>typeof v==='string'&&v.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(v);
export function captureAgentScreenshotChunk(value,expected={}){
 const v=data(value,['stage','binding','document','version','screenshotId','sha256','observedAt','offset','byteLength','totalBytes','data','complete']),ctx=context(v,expected),q=expected.screenshotRead;
 if(v.stage!=='screenshot-chunk'||!id(v.screenshotId,'shot')||!hash(v.sha256)||!string(v.observedAt,32,1)||!Number.isFinite(Date.parse(v.observedAt))||new Date(v.observedAt).toISOString()!==v.observedAt||!integer(v.offset,0,AGENT_SCREENSHOT_LIMITS.maxBytes)||!integer(v.totalBytes,1,AGENT_SCREENSHOT_LIMITS.maxBytes)||!integer(v.byteLength,0,AGENT_SCREENSHOT_LIMITS.chunkBytes)||v.offset+v.byteLength>v.totalBytes||!string(v.data,4096)||!base64(v.data)||Buffer.byteLength(v.data,'base64')!==v.byteLength||typeof v.complete!=='boolean'||v.complete!==(v.offset+v.byteLength===v.totalBytes)||q&&(v.screenshotId!==q.screenshotId||v.offset!==q.offset||v.byteLength!==Math.min(q.maxBytes,v.totalBytes-q.offset)))fail();return finish({...v,...ctx});
}
export function captureAgentScreenshotReleased(value,expected={}){const v=data(value,['stage','binding','document','version','screenshotId']),ctx=context(v,expected);if(v.stage!=='screenshot-released'||!id(v.screenshotId,'shot')||expected.screenshotId&&v.screenshotId!==expected.screenshotId)fail();return finish({...v,...ctx});}
// Validate bytes before PNG decoding (there is no pixel decoding in Source).
// The CDP string has ALREADY been allocated/decoded by Playwright: not a raw
// receiver or whole-browser physical-memory bound.
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(bytes,start,end){let c=0xffffffff;for(let i=start;i<end;i++)c=crcTable[(c^bytes[i])&255]^(c>>>8);return(c^0xffffffff)>>>0;}
export function decodeAgentScreenshot(reply,{width,height,maxBytes}){
 const v=data(reply,['data']);if(!integer(width,1,2048)||!integer(height,1,2048)||width*height>AGENT_SCREENSHOT_LIMITS.pixels||!integer(maxBytes,1,AGENT_SCREENSHOT_LIMITS.maxBytes))fail('AGENT_OBSERVATION_LIMIT');
 if(typeof v.data!=='string'||v.data.length>4*Math.ceil(maxBytes/3))fail('AGENT_OBSERVATION_LIMIT');if(!base64(v.data)||Buffer.byteLength(v.data,'base64')>maxBytes)fail('AGENT_OBSERVATION_LIMIT');const bytes=Buffer.from(v.data,'base64');
 if(bytes.length<57||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail();let at=8,count=0,seenHeader=false,seenData=false,ended=false;
 while(at<bytes.length){if(++count>2048||at+12>bytes.length)fail();const length=bytes.readUInt32BE(at),end=at+12+length;if(end>bytes.length)fail();const kind=bytes.toString('ascii',at+4,at+8);if(!/^[A-Za-z]{4}$/.test(kind)||crc(bytes,at+4,end-4)!==bytes.readUInt32BE(end-4))fail();
  if(!seenHeader){if(kind!=='IHDR'||length!==13||bytes.readUInt32BE(at+8)!==width||bytes.readUInt32BE(at+12)!==height||![0,2,3,4,6].includes(bytes[at+17])||![1,2,4,8,16].includes(bytes[at+16])||bytes[at+18]!==0||bytes[at+19]!==0||bytes[at+20]!==0)fail();seenHeader=true;}
  else if(kind==='IHDR')fail();if(kind==='IDAT')seenData=true;if(kind==='IEND'){if(length!==0||!seenData||end!==bytes.length)fail();ended=true;}at=end;
 }if(!ended)fail();return bytes;
}
export function createAgentScreenshotOwner(){let stored=null;
 const same=(ctx)=>stored&&['binding','document'].every(k=>Object.keys(ctx[k]).every(f=>stored.record[k][f]===ctx[k][f]));
 const owned=(id,ctx)=>{if(!stored||stored.record.screenshotId!==id||!same(ctx))fail('STALE_AGENT_SCREENSHOT');return stored;};
 return Object.freeze({
  retain(bytes,metadata){if(!Buffer.isBuffer(bytes))fail();const record=captureAgentScreenshotResult({...metadata,byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});stored={bytes,record};return record;},
  read(q,ctx){const {bytes,record}=owned(q.screenshotId,ctx);if(q.offset>bytes.length)fail('INVALID_AGENT_OBSERVATION');const end=Math.min(bytes.length,q.offset+q.maxBytes);return captureAgentScreenshotChunk({stage:'screenshot-chunk',binding:record.binding,document:record.document,version:record.version,screenshotId:record.screenshotId,sha256:record.sha256,observedAt:record.observedAt,offset:q.offset,byteLength:end-q.offset,totalBytes:bytes.length,data:bytes.toString('base64',q.offset,end),complete:end===bytes.length},{...ctx,screenshotRead:q});},
  release(id,ctx){const {record}=owned(id,ctx);stored=null;return captureAgentScreenshotReleased({stage:'screenshot-released',binding:record.binding,document:record.document,version:record.version,screenshotId:id},{...ctx,screenshotId:id});},
  close(){stored=null;},status:()=>Object.freeze({files:stored?1:0,bytes:stored?.bytes.length??0})
 });
}
