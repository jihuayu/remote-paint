// Session/lease adapter only. Native owns frame construction, ACK bases,
// resource references, keyframe recovery and WebSocket output.
export async function startNativePeers(source,{renderer,producer,key,origin,host,port,ackTimeout,peers,onDemand}){
 const broker=source.broker;
 const find=id=>[...peers].find(peer=>peer.id===id);
 const send=(peerId,message)=>broker.request('send',{peerId,message}).catch(error=>source.emit('captureError',error));
 const onEvent=event=>{
  if(event.event==='PeerReady'){
   const peer={id:event.peerId,ready:true,closed:false,stats:{},send(message){void send(this.id,message);},close(code=1000,reason='Closed'){this.closed=true;void send(this.id,{type:'$close',code,reason});}};
   peers.add(peer);source.control?.attach(peer);onDemand();
  }else if(event.event==='PeerClosed'){
   const peer=find(event.peerId);if(peer){peer.closed=true;source.control?.detach(peer.id);peers.delete(peer);onDemand();}
  }else if(event.event==='Control'){
   const peer=find(event.peerId);if(peer)void source.control?.handle(peer,event.message);
  }else if(event.event==='PeerStats'){
   const peer=find(event.peerId);if(peer)Object.assign(peer.stats,event.stats);
  }
 };
 broker.on('event',onEvent);
 try{
  const result=await broker.request('listen',{config:{renderer,producer,key,origin,host,port,ackTimeout,input:!!source.control,sessionId:source.control?.sessionId}});
  return {port:result.port,async close(){await broker.request('stop');broker.off('event',onEvent);for(const peer of peers){peer.closed=true;source.control?.detach(peer.id);}peers.clear();onDemand();}};
 }catch(error){broker.off('event',onEvent);throw error;}
}
