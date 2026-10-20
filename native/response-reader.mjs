import {CONTROL_OPS} from './request-memory.mjs';
import {ResponseEnvelope} from './response-envelope.mjs';
import {ResponseMemory,responsePressure} from './response-memory.mjs';

const MAX_PACKET=90*1024*1024,MAX_CONTROL=256*1024,PREFIX=512;
function continueReader(reader){reader.scheduled=false;if(!reader.closed)reader.pump();}
const decoder=new TextDecoder('utf-8',{fatal:true});

// One received chunk and one exact private packet backing. Pausing the pipe
// while processing it also bounds the one-frame-per-turn delivery transient;
// callbacks cannot queue64 decoded graphs before any credit is retired.
export class ResponseReader {
 constructor({limits={},lookup,onMessage,onReject,onFailure,pause,resume}={}){
  this.memory=new ResponseMemory(limits);Object.assign(this,{lookup,onMessage,onReject,onFailure,pause,resume});
  this.header=Buffer.allocUnsafeSlow(4);this.prefix=Buffer.allocUnsafeSlow(PREFIX);this.headerUsed=0;this.frame=null;this.chunk=null;this.chunkOffset=0;this.ingress=null;this.scheduled=false;this.closed=false;
  this.counters={packets:0,deniedPackets:0,privateAllocations:0,copiedBodyBytes:0,receivedChunks:0};
 }
 route(probe,size){
  const event=typeof probe.event==='string'&&probe.event.length>0?probe.event:null,op=this.lookup?.(probe.id);
  let lane=size<=MAX_CONTROL?'control':'data';if(event)lane='control';else if(op!==undefined)lane=CONTROL_OPS.has(op)?'control':'data';
  return {id:probe.id,event,op,lane,known:event!==null||op!==undefined};
 }
 feed(chunk){
  if(this.closed||chunk.length===0)return;this.pause?.();
  try{
   if(this.chunk)throw new Error('Concurrent Native Broker output chunks');
   this.ingress=this.memory.takeIngress(chunk.buffer.byteLength);this.chunk=chunk;this.chunkOffset=0;this.counters.receivedChunks++;this.pump();
  }catch(error){this.fail(error);}
 }
 schedule(){if(this.closed||this.scheduled)return;this.scheduled=true;setImmediate(continueReader,this);}
 releaseChunk(){this.chunk=null;this.chunkOffset=0;const owner=this.ingress;this.ingress=null;this.memory.releaseIngress(owner);}
 fail(error){if(this.closed)return;void this.close();this.onFailure(error);}
 deny(frame,error){
  if(frame.error)return;frame.error=error;this.counters.deniedPackets++;frame.packet=null;this.memory.retire(frame.owner);frame.owner=null;
  // A small control event has no RPC promise to reject. Losing that event
  // silently would strand a native capture/control waiter.
  const route=this.route(frame.probe,frame.size);
  if(route.event){this.fail(error);return;}
  if(route.id!==undefined){frame.notified=route.id;this.onReject(route.id,error);}
 }
 admit(frame){
  frame.route=this.route(frame.probe,frame.size);
  if(frame.route.lane==='control'&&frame.route.known&&frame.size>MAX_CONTROL){this.deny(frame,responsePressure('control-packet'));return;}
  const attempt=lane=>{frame.owner=this.memory.begin(lane,frame.size);frame.packet=Buffer.allocUnsafeSlow(frame.size);if(frame.packet.buffer.byteLength!==frame.size)throw new Error('Unexpected Broker output backing');this.memory.allocated(frame.owner,frame.size);this.counters.privateAllocations++;};
  try{attempt(frame.route.lane);}
  catch(error){
   // Unknown late headers may try data when a small staging-control pool is
   // tight. Known controls/data never borrow the other final quota.
   if(!frame.owner&&!frame.route.known&&frame.route.lane==='control'){
    try{attempt('data');}catch(next){this.deny(frame,next);return;}
   }else{this.deny(frame,error);return;}
  }
  if(frame.packet){this.prefix.copy(frame.packet,0,0,frame.first);this.counters.copiedBodyBytes+=frame.first;}
 }
 complete(frame){
  let packet=null,text=null,message=null;
  try{
   frame.probe.finish();this.counters.packets++;
   if(frame.error){
    const route=this.route(frame.probe,frame.size);if(route.event){this.fail(frame.error);return;}if(route.id!==undefined&&frame.notified!==route.id)this.onReject(route.id,frame.error);return;
   }
   if(frame.probe.duplicate)throw new SyntaxError('Duplicate Native Broker response header');
   const route=this.route(frame.probe,frame.size);
   if(route.lane==='control'&&route.known&&frame.size>MAX_CONTROL){this.deny(frame,responsePressure('control-packet'));return;}
   try{
    this.memory.transfer(frame.owner,route.lane);
    if(frame.probe.limit)throw responsePressure(frame.probe.limit);
    this.memory.parse(frame.owner,frame.probe.estimate(frame.size));
   }catch(error){this.deny(frame,error);return;}
   packet=frame.packet;
   try{text=decoder.decode(packet);}catch{throw new SyntaxError('Invalid Native Broker output UTF-8');}
   message=JSON.parse(text);
   if(!message||typeof message!=='object'||Array.isArray(message))throw new SyntaxError('Invalid Native Broker response object');
   if(message.event!==undefined&&typeof message.event!=='string')throw new SyntaxError('Invalid Native Broker response event');
   if(message.id!==frame.probe.id||typeof message.event==='string'&&message.event!==frame.probe.event)throw new SyntaxError('Invalid Native Broker response envelope');
   this.onMessage(message);
  }catch(error){this.fail(error);}
  finally{
   // Scheduled continuations only retain this Reader/number-only leases.
   // Clear the decode context before its deferred credits can be reused.
   packet=null;text=null;message=null;frame.packet=null;this.memory.retire(frame.owner);frame.owner=null;
  }
 }
 pump(){
  if(this.closed)return;
  try{
   if(!this.chunk){this.resume?.();return;}
   while(!this.closed&&this.chunkOffset<this.chunk.length){
    if(!this.frame){
     const count=Math.min(4-this.headerUsed,this.chunk.length-this.chunkOffset);this.chunk.copy(this.header,this.headerUsed,this.chunkOffset,this.chunkOffset+count);this.headerUsed+=count;this.chunkOffset+=count;
     if(this.headerUsed<4)break;
     const size=this.header.readUInt32BE();this.headerUsed=0;if(size>MAX_PACKET)throw new Error('Native Broker output packet limit');
     this.frame={size,first:Math.min(size,PREFIX),read:0,probe:new ResponseEnvelope(),packet:null,owner:null,error:null,notified:undefined,admitted:false};
    }
    const frame=this.frame;
    if(frame.read<frame.first){
     const count=Math.min(frame.first-frame.read,this.chunk.length-this.chunkOffset),end=this.chunkOffset+count;
     this.chunk.copy(this.prefix,frame.read,this.chunkOffset,end);frame.probe.feed(this.chunk.subarray(this.chunkOffset,end));frame.read+=count;this.chunkOffset=end;
    }
    if(frame.read===frame.first&&!frame.admitted){frame.admitted=true;this.admit(frame);if(this.closed)return;}
    if(frame.read<frame.size&&frame.read>=frame.first){
     const count=Math.min(frame.size-frame.read,this.chunk.length-this.chunkOffset),end=this.chunkOffset+count,bytes=this.chunk.subarray(this.chunkOffset,end);
     frame.probe.feed(bytes);if(frame.packet){bytes.copy(frame.packet,frame.read);this.counters.copiedBodyBytes+=count;}frame.read+=count;this.chunkOffset=end;
    }
    if(frame.read===frame.size){
     this.complete(frame);this.frame=null;if(this.closed)return;
     if(this.chunkOffset===this.chunk.length)this.releaseChunk();this.schedule();return;
    }
   }
   if(this.chunkOffset===this.chunk.length)this.releaseChunk();this.schedule();
  }catch(error){this.fail(error);}
 }
 // Legacy diagnostics expose sizes, not an escaping alias to the owned data.
 debugBuffer(){return {length:this.frame?.read??this.headerUsed,buffer:{byteLength:this.frame?.packet?.buffer.byteLength??0}};}
 stats(){return {...this.memory.stats(),...this.counters,frameBytesRemaining:this.frame?this.frame.size-this.frame.read:0,draining:!!this.frame?.error,ready:this.memory.ready()&&!this.frame?.error};}
 close(){
  if(this.closePromise)return this.closePromise;this.closed=true;
  if(this.frame){this.frame.packet=null;this.memory.retire(this.frame.owner);this.frame=null;}
  this.releaseChunk();this.headerUsed=0;this.header=null;this.prefix=null;
  return this.closePromise=this.memory.close();
 }
}
