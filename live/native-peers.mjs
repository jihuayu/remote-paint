// Session/lease adapter only. Native owns frame construction, ACK bases,
// resource references, keyframe recovery and WebSocket output.
export async function startNativePeers(source,{renderer,producer,key,origin,host,port,ackTimeout,viewerBuild,peers,onDemand}){
 const broker=source.broker;
 const find=id=>[...peers].find(peer=>peer.id===id);
 const send=(peerId,message)=>broker.request('send',{peerId,message}).catch(error=>{
  const peer=find(peerId);if(!peer||peer.closed)return;
  peer.closed=true;source.control?.detach(peerId);onDemand();
  void broker.request('send',{peerId,message:{type:'$close',code:1013,reason:'Control delivery failed'}}).catch(()=>{});
  source.emit('peerError',{peerId,message:error.message});
 });
 const onEvent=event=>{
  if(event.event==='PeerReady'){
   const kind=event.consumerKind??'display';
   if(!['display','observation','recording'].includes(kind)){void send(event.peerId,{type:'$close',code:1008,reason:'Invalid consumer kind'});return;}
   const peer={id:event.peerId,kind,ready:true,closed:false,feedback:kind==='display'&&event.inputFeedback===true,stats:{},send(message){void send(this.id,message);},close(code=1000,reason='Closed'){this.closed=true;onDemand();void send(this.id,{type:'$close',code,reason});}};
   peers.add(peer);if(kind==='display')source.control?.attach(peer);onDemand();
   // A new consumer needs a frame after its actual native ordinal fence even
   // when another display already keeps the total encoding demand unchanged.
   source.requestFreshFrame?.();
  }else if(event.event==='ControlClosed'){
   const peer=find(event.peerId);if(peer)source.control?.detach(peer.id);
  }else if(event.event==='PeerClosed'){
   const peer=find(event.peerId);if(peer){peer.closed=true;source.control?.detach(peer.id);peers.delete(peer);onDemand();}
  }else if(event.event==='Control'){
   const peer=find(event.peerId);if(peer?.kind==='display')void source.control?.handle(peer,event.message);
  }else if(event.event==='PeerStats'){
   const peer=find(event.peerId);if(peer)Object.assign(peer.stats,event.stats);
  }
 };
 broker.on('event',onEvent);
 try{
  const result=await broker.request('listen',{config:{renderer,producer,key,origin,host,port,ackTimeout,viewerBuild,input:!!source.control,resourceMemory:source.resourceMemoryVersion===1,sessionId:source.control?.sessionId}});
  return {port:result.port,async createConsumerTicket(kind){
   if(source.closed)throw new Error('Source is closed');
   if(!['observation','recording'].includes(kind))throw new Error('Invalid native consumer kind');
   const fence=source.getConsumerFence?await source.getConsumerFence():{captureOrdinal:source.captureOrdinal,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq};
   if(source.closed)throw new Error('Source is closed');
   return broker.request('consumerTicket',{kind,...fence,inputSeq:Math.max(fence.inputSeq,source.inputSeq)});
  },async close(){
   const errors=[];try{await broker.request('stop');}catch(error){errors.push(error);}
   broker.off('event',onEvent);
   for(const peer of peers){peer.closed=true;try{source.control?.detach(peer.id);}catch(error){errors.push(error);}}
   peers.clear();try{onDemand();}catch(error){errors.push(error);}
   if(errors.length)throw new AggregateError(errors,'Native peers close failed');
  }};
 }catch(error){broker.off('event',onEvent);throw error;}
}
