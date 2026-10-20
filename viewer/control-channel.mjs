import {parseMetadataJson} from '/protocol/metadata-json.mjs';
// Runs on the UI thread so Worker/Wasm replay cannot delay control revocation.
export class ControlLink {
 constructor({onMessage,onError,onClose}){Object.assign(this,{onMessage,onError,onClose});this.generation=0;this.active=false;this.pending=[];}
 reset(){this.generation++;this.active=false;this.ready=false;this.pending=[];this.socket?.close();this.socket=null;}
 open(streamUrl,welcome){
  this.reset();if(!welcome.control)return false;
  if(typeof welcome.control.ticket!=='string'||!/^[a-f0-9]{64}$/.test(welcome.control.ticket)||typeof welcome.peerId!=='string'||typeof welcome.sessionId!=='string')throw new Error('Invalid control binding');
  const url=new URL(streamUrl);url.pathname='/control';url.searchParams.set('peer',welcome.peerId);url.searchParams.set('ticket',welcome.control.ticket);
  const current=++this.generation,ws=new WebSocket(url);this.socket=ws;this.active=true;
  ws.onopen=()=>{if(current===this.generation)ws.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId:welcome.sessionId}));};
  ws.onmessage=event=>{
   if(current!==this.generation)return;
   try{
    const {value:message}=parseMetadataJson(event.data,{maxBytes:32*1024,maxNodes:8192,maxEstimateBytes:4*1024*1024});
    if(!this.ready){
     if(message.type!=='ControlWelcome'||message.protocol!==4||message.peerId!==welcome.peerId||message.sessionId!==welcome.sessionId)throw new Error('Incompatible control binding');
     this.ready=true;for(const packet of this.pending)ws.send(packet);this.pending=[];return;
    }
    if(!['ControlState','ControlGranted','ControlDenied','InputAck','FeedbackState','ViewportResized','ViewportResizeDenied','CaptureError'].includes(message.type))throw new Error('Unsupported control metadata');
    this.onMessage(message);
   }catch(error){this.onError(error);ws.close(4008,'Control message rejected');}
  };
  ws.onclose=()=>{if(current===this.generation){this.active=false;this.ready=false;this.pending=[];this.onClose(welcome.peerId);}};
  ws.onerror=()=>{if(current===this.generation)this.onError(new Error('Control connection unavailable'));};
  return true;
 }
 send(message){
  if(!this.active)return false;
  const packet=JSON.stringify(message);
  if(new TextEncoder().encode(packet).byteLength>32*1024||this.pending.length>=32){this.onError(new Error('Control send queue budget exceeded'));this.socket.close(4008,'Control queue limit');return true;}
  if(this.ready&&this.socket.readyState===1)this.socket.send(packet);else this.pending.push(packet);
  return true;
 }
}
