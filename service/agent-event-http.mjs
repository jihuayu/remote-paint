// Backend-only event transport. Durable state remains the authority; emitting a
// notification or closing this reader never changes an Agent/Source reservation.
export class AgentEventHttpError extends Error {
 constructor(code,details){super('Agent event observation is unavailable');this.code=code;this.outcome='not-dispatched';if(details)this.details=details;}
}
const invalid=()=>{throw new AgentEventHttpError('AGENT_EVENT_CURSOR_INVALID');};
const runPattern='arun_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const cursorPattern=new RegExp('^aec1\\.('+runPattern+')\\.(0|[1-9][0-9]{0,15})$');
export function agentEventCursor(agentRunId,sequence){
 if(!new RegExp('^'+runPattern+'$').test(agentRunId)||!Number.isSafeInteger(sequence)||sequence<0)invalid();
 return 'aec1.'+agentRunId+'.'+sequence;
}
export function agentEventAfter(agentRunId,value){
 if(value===undefined)return 0;const match=typeof value==='string'&&cursorPattern.exec(value);
 if(!match||match[1]!==agentRunId||!Number.isSafeInteger(Number(match[2])))invalid();return Number(match[2]);
}
export function agentEventStreamOptions(value={}){
 const defaults={pollIntervalMs:250,heartbeatMs:10000,maxDurationMs:30000,writeTimeoutMs:5000,maxEvents:64,maxBytes:262144};
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw TypeError('Invalid Agent event stream bounds');
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(value);
 if(keys.some(k=>!Object.hasOwn(defaults,k)||!Object.hasOwn(descriptors[k],'value')))throw TypeError('Invalid Agent event stream bounds');
 const v={...defaults,...Object.fromEntries(keys.map(k=>[k,descriptors[k].value]))},ranges={pollIntervalMs:[10,1000],heartbeatMs:[50,30000],maxDurationMs:[100,60000],writeTimeoutMs:[50,10000],maxEvents:[1,64],maxBytes:[8192,262144]};
 if(Object.entries(ranges).some(([k,[min,max]])=>!Number.isSafeInteger(v[k])||v[k]<min||v[k]>max)||v.pollIntervalMs>v.heartbeatMs||v.heartbeatMs>v.maxDurationMs||v.writeTimeoutMs>v.maxDurationMs)throw TypeError('Invalid Agent event stream bounds');
 return Object.freeze(v);
}
function bounds(page){return {agentRunId:page.agentRunId,historyOrigin:page.historyOrigin,after:agentEventCursor(page.agentRunId,page.after),oldestCursor:agentEventCursor(page.agentRunId,page.oldestSequence-1),latestCursor:agentEventCursor(page.agentRunId,page.latestSequence)};}
export function agentEventGap(page){return {schema:'agent-event-gap-v1',...bounds(page),missingHistory:true};}
export function agentEventPage(page){
 if(page.gap)throw new AgentEventHttpError('AGENT_EVENT_GAP',agentEventGap(page));
 return {...page,schema:'agent-event-http-page-v1',...bounds(page),nextCursor:agentEventCursor(page.agentRunId,page.nextCursor)};
}
function frame(type,data,id){
 const value=(id?'id: '+id+'\n':'')+'event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n';
 if(Buffer.byteLength(value)>4096)throw new AgentEventHttpError('AGENT_INVALID_REPLY');return value;
}
function pause(ms,signal){
 return new Promise((resolve,reject)=>{
  const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);},timer=setTimeout(finish,ms);
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
}
// Exactly one frame is handed to the Writable at a time. A false write return
// must drain AND complete its callback before another frame/page is produced.
export function writeAgentEventFrame(res,value,signal,timeoutMs){
 return new Promise((resolve,reject)=>{
  let completed=false,callback=false,drained=false,returned=false;
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);res.off('error',error);res.off('close',close);res.off('drain',drain);};
  const finish=e=>{if(completed)return;completed=true;cleanup();if(e)reject(e);else resolve();};
  const check=()=>{if(returned&&callback&&drained)finish();},error=e=>finish(e),close=()=>finish(new AgentEventHttpError('AGENT_EVENT_STREAM_STALLED')),abort=()=>finish(signal.reason),drain=()=>{drained=true;check();};
  const timer=setTimeout(()=>{finish(new AgentEventHttpError('AGENT_EVENT_STREAM_STALLED'));res.destroy();},timeoutMs);timer.unref();
  signal.addEventListener('abort',abort,{once:true});res.once('error',error);res.once('close',close);res.once('drain',drain);
  if(signal.aborted){abort();return;}
  try{const accepted=res.write(value,e=>{if(e){finish(e);return;}callback=true;check();});drained=drained||accepted;returned=true;check();}catch(e){finish(e);}
 });
}
function finishReader(res,signal,timeoutMs){
 return new Promise((resolve,reject)=>{
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);res.off('finish',finish);res.off('close',close);res.off('error',error);};
  const finish=()=>{cleanup();resolve();},error=e=>{cleanup();reject(e);},close=()=>error(new AgentEventHttpError('AGENT_EVENT_STREAM_STALLED')),abort=()=>error(signal.reason);
  const timer=setTimeout(()=>{error(new AgentEventHttpError('AGENT_EVENT_STREAM_STALLED'));res.destroy();},timeoutMs);timer.unref();
  signal.addEventListener('abort',abort,{once:true});res.once('finish',finish);res.once('close',close);res.once('error',error);
  if(signal.aborted){abort();return;}try{res.end();}catch(e){error(e);}
 });
}
export async function streamAgentEvents({res,requestId,signal,access,reference,initial,options}){
 // Validate the initial gap before sending HTTP headers; a later gap is an
 // explicit final frame without an SSE id. Neither case advances the cursor.
 agentEventPage(initial);let page=initial,cursor=initial.after,count=0,bytes=0,reason;initial=null;
 const started=performance.now(),deadline=started+options.maxDurationMs;let heartbeatAt=started+options.heartbeatMs;
 res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-request-id':requestId,'connection':'close','x-accel-buffering':'no'});
 const emitFrame=async value=>{const size=Buffer.byteLength(value);if(bytes+size>options.maxBytes)throw new AgentEventHttpError('AGENT_INVALID_REPLY');await writeAgentEventFrame(res,value,signal,Math.max(1,Math.min(options.writeTimeoutMs,deadline-performance.now())));bytes+=size;};
 const emit=(type,data,id)=>emitFrame(frame(type,data,id));
 await emit('ready',{schema:'agent-event-stream-v1',...bounds(page),cursor:agentEventCursor(reference.agentRunId,cursor)});
 outer:for(;;){
  if(signal.aborted)throw signal.reason;
  if(page.gap){await emit('gap',agentEventGap(page));await finishReader(res,signal,options.writeTimeoutMs);return;}
  for(const event of page.events){
   if(performance.now()>=deadline){reason='duration';break outer;}
   const id=agentEventCursor(reference.agentRunId,event.sequence),value=frame('agent',event,id);
   if(bytes+Buffer.byteLength(value)>options.maxBytes-1024){reason='bytes';break outer;}
   await emitFrame(value);cursor=event.sequence;count++;
   if(count>=options.maxEvents){reason='events';break outer;}
  }
  if(performance.now()>=deadline){reason='duration';break;}
  if(!page.hasMore){
   if(performance.now()>=heartbeatAt){
    const data={schema:'agent-heartbeat-v1',agentRunId:reference.agentRunId,cursor:agentEventCursor(reference.agentRunId,cursor),observedAt:new Date().toISOString()};
    if(bytes+Buffer.byteLength(frame('heartbeat',data))>options.maxBytes-1024){reason='bytes';break;}
    await emit('heartbeat',data);heartbeatAt=performance.now()+options.heartbeatMs;
   }
   await pause(Math.max(1,Math.min(options.pollIntervalMs,deadline-performance.now(),heartbeatAt-performance.now())),signal);
  }
  if(performance.now()>=deadline){reason='duration';break;}
  page=access.events({...reference,after:cursor});
 }
 // Finite windows require a fresh authenticated request. This checkpoint is an
 // observation boundary, never a Run outcome or acknowledgement of side effects.
 const value=frame('checkpoint',{schema:'agent-event-checkpoint-v1',agentRunId:reference.agentRunId,cursor:agentEventCursor(reference.agentRunId,cursor),reason});
 if(bytes+Buffer.byteLength(value)<=options.maxBytes)await writeAgentEventFrame(res,value,signal,options.writeTimeoutMs);
 await finishReader(res,signal,options.writeTimeoutMs);
}
