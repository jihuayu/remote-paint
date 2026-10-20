import {freezeBackendData} from './backend-transport.mjs';

const plain=v=>!!v&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const integer=(v,min,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const string=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_'+uuid+'$').test(v);
const date=v=>string(v,32)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const error=v=>v===null||exact(v,['code','outcome'])&&typeof v.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(v.code)&&!v.code.startsWith('CLIENT_')&&['not-dispatched','unknown'].includes(v.outcome);
const size=v=>Buffer.byteLength(JSON.stringify(v));
const eventPattern=new RegExp('^aec1\\.(arun_'+uuid+')\\.(0|[1-9][0-9]{0,15})$');
const cancellationPattern=new RegExp('^acc1\\.(arun_'+uuid+')\\.([1-9][0-9]{0,15})\\.(ainv_'+uuid+')$');
export function eventCursor(id,sequence){return 'aec1.'+id+'.'+sequence;}
function eventSequence(value,id){const match=typeof value==='string'&&eventPattern.exec(value);return match&&match[1]===id&&integer(Number(match[2]),0)?Number(match[2]):null;}
function cancellationCursor(value,id){const match=typeof value==='string'&&cancellationPattern.exec(value);return match&&match[1]===id&&integer(Number(match[2]),1)?{sequence:Number(match[2]),invocationId:match[3]}:null;}
export function captureEventOptions(value,id,invalid,kind){
 const allowed=kind==='stream'?['after','signal','reconnects']:['after','signal','retries'];
 if(!plain(value))invalid();const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 if(keys.some(k=>!allowed.includes(k)||!Object.hasOwn(descriptors[k],'value')))invalid();const v=Object.fromEntries(keys.filter(k=>descriptors[k].value!==undefined).map(k=>[k,descriptors[k].value]));
 if(v.after!==undefined&&(kind==='cancellation'?!cancellationCursor(v.after,id):eventSequence(v.after,id)===null)||v.signal!==undefined&&!(v.signal instanceof AbortSignal)||v.retries!==undefined&&!integer(v.retries,0,3)||v.reconnects!==undefined&&!integer(v.reconnects,0,3))invalid();return v;
}
const states=['intent','starting','active','closing','recovery-required','closed'],dispatch=['not-requested','requested','confirmed'];
const closures=['never-dispatched','begin-rejected','worker-run-closed','session-terminal'];
function runState(v,stamp=false){
 if(!exact(v,['state','holdsWriter','beginDispatch','endDispatch','error','closeEvidenceKind',...(stamp?['stateUpdatedAt']:[])])||!states.includes(v.state)||typeof v.holdsWriter!=='boolean'||(v.state==='closed')===v.holdsWriter||!dispatch.includes(v.beginDispatch)||!dispatch.includes(v.endDispatch)||!error(v.error)||stamp&&!date(v.stateUpdatedAt)||(v.closeEvidenceKind===null?v.state==='closed':v.state!=='closed'||!closures.includes(v.closeEvidenceKind)))return false;
 if(v.state==='intent'&&(v.beginDispatch!=='not-requested'||v.endDispatch!=='not-requested'||v.error!==null)||v.state==='starting'&&(v.beginDispatch!=='requested'||v.endDispatch!=='not-requested'||v.error!==null)||v.state==='active'&&(v.beginDispatch!=='confirmed'||v.endDispatch!=='not-requested'||v.error!==null)||v.endDispatch!=='not-requested'&&v.beginDispatch!=='confirmed'||v.endDispatch==='requested'&&!['closing','recovery-required','closed'].includes(v.state)||v.endDispatch==='confirmed'&&(v.state!=='closed'||v.closeEvidenceKind!=='worker-run-closed'))return false;
 if(v.closeEvidenceKind==='never-dispatched'&&(v.beginDispatch!=='not-requested'||v.endDispatch!=='not-requested'||v.error!==null)||v.closeEvidenceKind==='begin-rejected'&&(v.beginDispatch!=='requested'||v.endDispatch!=='not-requested'||v.error?.outcome!=='not-dispatched')||v.closeEvidenceKind==='worker-run-closed'&&(v.beginDispatch!=='confirmed'||v.endDispatch!=='confirmed')||v.state!=='closed'&&v.error!==null&&(!['closing','recovery-required'].includes(v.state)||v.error.outcome!=='unknown'))return false;return true;
}
const tools=['click','move','drag','scroll','press','insertText','composition'];
function invocationState(v,report=false){
 if(!exact(v,['invocationId','tool','state','dispatchStarted','receipt','error',...(report?['effect','updatedAt']:['stateUpdatedAt'])])||!id(v.invocationId,'ainv')||!tools.includes(v.tool)||!['intent','requested','injected','rejected','unknown'].includes(v.state)||typeof v.dispatchStarted!=='boolean'||!error(v.error)||!date(report?v.updatedAt:v.stateUpdatedAt))return false;
 if(v.receipt!==null&&(!exact(v.receipt,['stage','inputs'])||v.receipt.stage!=='input-injected'||!integer(v.receipt.inputs,1,32))||(v.state==='injected')!==(v.receipt!==null))return false;
 if(v.state==='intent'&&(v.dispatchStarted||v.error!==null)||v.state==='requested'&&(!v.dispatchStarted||v.error!==null)||v.state==='injected'&&(!v.dispatchStarted||v.error!==null)||v.state==='rejected'&&v.error?.outcome!=='not-dispatched'||v.state==='unknown'&&(!v.dispatchStarted||v.error?.outcome!=='unknown'))return false;
 return !report||v.effect===(v.state==='injected'?'input-injected':v.state==='rejected'?'not-dispatched':v.state==='intent'?'not-dispatched-yet':'unknown');
}
function event(v,run){
 return exact(v,['schema','eventId','agentRunId','sessionId','region','version','sequence','observedAt','type','data'])&&v.schema==='agent-event-v1'&&id(v.eventId,'aevt')&&v.agentRunId===run&&id(v.sessionId,'ses')&&string(v.region,64)&&string(v.version,256)&&integer(v.sequence,1)&&date(v.observedAt)&&size(v)<=3072&&(['run.updated','run.snapshot'].includes(v.type)?runState(v.data,true):['invocation.updated','invocation.snapshot'].includes(v.type)&&invocationState(v.data));
}
function bounds(v,run){
 const after=eventSequence(v.after,run),oldest=eventSequence(v.oldestCursor,run),latest=eventSequence(v.latestCursor,run);
 return v.agentRunId===run&&['created','migration-snapshot'].includes(v.historyOrigin)&&after!==null&&oldest!==null&&latest!==null&&latest>=1&&oldest===Math.max(0,latest-64)?{after,oldest,latest}:null;
}
export function validEventGap(v,run,after){
 if(!exact(v,['schema','agentRunId','historyOrigin','after','oldestCursor','latestCursor','missingHistory'])||v.schema!=='agent-event-gap-v1'||v.missingHistory!==true||size(v)>2048)return false;
 const b=bounds(v,run);return !!b&&b.after<b.oldest&&(after===undefined||v.after===after);
}
export function captureEventErrorDetails(value,expect,status){
 return value.code==='AGENT_EVENT_GAP'&&value.outcome==='not-dispatched'&&status===409&&['agent-event-page','agent-events-stream'].includes(expect.kind)&&validEventGap(value.details,expect.id,expect.after??eventCursor(expect.id,0))?value.details:null;
}
export function validateAgentEventReply(status,v,expect,headers){
 const run=expect.id;
 if(expect.kind==='agent-event-page'){
  if(status!==200||!exact(v,['schema','agentRunId','sessionId','region','version','historyOrigin','after','oldestSequence','latestSequence','gap','events','nextCursor','hasMore','oldestCursor','latestCursor'])||v.schema!=='agent-event-http-page-v1'||!id(v.sessionId,'ses')||!string(v.region,64)||!string(v.version,256)||v.gap!==false||!Array.isArray(v.events)||v.events.length>4||typeof v.hasMore!=='boolean'||size(v)>16384)return false;
  const b=bounds(v,run);if(!b||v.after!==(expect.after??eventCursor(run,0))||b.after<b.oldest||b.after>b.latest||v.oldestSequence!==b.oldest+1||v.latestSequence!==b.latest||v.events.length!==Math.min(4,b.latest-b.after))return false;
  const seen=new Set();for(const [i,e]of v.events.entries()){if(!event(e,run)||e.sessionId!==v.sessionId||e.region!==v.region||e.version!==v.version||e.sequence!==b.after+i+1||seen.has(e.eventId))return false;seen.add(e.eventId);}
  return v.nextCursor===eventCursor(run,b.after+v.events.length)&&v.hasMore===(b.after+v.events.length<b.latest);
 }
 if(!['agent-cancel','agent-cancellation'].includes(expect.kind)||!exact(v,['schema','agentRunId','sessionId','region','version','observedAt','status','run','work','scope','rollbackSupported','rollbackPerformed','businessSuccessConfirmed','page','invocations'])||v.schema!=='agent-cancellation-v1'||v.agentRunId!==run||!id(v.sessionId,'ses')||!string(v.region,64)||!string(v.version,256)||!date(v.observedAt)||!runState(v.run)||!exact(v.work,['ordinaryPending','endPending','recoveryRequired','executorStopping'])||Object.values(v.work).some(x=>typeof x!=='boolean')||v.scope!=='original-agent-run'||v.rollbackSupported!==false||v.rollbackPerformed!==false||v.businessSuccessConfirmed!==false||!exact(v.page,['generation','historyOrigin','after','nextCursor','hasMore','completeRun'])||!['created','migration-snapshot'].includes(v.page.historyOrigin)||typeof v.page.hasMore!=='boolean'||!Array.isArray(v.invocations)||v.invocations.length>4||size(v)>16384)return false;
 const expectedStatus=v.run.state==='closed'?(v.work.ordinaryPending||v.work.endPending?'settling':'closed'):v.work.endPending||v.run.state==='closing'?'pending':v.work.recoveryRequired||v.run.state==='recovery-required'?'reconciliation-required':'not-requested';
 if(v.status!==expectedStatus||expect.kind==='agent-cancel'&&(status!==(['pending','settling'].includes(v.status)?202:200)||headers.get('location')!=='/v1/agent-runs/'+run+'/cancellation')||expect.kind==='agent-cancellation'&&status!==200)return false;
 const generation=eventSequence(v.page.generation,run),after=expect.after===undefined?null:cancellationCursor(expect.after,run);if(generation===null||generation<1||v.page.after!==(expect.after??null)||after&&after.sequence!==generation||v.page.completeRun!==(v.page.after===null&&!v.page.hasMore))return false;
 let previous=after?.invocationId??'';for(const row of v.invocations){if(!invocationState(row,true)||row.invocationId<=previous)return false;previous=row.invocationId;}
 if(!v.page.hasMore)return v.page.nextCursor===null;
 const next=cancellationCursor(v.page.nextCursor,run);return v.invocations.length===4&&next?.sequence===generation&&next.invocationId===previous;
}

// One pull, one raw chunk and one <=4096-byte frame. No background event queue.
// Abort/return cleanup runs even while the consumer is paused between pulls.
export function createAgentEventStreams({fetch,base,apiKey,timeout,maxConcurrent,streamTimeout,maxStreamBytes,ErrorClass,readJson}){
 const invalid=()=>{throw new ErrorClass('CLIENT_INVALID_REQUEST',{outcome:'not-dispatched'});};
 if(!integer(maxConcurrent,1,64)||!integer(streamTimeout,100,120000)||!integer(maxStreamBytes,4096,1048576))invalid();
 const slots=new Set();
 function events(run,options){
  let cursor=options.after??eventCursor(run,0),started=false,stopping=false,closedMode=null,closedReason=null,busy=false,slot=null,timer=null,pull=null,cleanup=null;
  let controller,stoppedResolve,stoppedReject,stopped,opening=null,response=null,reader=null,readPromise=null,cancelling=null,bodyDone=false;
 let requestId=null,attempts=0,totalBytes=0,totalEvents=0,windowEvents=0,ready=false,checkpoint=false,historyOrigin=null,identity=null,closingWindow=null;
  let chunk=null,offset=0,frameBytes=new Uint8Array(4096),frameLength=0,lineLength=0,previousByte=0;const seen=new Set(),maxAttempts=1+(options.reconnects??3);
  const make=(code,extra={})=>new ErrorClass(code,{requestId,outcome:attempts?'unknown':'not-dispatched',cursor,...extra});
  const bad=()=>{throw make('CLIENT_INVALID_RESPONSE');};
  const cancelled=()=>{if(stopping)throw closedReason??make('CLIENT_ABORTED');};
  const outerAbort=()=>stop(make('CLIENT_ABORTED'), 'error');
  function cancelReader(){
   if(reader&&!bodyDone&&!cancelling){try{cancelling=Promise.resolve(reader.cancel());}catch(error){cancelling=Promise.reject(error);}void cancelling.catch(()=>{});}
  }
  function closeWindow(){
   if(closingWindow)return closingWindow;
   closingWindow=(async()=>{
    if(opening)await opening.catch(()=>{});
    try{
     if(reader){
      cancelReader();if(cancelling)await cancelling;
      if(readPromise)await readPromise.catch(()=>{});reader.releaseLock();
     }else if(response?.body&&!bodyDone)await response.body.cancel();
    }catch{throw make('CLIENT_EVENT_STREAM_CLEANUP_FAILED');}
    opening=null;response=null;reader=null;readPromise=null;cancelling=null;chunk=null;offset=0;frameLength=0;lineLength=0;previousByte=0;bodyDone=false;
   })();return closingWindow;
  }
  function stop(reason,mode){
   if(stopping)return;stopping=true;closedMode=mode;closedReason=reason;clearTimeout(timer);options.signal?.removeEventListener('abort',outerAbort);
   // Start the reader cancellation before aborting fetch. Otherwise native
   // fetch can error the body first and make an ordinary reader break fail.
   cancelReader();controller?.abort();
   if(reason)stoppedReject?.(reason);else stoppedResolve?.({done:true,value:undefined});
   // A failed/noncooperative cancellation cannot manufacture a free slot. The
   // observer can time out while this exact cleanup remains pending/uncertain.
   cleanup=Promise.resolve().then(async()=>{await closeWindow();if(pull)await pull.catch(()=>{});slots.delete(slot);slot=null;frameBytes=null;});void cleanup.catch(()=>{});
  }
  function start(){
   if(started)return;started=true;
   if(options.signal?.aborted){closedMode='error';closedReason=make('CLIENT_ABORTED');stopping=true;throw closedReason;}
   if(slots.size>=maxConcurrent){closedMode='error';closedReason=make('CLIENT_CAPACITY');stopping=true;throw closedReason;}
   slot={};slots.add(slot);controller=new AbortController();stopped=new Promise((resolve,reject)=>{stoppedResolve=resolve;stoppedReject=reject;});void stopped.catch(()=>{});
   options.signal?.addEventListener('abort',outerAbort,{once:true});timer=setTimeout(()=>stop(make('CLIENT_TIMEOUT'), 'error'),streamTimeout);
   if(options.signal?.aborted)outerAbort();
  }
  async function open(){
   cancelled();closingWindow=null;attempts++;ready=false;checkpoint=false;windowEvents=0;bodyDone=false;requestId=null;const after=cursor;
   opening=(async()=>{
    response=await fetch(base+'/v1/agent-runs/'+run+'/events/stream?after='+after,{method:'GET',headers:{authorization:'Bearer '+apiKey,accept:'text/event-stream','accept-encoding':'identity'},signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
    if(stopping)return;
    if(response.status>=400){await readJson(response,{kind:'agent-events-stream',id:run,after},controller.signal);bad();}
    requestId=response.headers.get('x-request-id');const length=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
    if(response.status!==200||!/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type')??'')||typeof requestId!=='string'||!/^req_[A-Za-z0-9_-]{1,124}$/.test(requestId)||encoding!==null&&encoding!=='identity'||length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||!integer(Number(length),0,maxStreamBytes-totalBytes)))bad();
    reader=response.body?.getReader();if(!reader)bad();
   })();await opening;cancelled();
  }
  function parse(bytes){
   let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{bad();}
   const fields={};for(let line of text.split('\n')){
    if(line.endsWith('\r'))line=line.slice(0,-1);if(!line||line.startsWith(':'))continue;
    const colon=line.indexOf(':');if(colon<0)bad();const key=line.slice(0,colon);let value=line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
    if(!['event','id','data'].includes(key)||Object.hasOwn(fields,key))bad();fields[key]=value;
   }
   if(!Object.keys(fields).length)return null;if(checkpoint||!Object.hasOwn(fields,'event')||!Object.hasOwn(fields,'data'))bad();let v;try{v=JSON.parse(fields.data);}catch{bad();}
   const last=eventSequence(cursor,run),hasId=Object.hasOwn(fields,'id');
   if(fields.event==='ready'){
    if(ready||hasId||!exact(v,['schema','agentRunId','historyOrigin','after','oldestCursor','latestCursor','cursor'])||v.schema!=='agent-event-stream-v1'||v.cursor!==cursor||v.after!==cursor)bad();
    const b=bounds(v,run);if(!b||last<b.oldest||last>b.latest||historyOrigin!==null&&v.historyOrigin!==historyOrigin)bad();ready=true;historyOrigin=v.historyOrigin;return {kind:'ready',cursor,data:v,requestId};
   }
   if(!ready)bad();
   if(fields.event==='agent'){
    if(!hasId||!event(v,run)||v.sequence!==last+1||fields.id!==eventCursor(run,v.sequence)||seen.has(v.eventId)||windowEvents>=64||totalEvents>=256)bad();
    const fixed={sessionId:v.sessionId,region:v.region,version:v.version};if(identity&&Object.keys(fixed).some(k=>fixed[k]!==identity[k]))bad();identity??=fixed;
    seen.add(v.eventId);windowEvents++;totalEvents++;return {kind:'event',cursor:fields.id,event:v,requestId};
   }
   if(hasId)bad();
   if(fields.event==='heartbeat'){
    if(!exact(v,['schema','agentRunId','cursor','observedAt'])||v.schema!=='agent-heartbeat-v1'||v.agentRunId!==run||v.cursor!==cursor||!date(v.observedAt))bad();return {kind:'heartbeat',cursor,data:v,requestId};
   }
   if(fields.event==='checkpoint'){
    if(!exact(v,['schema','agentRunId','cursor','reason'])||v.schema!=='agent-event-checkpoint-v1'||v.agentRunId!==run||v.cursor!==cursor||!['duration','events','bytes'].includes(v.reason))bad();checkpoint=true;return {kind:'checkpoint',cursor,data:v,requestId};
   }
   if(fields.event==='gap'){
    if(!validEventGap(v,run,cursor)||v.historyOrigin!==historyOrigin)bad();throw make('AGENT_EVENT_GAP',{status:200,outcome:'not-dispatched',details:v});
   }
   bad();
  }
  async function readMessage(){
   for(;;){
    cancelled();
    if(!chunk||offset===chunk.byteLength){
     readPromise=reader.read();let part;try{part=await readPromise;}finally{readPromise=null;}cancelled();
     if(part.done){bodyDone=true;if(frameLength||!checkpoint)throw make('CLIENT_EVENT_STREAM_INTERRUPTED',{retryable:true});return null;}
     if(!(part.value instanceof Uint8Array)||part.value.byteLength===0)bad();totalBytes+=part.value.byteLength;if(totalBytes>maxStreamBytes)throw make('CLIENT_EVENT_STREAM_LIMIT');chunk=part.value;offset=0;
    }
    while(offset<chunk.byteLength){
     const byte=chunk[offset++];if(frameLength>=4096)throw make('CLIENT_EVENT_STREAM_LIMIT');frameBytes[frameLength++]=byte;
     if(byte===10){
      const blank=lineLength===0||lineLength===1&&previousByte===13;lineLength=0;previousByte=byte;
      if(blank){const value=parse(frameBytes.subarray(0,frameLength));frameLength=0;if(value)return freezeBackendData(value);}
     }else{lineLength++;previousByte=byte;}
    }
   }
  }
  async function advance(){
   for(;;){
    cancelled();
    try{
     if(!reader)await open();const value=await readMessage();if(value)return {done:false,value};
     await closeWindow();if(attempts>=maxAttempts){stop(null,'complete');return {done:true,value:undefined};}
    }catch(error){
     if(stopping)throw closedReason??make('CLIENT_ABORTED');
     const e=error instanceof ErrorClass?new ErrorClass(error.code,{status:error.status,requestId:error.requestId,outcome:error.outcome,retryable:error.retryable,cursor,...(error.details?{details:error.details}:{})}):make('CLIENT_TRANSPORT_ERROR',{retryable:true});
     if(!e.retryable||attempts>=maxAttempts)throw e;
     // Never replace a noncooperative fetch/read/cancel just because its
     // observation ended. Reconnection starts after real previous cleanup.
     await closeWindow();
    }
    await new Promise(resolve=>setTimeout(resolve,50));cancelled();
   }
  }
  async function observeCleanup(){
   if(!cleanup)return;let expiry;
   try{await Promise.race([cleanup,new Promise((_,reject)=>{expiry=setTimeout(()=>reject(make('CLIENT_TIMEOUT')),timeout);})]);}
   catch(e){if(e instanceof ErrorClass)throw e;throw make('CLIENT_EVENT_STREAM_CLEANUP_FAILED');}finally{clearTimeout(expiry);}
  }
  return Object.freeze({
   [Symbol.asyncIterator](){return this;},
   async next(){
    if(stopping){if(closedMode==='error')throw closedReason;return {done:true,value:undefined};}if(busy)throw make('CLIENT_EVENT_STREAM_BUSY',{outcome:'not-dispatched'});
    start();if(stopping)throw closedReason;busy=true;
    pull=Promise.resolve().then(advance).catch(e=>{const error=e instanceof ErrorClass?e:make('CLIENT_TRANSPORT_ERROR');stop(error,'error');throw error;});void pull.catch(()=>{});
    try{const result=await Promise.race([pull,stopped]);if(!result.done&&result.value.kind==='event')cursor=result.value.cursor;return result;}finally{busy=false;}
   },
   async return(){
    if(!started){stopping=true;closedMode='return';return {done:true,value:undefined};}
    if(!stopping)stop(make('CLIENT_ABORTED'),'return');await observeCleanup();return {done:true,value:undefined};
   },
   async throw(error){if(!started){stopping=true;closedMode='return';throw error;}if(!stopping)stop(make('CLIENT_ABORTED'),'return');await observeCleanup();throw error;}
  });
 }
 return Object.freeze({events,status:()=>Object.freeze({streams:slots.size})});
}
