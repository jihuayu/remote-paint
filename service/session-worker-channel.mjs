import {createHash} from 'node:crypto';
import {validateLinuxRuntimeWitness,runtimeWitnessSha256} from './linux-runtime-witness.mjs';
const protocol='session-worker-v1',sink=()=>{};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const plain=v=>v!==null&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype;
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const session=v=>typeof v==='string'&&/^ses_[A-Za-z0-9_-]{1,124}$/.test(v);
const reasons=new Set(['owner-disconnected','worker-terminated','owner-lease-expired','released','protocol-rejected','startup-failed','startup-expired','start-expired','runtime-stop']);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(sink);return {promise,resolve,reject};}
export class SessionWorkerChannelError extends Error {
 constructor(code,startSent=false){super('Session worker channel is unavailable');this.name='SessionWorkerChannelError';this.code=code;this.startSent=startSent;}
}
function capture(request,region){
 if(!exact(request,['url','region','ttlSeconds'])||request.region!==region||!integer(request.ttlSeconds,1,86400)||typeof request.url!=='string'||request.url.length>8192)throw new SessionWorkerChannelError('CHANNEL_INVALID_START');
 let url;try{url=new URL(request.url);}catch{throw new SessionWorkerChannelError('CHANNEL_INVALID_START');}
 if(request.url!=='about:blank'&&(!['http:','https:'].includes(url.protocol)||url.username||url.password))throw new SessionWorkerChannelError('CHANNEL_INVALID_START');
 return JSON.stringify({url:url.href,region,ttlSeconds:request.ttlSeconds});
}

// This owns only one private worker channel, not the runtime or its process
// namespace. clientDone MUST represent an actual ChildProcess close event.
// close() reports separate worker acknowledgement and observed transport exit;
// an owning runtime must still prove complete Native resource retirement.
export class SessionWorkerChannel {
 #session;#region;#key;#input;#output;#onUnavailable;#hello=false;#everReady=false;#workerAck=null;#exit=null;
 #ready=deferred();#terminal=deferred();#startPromise;#fingerprint=null;#pendingStart=null;#startSent=false;
 #signal=null;#abort=null;#phase='waiting-hello';#failure=null;#notified=false;#closing=false;#tornDown=false;
 #closePromise=null;#closeResolve;#closeExpired=false;#writing=null;#queuedClose=null;#closeSent=false;#endedInput=false;
 #helloTimer;#readyTimer=null;#closeTimer=null;#heartbeat=null;#helloMs;#readyMs;#closeMs;#heartbeatMs;
 #requireWitness;#onWitness;#binding;#witnessReceipt=null;#witnessController=new AbortController();#helloDeadline;
 #buffer;#bytes=0;#frames=0;#data;#outputEnd;#streamError;#inputClose;
 constructor({sessionId,region,ownerKey,input,output,clientDone,onUnavailable=sink,requireRuntimeWitness=false,onRuntimeWitness=null,runtimeBinding=null,
  helloTimeoutMs=5000,readyTimeoutMs=65000,closeTimeoutMs=12000,heartbeatMs=5000,maxFrameBytes=2048}={}){
  if(!session(sessionId)||typeof region!=='string'||!region.length||region.length>64||typeof ownerKey!=='string'||!/^[a-f0-9]{64}$/.test(ownerKey)||typeof input?.write!=='function'||typeof input?.end!=='function'||typeof input?.on!=='function'||typeof input?.off!=='function'||typeof output?.on!=='function'||typeof output?.off!=='function'||typeof output?.pause!=='function'||typeof output?.resume!=='function'||typeof clientDone?.then!=='function'||typeof onUnavailable!=='function')throw new TypeError('Configure explicit private streams, identity and actual client close observation');
  for(const [v,min,max]of [[helloTimeoutMs,50,30000],[readyTimeoutMs,50,125000],[closeTimeoutMs,50,35000],[heartbeatMs,10,10000],[maxFrameBytes,512,8192]])if(!integer(v,min,max))throw new TypeError('Invalid worker channel bounds');
  if(typeof requireRuntimeWitness!=='boolean'||requireRuntimeWitness&&(typeof onRuntimeWitness!=='function'||!exact(runtimeBinding,['containerId','daemonId','specDigest'])||!/^[a-f0-9]{64}$/.test(runtimeBinding.containerId)||!/^[a-f0-9]{64}$/.test(runtimeBinding.specDigest)||typeof runtimeBinding.daemonId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runtimeBinding.daemonId))||!requireRuntimeWitness&&(onRuntimeWitness!==null||runtimeBinding!==null))throw new TypeError('Configure a bound private runtime witness gate');
  this.#requireWitness=requireRuntimeWitness;this.#onWitness=onRuntimeWitness;this.#binding=runtimeBinding?Object.freeze(structuredClone(runtimeBinding)):null;
  this.#session=sessionId;this.#region=region;this.#key=ownerKey;this.#input=input;this.#output=output;this.#onUnavailable=onUnavailable;
  this.#helloMs=helloTimeoutMs;this.#readyMs=readyTimeoutMs;this.#closeMs=closeTimeoutMs;this.#heartbeatMs=heartbeatMs;this.#buffer=Buffer.alloc(maxFrameBytes);
  this.#data=chunk=>this.#read(chunk);this.#streamError=()=>this.#fault('CHANNEL_STREAM_FAILED');this.#outputEnd=()=>{if(!this.#closing)this.#fault('CHANNEL_OUTPUT_CLOSED');};this.#inputClose=()=>{if(!this.#closing)this.#fault('CHANNEL_INPUT_CLOSED');};
  input.on('error',this.#streamError);input.on('close',this.#inputClose);output.on('data',this.#data);output.on('error',this.#streamError);output.on('end',this.#outputEnd);
  this.#helloDeadline=performance.now()+this.#helloMs;this.#helloTimer=setTimeout(()=>this.#fault('CHANNEL_HELLO_TIMEOUT'),this.#helloMs);
  void Promise.resolve(clientDone).then(exit=>this.#observeExit(exit),()=>this.#fault('CHANNEL_EXIT_OBSERVATION_FAILED'));
  output.resume?.();
 }
 get terminal(){return this.#terminal.promise;}
 get runtimeWitnessReceipt(){return this.#witnessReceipt;}
 status(){return Object.freeze({phase:this.#phase,startSent:this.#startSent,available:this.#phase==='ready',workerClose:this.#workerAck?.type==='Closed'?'confirmed':'unconfirmed',transportExited:this.#exit!==null,closeTimedOut:this.#closeExpired,runtimeWitness:this.#requireWitness?(this.#witnessReceipt?'confirmed':'unconfirmed'):'not-required',failure:this.#failure});}
 start(request,{signal}={}){
  const body=capture(request,this.#region),fingerprint=createHash('sha256').update(body).digest('hex');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new SessionWorkerChannelError('CHANNEL_INVALID_SIGNAL',this.#startSent);
  if(this.#startPromise){if(this.#fingerprint!==fingerprint||!this.#closing&&(signal??null)!==this.#signal)throw new SessionWorkerChannelError('CHANNEL_START_CONFLICT',this.#startSent);if(this.#closing){const rejected=Promise.reject(new SessionWorkerChannelError('CHANNEL_CLOSED',this.#startSent));void rejected.catch(sink);return rejected;}return this.#startPromise;}
  this.#fingerprint=fingerprint;this.#signal=signal??null;
  this.#startPromise=this.#ready.promise.then(value=>{
   if(this.#phase!=='ready'||this.#signal?.aborted)throw new SessionWorkerChannelError(this.#failure??'CHANNEL_NO_LONGER_READY',this.#startSent);
   return value;
  });void this.#startPromise.catch(sink);
  if(this.#closing){this.#ready.reject(new SessionWorkerChannelError(this.#failure??'CHANNEL_CLOSED',this.#startSent));return this.#startPromise;}
  this.#pendingStart=Buffer.from(JSON.stringify({type:'Start',sessionId:this.#session,ownerKey:this.#key,request:JSON.parse(body)})+'\n');
  if(this.#pendingStart.length-1>32768){this.#pendingStart.fill(0);this.#pendingStart=null;this.#ready.reject(new SessionWorkerChannelError('CHANNEL_START_FRAME_LIMIT'));void this.close();return this.#startPromise;}
  if(this.#signal){this.#abort=()=>{this.#failure??='CHANNEL_OWNER_ABORTED';this.#ready.reject(new SessionWorkerChannelError('CHANNEL_OWNER_ABORTED',this.#startSent));void this.close();};this.#signal.addEventListener('abort',this.#abort,{once:true});if(this.#signal.aborted)this.#abort();}
  this.#dispatchStart();return this.#startPromise;
 }
 #dispatchStart(){
  if(!this.#hello||this.#requireWitness&&!this.#witnessReceipt||!this.#pendingStart||this.#closing||this.#startSent)return;
  const frame=this.#pendingStart;this.#pendingStart=null;this.#startSent=true;this.#phase='starting';
  this.#readyTimer=setTimeout(()=>this.#fault('CHANNEL_READY_TIMEOUT'),this.#readyMs);this.#write(frame);
  if(!this.#closing)this.#heartbeat=setInterval(()=>{if(!this.#closing&&!this.#writing)this.#write(this.#command('OwnerHeartbeat'));},this.#heartbeatMs);
 }
 #command(type){return Buffer.from(JSON.stringify({type,sessionId:this.#session,ownerKey:this.#key})+'\n');}
 #write(frame){
  if(this.#tornDown){frame.fill(0);return;}
  if(this.#writing){if(this.#queuedClose)this.#queuedClose.fill(0);this.#queuedClose=frame;return;}
  this.#writing=frame;
  try{this.#input.write(frame,error=>{
   frame.fill(0);if(this.#writing===frame)this.#writing=null;
   if(error){this.#fault('CHANNEL_WRITE_FAILED');this.#endInput();return;}
   if(this.#queuedClose){const next=this.#queuedClose;this.#queuedClose=null;this.#write(next);}
  });}catch{frame.fill(0);this.#writing=null;this.#fault('CHANNEL_WRITE_FAILED');this.#endInput();}
 }
 #endInput(){if(this.#endedInput)return;this.#endedInput=true;try{this.#input.end();}catch{}}
 #fault(code){
  if(this.#exit!==null||this.#tornDown)return;
  const notify=!this.#closing&&!this.#notified;this.#failure??=code;
  this.#ready.reject(new SessionWorkerChannelError(code,this.#startSent));
  // Establish the same close promise before owner callbacks can reenter.
  void this.close();
  if(notify){this.#notified=true;try{this.#onUnavailable(Object.freeze({code,startSent:this.#startSent,wasReady:this.#everReady}));}catch{}}
 }
 #read(chunk){
  if(this.#tornDown)return;
  if(!Buffer.isBuffer(chunk)){this.#fault('CHANNEL_INVALID_FRAME');return;}
  let offset=0;
  while(offset<chunk.length&&!this.#tornDown){
   const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,length=end-offset;
   if(this.#bytes+length>this.#buffer.length){this.#buffer.fill(0);this.#bytes=0;this.#fault('CHANNEL_FRAME_LIMIT');this.#output.pause();this.#endInput();return;}
   if(length){chunk.copy(this.#buffer,this.#bytes,offset,end);this.#bytes+=length;}
   if(newline<0)return;
   let message;
   try{message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.#buffer.subarray(0,this.#bytes)));}
   catch{this.#buffer.fill(0);this.#bytes=0;this.#fault('CHANNEL_INVALID_FRAME');this.#output.pause();this.#endInput();return;}
   this.#buffer.fill(0,0,this.#bytes);this.#bytes=0;
   if(++this.#frames>8){this.#fault('CHANNEL_FRAME_COUNT_LIMIT');this.#output.pause();this.#endInput();return;}
   this.#message(message);offset=end+1;
  }
 }
 #message(message){
  if(exact(message,['type','protocol','code'])&&message.type==='WorkerConfigurationFailed'&&message.protocol===protocol&&message.code==='WORKER_CONFIGURATION_FAILED'&&!this.#hello){this.#fault('CHANNEL_WORKER_CONFIGURATION_FAILED');this.#endInput();return;}
  if(!plain(message)||message.protocol!==protocol||message.sessionId!==this.#session){this.#fault('CHANNEL_PROTOCOL_MISMATCH');return;}
  if(message.type==='WorkerHello'&&!this.#hello&&!this.#startSent){
   if(this.#closing)return;
   if(performance.now()>=this.#helloDeadline){this.#fault('CHANNEL_HELLO_TIMEOUT');return;}
   if(!this.#requireWitness){if(!exact(message,['type','protocol','sessionId'])){this.#fault('CHANNEL_RUNTIME_WITNESS_UNEXPECTED');return;}this.#hello=true;clearTimeout(this.#helloTimer);this.#dispatchStart();return;}
   if(!exact(message,['type','protocol','sessionId','runtimeWitness'])){this.#fault('CHANNEL_RUNTIME_WITNESS_MISSING');return;}
   let witness;try{witness=validateLinuxRuntimeWitness(message.runtimeWitness);}catch{this.#fault('CHANNEL_RUNTIME_WITNESS_INVALID');return;}
   this.#hello=true;let pending;
   try{pending=this.#onWitness(witness,Object.freeze({signal:this.#witnessController.signal}));}catch{this.#fault('CHANNEL_RUNTIME_WITNESS_FAILED');return;}
   void Promise.resolve(pending).then(receipt=>{
    if(this.#closing||this.#tornDown)return;
    if(performance.now()>=this.#helloDeadline){this.#fault('CHANNEL_HELLO_TIMEOUT');return;}
    if(!exact(receipt,['sessionId','containerId','daemonId','specDigest','witnessSha256','evidenceSha256'])||receipt.sessionId!==this.#session||receipt.containerId!==this.#binding.containerId||receipt.daemonId!==this.#binding.daemonId||receipt.specDigest!==this.#binding.specDigest||receipt.witnessSha256!==runtimeWitnessSha256(witness)||typeof receipt.evidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)){this.#fault('CHANNEL_RUNTIME_WITNESS_RECEIPT');return;}
    this.#witnessReceipt=Object.freeze({...receipt});clearTimeout(this.#helloTimer);this.#dispatchStart();
   },()=>{if(!this.#closing)this.#fault('CHANNEL_RUNTIME_WITNESS_FAILED');});return;
  }
  if(message.type==='Ready'&&exact(message,['type','protocol','sessionId','version'])&&this.#hello&&this.#startSent&&!this.#everReady&&typeof message.version==='string'&&message.version.length>0&&message.version.length<=256){
   this.#everReady=true;if(this.#closing)return;
   clearTimeout(this.#readyTimer);this.#phase='ready';this.#ready.resolve(Object.freeze({version:message.version}));return;
  }
  if(['Closed','CleanupIncomplete'].includes(message.type)&&exact(message,['type','protocol','sessionId','reason','code'])&&this.#workerAck===null&&reasons.has(message.reason)&&(message.code===null||typeof message.code==='string'&&/^WORKER_[A-Z0-9_]{1,64}$/.test(message.code))){
   this.#workerAck=Object.freeze({type:message.type,reason:message.reason,code:message.code});
   if(!this.#closing)this.#fault(message.type==='CleanupIncomplete'?'CHANNEL_WORKER_CLEANUP_INCOMPLETE':'CHANNEL_WORKER_STOPPED');
   else this.#ready.reject(new SessionWorkerChannelError(this.#failure??'CHANNEL_WORKER_STOPPED',this.#startSent));
   return;
  }
  this.#fault('CHANNEL_INVALID_MESSAGE');
 }
 #observeExit(value){
  if(!exact(value,['code','signal'])||!(value.code===null||integer(value.code,-2147483648,2147483647))||!(value.signal===null||typeof value.signal==='string'&&/^SIG[A-Z0-9]{1,24}$/.test(value.signal))||value.code===null&&value.signal===null){this.#fault('CHANNEL_INVALID_EXIT_OBSERVATION');return;}
  const notify=!this.#closing&&!this.#notified,callback=this.#onUnavailable;this.#exit=Object.freeze({code:value.code,signal:value.signal});this.#terminal.resolve(this.#exit);
  if(!this.#closing){this.#failure??='CHANNEL_TRANSPORT_EXITED';void this.close();}
  this.#phase='ended';this.#ready.reject(new SessionWorkerChannelError(this.#failure??'CHANNEL_TRANSPORT_EXITED',this.#startSent));this.#finishClose();
  if(notify){this.#notified=true;try{callback(Object.freeze({code:'CHANNEL_TRANSPORT_EXITED',startSent:this.#startSent,wasReady:this.#everReady}));}catch{}}
 }
 close(){
  if(this.#closePromise)return this.#closePromise;
  this.#closing=true;if(this.#exit===null)this.#phase='closing';
  this.#closePromise=new Promise(resolve=>{this.#closeResolve=resolve;});this.#witnessController.abort();
  clearTimeout(this.#helloTimer);clearTimeout(this.#readyTimer);clearInterval(this.#heartbeat);
  this.#pendingStart?.fill(0);this.#pendingStart=null;
  this.#ready.reject(new SessionWorkerChannelError(this.#failure??'CHANNEL_CLOSED',this.#startSent));
  if(this.#exit!==null){this.#finishClose();return this.#closePromise;}
  this.#closeTimer=setTimeout(()=>{this.#closeExpired=true;this.#phase='uncertain';this.#failure??='CHANNEL_CLOSE_TIMEOUT';this.#endInput();this.#finishClose();},this.#closeMs);
  if(this.#startSent&&!this.#closeSent){this.#closeSent=true;this.#write(this.#command('Close'));}else if(!this.#startSent)this.#endInput();
  return this.#closePromise;
 }
 #finishClose(){
  if(!this.#closePromise||this.#tornDown)return;
  this.#tornDown=true;clearTimeout(this.#closeTimer);clearTimeout(this.#helloTimer);clearTimeout(this.#readyTimer);clearInterval(this.#heartbeat);
  this.#input.off('error',this.#streamError);this.#input.off('close',this.#inputClose);this.#output.off('data',this.#data);this.#output.off('error',this.#streamError);this.#output.off('end',this.#outputEnd);
  this.#input.on('error',sink);this.#output.on('error',sink);this.#output.pause();
  if(this.#abort)this.#signal.removeEventListener('abort',this.#abort);this.#signal=null;this.#abort=null;
  this.#pendingStart?.fill(0);this.#pendingStart=null;this.#queuedClose?.fill(0);this.#queuedClose=null;this.#writing?.fill(0);this.#writing=null;this.#key='';this.#buffer.fill(0);this.#onUnavailable=sink;this.#onWitness=null;this.#binding=null;
  this.#closeResolve(Object.freeze({workerClose:this.#workerAck?.type==='Closed'?'confirmed':'unconfirmed',workerCode:this.#workerAck?.code??null,transportExit:this.#exit,closeTimedOut:this.#closeExpired,startSent:this.#startSent,failure:this.#failure}));
 }
}
