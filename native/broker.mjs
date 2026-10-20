import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {RequestMemory,REQUEST_LIMITS,requestLimit} from './request-memory.mjs';
import {encodeRequest} from './request-json.mjs';
import {ResponseReader} from './response-reader.mjs';
import {RESPONSE_LIMITS} from './response-memory.mjs';
function onWrite(broker,owner,error){broker.requestMemory.written(owner);if(error)broker.fail(error);}
function destroyReadable(stream){
 // Destroy stops new native reads,but retained Readables can still own their
 // queued chunks. Remove delivery callbacks,then consume small pieces without
 // decoding or concatenating an entire fragmented queue. No chunk is captured
 // by the Broker's pending close Promise.
 stream.removeAllListeners('data');stream.removeAllListeners('readable');stream.destroy();
 for(let remaining=stream.readableLength;remaining>0;){stream.read(Math.min(remaining,1024));const next=stream.readableLength;if(next>=remaining)break;remaining=next;}
}
export class NativeBroker extends EventEmitter {
 constructor({binary=process.env.REMOTE_PAINT_BROKER??fileURLToPath(new URL('./bin/remote-paint-broker',import.meta.url)),requestLimits={},responseLimits={}}={}){
  super();this.pending=new Map();this.seq=0;this.closed=false;this.stderr='';
  this.requestMemory=new RequestMemory({dataBytes:requestLimit('REMOTE_PAINT_NODE_REQUEST_BYTES',REQUEST_LIMITS.dataBytes,1024*1024,2*1024*1024*1024),controlBytes:requestLimit('REMOTE_PAINT_NODE_CONTROL_BYTES',REQUEST_LIMITS.controlBytes,256*1024,16*1024*1024),...requestLimits});
  this.responses=new ResponseReader({limits:{dataBytes:requestLimit('REMOTE_PAINT_NODE_RESPONSE_BYTES',RESPONSE_LIMITS.dataBytes,1024*1024,2*1024*1024*1024),controlBytes:requestLimit('REMOTE_PAINT_NODE_RESPONSE_CONTROL_BYTES',RESPONSE_LIMITS.controlBytes,256*1024,16*1024*1024),...responseLimits},lookup:id=>this.pending.get(id)?.op,onMessage:message=>this.received(message),onReject:(id,error)=>this.rejectedResponse(id,error),onFailure:error=>this.fail(error),pause:()=>this.child?.stdout.pause(),resume:()=>this.child?.stdout.resume()});
  this.child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
  this.exited=false;this.childDone=new Promise(resolve=>this.child.once('close',()=>{this.exited=true;resolve();}));
  this.onOutput=chunk=>{if(!this.closed)this.responses.feed(chunk);};
  this.onStderr=bytes=>{if(!this.closed)this.stderr=(this.stderr+bytes.toString()).slice(-8192);};
  this.child.stdout.on('data',this.onOutput);this.child.stderr.on('data',this.onStderr);
  this.child.stdin.on('error',error=>this.fail(error));
  this.child.stdout.on('error',error=>this.fail(error));this.child.stderr.on('error',error=>this.fail(error));
  this.child.on('error',error=>this.fail(error));this.child.on('exit',(code,signal)=>this.fail(new Error(`Native Broker exited (${code??signal}): ${this.stderr}`)));
 }
 get outputBuffer(){return this.responses.debugBuffer();}
 resetFinished(pending,error){
  if(pending.op!=='reset'&&pending.op!=='resetScene')return;
  this.emit('resetEnd',Object.freeze({id:pending.id,op:pending.op,ok:!error,closed:this.closed,...(error?{message:error.message,...(error.code?{code:error.code}:{})}:{})}));
 }
 rejectedResponse(id,error){const pending=this.pending.get(id);if(!pending)return;this.pending.delete(id);clearTimeout(pending.timer);this.requestMemory.responded(pending.owner);pending.reject(error);this.resetFinished(pending,error);}
 received(message){
  if(message.event){this.emit('event',message);return;}
  const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);this.requestMemory.responded(pending.owner);
  if(message.error){const error=new Error(message.error);if(typeof message.code==='string')error.code=message.code;pending.reject(error);this.resetFinished(pending,error);return;}
  let result=message.result;
  if(pending.op==='resourceBudget'&&result&&typeof result==='object'&&!Array.isArray(result)){const nodeRequests=this.requestMemory.stats(),nodeResponses=this.responses.stats();result={...result,nodeRequests,nodeResponses,ready:result.ready===true&&nodeRequests.ready&&nodeResponses.ready};}
  pending.resolve(result);
  this.resetFinished(pending);
 }
 beginClose(error,force){
  if(this.closePromise)return this.closePromise;
  this.closed=true;
  this.requestMemory.beginClose();for(const pending of this.pending.values()){clearTimeout(pending.timer);this.requestMemory.responded(pending.owner);pending.reject(error);this.resetFinished(pending,error);}this.pending.clear();
  const responseClosed=this.responses.close();this.stderr='';
  this.child.stdout.off('data',this.onOutput);this.child.stderr.off('data',this.onStderr);
  // Discard queued writes and unread pipe buffers as well as parsed output.
  this.child.stdin.destroy();destroyReadable(this.child.stdout);destroyReadable(this.child.stderr);
  let terminateTimer,killTimer;
  this.closePromise=this.childDone.then(()=>Promise.all([this.requestMemory.afterClose(),responseClosed])).finally(()=>{clearTimeout(terminateTimer);clearTimeout(killTimer);});
  const terminate=()=>{if(this.exited)return;this.child.kill('SIGTERM');killTimer=setTimeout(()=>{if(!this.exited)this.child.kill('SIGKILL');},2000);killTimer.unref();};
  if(force)terminate();else{terminateTimer=setTimeout(terminate,2000);terminateTimer.unref();}
  return this.closePromise;
 }
 fail(error){if(this.closed)return;void this.beginClose(error,true);this.emit('failure',error);}
 request(op,args={}){
  if(this.closed)return Promise.reject(new Error('Native Broker closed'));
  let owner,packet;const id=this.seq+1;
  try{if(!Number.isSafeInteger(id))throw new Error('Native Broker request ID exhausted');owner=this.requestMemory.begin(op);packet=encodeRequest(id,op,args,this.requestMemory,owner);}catch(error){if(owner)this.requestMemory.abort(owner);return Promise.reject(error);}
  this.seq=id;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail(new Error(`Native Broker ${op} timeout`)),15000);this.pending.set(id,{id,resolve,reject,timer,owner,op});try{if(op==='reset'||op==='resetScene')this.emit('resetStart',Object.freeze({id,op}));this.child.stdin.write(packet,onWrite.bind(null,this,owner));}catch(error){this.fail(error);}finally{
   // The pending timeout shares this lexical context. Clear its packet slot
   // after the pipe takes ownership instead of pinning the Buffer until reply.
   packet=null;
  }});
 }
 async map(capture,{epoch,viewport,viewportVersion,inputSeq=0,metadataOnly=false,captureOrdinal}){
  const result=await this.request('map',{capture,epoch,viewport,viewportVersion,inputSeq,metadataOnly,...(captureOrdinal===undefined?{}:{captureOrdinal})});
  return {...result.metadata,scene:result.scene,brokerSerial:result.serial,payloads:new Map(result.resources.map(item=>[item.id,{length:item.bytes,byteLength:item.bytes}]))};
 }
 reset(){return this.request('reset');}
 resetScene(){return this.request('resetScene');}
 close(){return this.beginClose(new Error('Native Broker closed'),false);}
}
