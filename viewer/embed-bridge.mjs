import {ViewerPort,ViewerChannelError,readViewerHello,viewerOrigin,viewerPort} from '../sdk/viewer-channel.mjs';
import {ViewerConnectionError} from '../sdk/viewer-connection.mjs';
const fail=code=>{throw new ViewerChannelError(code);};
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))fail('VIEWER_INVALID_CONFIG');}
function state(value){
 const result={};for(const name of ['state','sessionId','role','attempt','version','code'])if(Object.hasOwn(value??{},name))result[name]=value[name];return result;
}

// Installed synchronously before Window load. Metadata may still be pending;
// keep at most one candidate port, then authorize against the server snapshot.
export function attachViewerChild({targetWindow=globalThis.window,ready,api}={}){
 const parent=targetWindow?.parent;if(!targetWindow||!parent||parent===targetWindow)return ()=>{};
 let closed=false,pending=null,config=null,endpoint=null,lastChannel=null,metadataFailed=false;
 const rejectPorts=ports=>{if(Array.isArray(ports))for(const port of ports)if(viewerPort(port))port.close();};
 const clearPending=()=>{if(!pending)return;clearTimeout(pending.timer);pending.port.close();pending=null;};
 const bind=()=>{
  if(closed||metadataFailed||!pending||!config)return;
  const candidate=pending;pending=null;clearTimeout(candidate.timer);
  if(!config.allowedParentOrigins.includes(candidate.origin)||candidate.channel===lastChannel||endpoint&&!endpoint.closed){candidate.port.close();return;}
  lastChannel=candidate.channel;
  const current=new ViewerPort({port:candidate.port,channel:candidate.channel,handle:async(method,data,{signal})=>{
   if(method==='connect'){
    fields(data,['gatewayOrigin','audience','sessionId','role','version','requestTimeoutMs']);
    if(data.gatewayOrigin!==config.gatewayOrigin||data.audience!==targetWindow.location.origin)fail('VIEWER_INVALID_CONFIG');if(signal.aborted)fail('CHANNEL_ABORTED');
    api.connect({gatewayOrigin:data.gatewayOrigin,sessionId:data.sessionId,role:data.role,...(data.version===undefined?{}:{version:data.version}),requestTimeoutMs:data.requestTimeoutMs,getTicket:async request=>{
     try{return await current.request('ticket',{reason:request.reason,previousGrantId:request.previousGrantId},{signal:request.signal});}
     catch(error){throw new ViewerConnectionError(error.code);}
    }});return {accepted:true};
   }
   if(method==='disconnect'){if(data!==null)fail('CHANNEL_PROTOCOL');api.disconnect();return {disconnected:true};}
   if(method==='take-control'||method==='release-control'){if(!data||typeof data!=='object'||Object.keys(data).length!==1||!Number.isSafeInteger(data.timeoutMs)||data.timeoutMs<50||data.timeoutMs>10000)fail('CHANNEL_PROTOCOL');return await api[method==='take-control'?'takeControl':'releaseControl']({signal,timeoutMs:data.timeoutMs});}
   if(method==='state'){if(data!==null)fail('CHANNEL_PROTOCOL');return state(api.state);}
   fail('CHANNEL_PROTOCOL');
  },onClose:()=>{if(endpoint===current){endpoint=null;api.disconnect();}}});
  endpoint=current;current.notify('ready',{gatewayOrigin:config.gatewayOrigin,viewerBuild:config.viewerBuild});current.notify('state',state(api.state));if(api.control!==undefined)current.notify('control',api.control);
 };
 const hello=event=>{
  const channel=readViewerHello(event.data);if(!channel)return;
  const ports=event.ports;
  if(closed||metadataFailed||event.source!==parent||!Array.isArray(ports)||ports.length!==1||!viewerPort(ports[0])||endpoint&&!endpoint.closed||channel===lastChannel){rejectPorts(ports);return;}
  let origin;try{origin=viewerOrigin(event.origin);}catch{rejectPorts(ports);return;}
  if(config&&!config.allowedParentOrigins.includes(origin)){rejectPorts(ports);return;}
  clearPending();const candidate={channel,origin,port:ports[0],timer:null};candidate.timer=setTimeout(()=>{if(pending===candidate)clearPending();},10000);candidate.timer.unref?.();pending=candidate;bind();
 };
 const notify=event=>{if(endpoint&&!endpoint.closed){try{endpoint.notify('state',state(event.detail));}catch{endpoint.close('CHANNEL_PROTOCOL');}}};
 const control=event=>{if(endpoint&&!endpoint.closed){try{endpoint.notify('control',event.detail);}catch{endpoint.close('CHANNEL_PROTOCOL');}}};
 const dispose=()=>{if(closed)return;closed=true;targetWindow.removeEventListener('message',hello);targetWindow.removeEventListener('remote-paint-connection',notify);targetWindow.removeEventListener('remote-paint-control',control);targetWindow.removeEventListener('pagehide',dispose);clearPending();endpoint?.close();endpoint=null;};
 targetWindow.addEventListener('message',hello);targetWindow.addEventListener('remote-paint-connection',notify);targetWindow.addEventListener('remote-paint-control',control);targetWindow.addEventListener('pagehide',dispose);
 void Promise.resolve(ready).then(value=>{
  if(closed)return;
  if(!value||value.schema!=='public-viewer-v1'||!Array.isArray(value.allowedParentOrigins)||value.allowedParentOrigins.length>32||typeof value.viewerBuild!=='string'||!/^[a-f0-9]{64}$/.test(value.viewerBuild))fail('VIEWER_CONFIG_INVALID');
  config={gatewayOrigin:viewerOrigin(value.gatewayOrigin),viewerBuild:value.viewerBuild,allowedParentOrigins:value.allowedParentOrigins.map(viewerOrigin)};bind();
 }).catch(()=>{metadataFailed=true;clearPending();endpoint?.close('VIEWER_CONFIG_INVALID');});
 return dispose;
}
