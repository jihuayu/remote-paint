import {randomUUID} from 'node:crypto';
import {encodeResource} from '../protocol/wire.mjs';
import {LIVE_VERSION,LIVE_LIMITS,makeDelta,validateScene} from '../protocol/live-wire.mjs';
export class LivePeer {
 constructor(ws,source,{renderer,producer,onReady=()=>{},ackTimeout=5000,codec}={}){
  this.id=randomUUID();this.ws=ws;this.source=source;this.renderer=renderer;this.producer=producer;this.onReady=onReady;this.ackTimeout=ackTimeout;this.codec=codec;
  this.ready=false;this.closed=false;this.nextId=0;this.known=new Set();this.acked=null;this.inflight=null;this.forceFull=true;
  this.stats={full:0,delta:0,resources:0,bytes:0,keyframeRequests:0,coalesced:0,maxBuffered:0,maxInflight:0,slowDisconnects:0};
  this.handshakeTimer=setTimeout(()=>this.close(1008,'Handshake timeout'),10000);
 }
 send(message){this.ws.send(JSON.stringify(message));}
 message(message){
  if(!this.ready){
   if(message.type!=='Hello'||message.protocol!==LIVE_VERSION||message.renderer?.canvaskit!==this.renderer.canvaskit||message.renderer?.wasmSha256!==this.renderer.wasmSha256)throw new Error('Incompatible protocol or renderer');
   this.ready=true;clearTimeout(this.handshakeTimer);
   this.send({type:'Welcome',protocol:LIVE_VERSION,renderer:this.renderer,producer:this.producer,mode:'live-skia-viz',input:!!this.source.control,peerId:this.id,sessionId:this.source.control?.sessionId});
   this.source.control?.attach(this);this.onReady();this.pump();return;
  }
  if(message.type==='FrameAck')this.ack(message);
  else if(message.type==='RequestKeyframe'){
   const now=Date.now();if(!this.recoveryWindow||now-this.recoveryWindow>10000){this.recoveryWindow=now;this.recoveries=0;}
   if(++this.recoveries>8)throw new Error('Too many recovery requests');
   this.stats.keyframeRequests++;clearTimeout(this.ackTimer);this.inflight=null;this.acked=null;this.known.clear();this.forceFull=true;this.pump();
  }else if(this.source.control)return this.source.control.handle(this,message);
  else throw new Error('Unsupported message');
 }
 onFrame(){if(this.inflight)this.stats.coalesced++;this.pump();}
 pump(){
  if(!this.ready||this.closed||this.ws.readyState!==1||this.inflight||!this.source.latest)return;
  const snapshot=this.source.latest;
  if(!this.forceFull&&this.acked?.snapshot===snapshot)return;
  const previous=this.acked;
  const full=this.forceFull||!previous||previous.snapshot.pageEpoch!==snapshot.pageEpoch||previous.snapshot.viewportVersion!==snapshot.viewportVersion;
  const requiredResources=[...snapshot.payloads.keys()];
  validateScene(snapshot.scene,requiredResources,snapshot.viewport);
  const frame={protocol:LIVE_VERSION,pageEpoch:snapshot.pageEpoch,frameId:++this.nextId,baseFrameId:full?null:previous.frameId,
   viewportVersion:snapshot.viewportVersion,viewport:snapshot.viewport,requiredResources,lastProcessedInputSeq:snapshot.lastProcessedInputSeq,
   native:snapshot.native,...(full?{scene:snapshot.scene}:{delta:makeDelta(previous.snapshot.scene,snapshot.scene)})};
  const scene=this.codec?.scene(frame, snapshot, previous?.snapshot)??JSON.stringify({type:'SceneUpdate',frame});if(Buffer.byteLength(scene)>LIVE_LIMITS.sceneBytes)throw new Error('Frame metadata budget exceeded');
  const resources=requiredResources.filter(id=>!this.known.has(id));
  const bytes=resources.reduce((n,id)=>n+snapshot.payloads.get(id).length+44,0)+Buffer.byteLength(scene)+128;
  if(bytes>LIVE_LIMITS.frameBytes+LIVE_LIMITS.sceneBytes||this.ws.bufferedAmount+bytes>LIVE_LIMITS.frameBytes+LIVE_LIMITS.sceneBytes){this.stats.slowDisconnects++;this.close(1013,'Reconnect for bounded keyframe');return;}
  this.inflight={snapshot,frameId:frame.frameId};this.forceFull=false;this.stats.maxInflight=1;
  for(const id of resources){this.ws.send(this.codec?.resource(id,snapshot.payloads.get(id))??encodeResource(id,snapshot.payloads.get(id)));this.known.add(id);}
  this.ws.send(scene);this.send({type:'FrameCommit',pageEpoch:frame.pageEpoch,frameId:frame.frameId});
  this.stats[full?'full':'delta']++;this.stats.resources+=resources.length;this.stats.bytes+=bytes;
  this.stats.maxBuffered=Math.max(this.stats.maxBuffered,this.ws.bufferedAmount);
  this.ackTimer=setTimeout(()=>{this.stats.slowDisconnects++;this.close(1013,'Viewer acknowledgement deadline; reconnect for keyframe');},this.ackTimeout);
 }
 ack(message){
  if(!this.inflight||message.frameId!==this.inflight.frameId||message.pageEpoch!==this.inflight.snapshot.pageEpoch)throw new Error('Unexpected frame acknowledgement');
  clearTimeout(this.ackTimer);this.acked=this.inflight;this.inflight=null;
  const required=new Set(this.acked.snapshot.payloads.keys());const retired=[...this.known].filter(id=>!required.has(id));
  this.known=required;if(retired.length)this.send({type:'ResourceRelease',ids:retired});this.pump();
 }
 close(code=1000,reason='Closed'){this.dispose();this.ws.close(code,reason);}
 dispose(){if(this.closed)return;this.source.control?.detach(this.id);this.closed=true;clearTimeout(this.handshakeTimer);clearTimeout(this.ackTimer);this.inflight=null;this.acked=null;this.known.clear();}
}
