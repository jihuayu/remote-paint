import {randomUUID,randomBytes} from 'node:crypto';
import {readPublicEditor,readPointerFeedback} from './feedback.mjs';
export class InputError extends Error {constructor(code){super(code);this.code=code;}}
const reject=code=>{throw new InputError(code);};
const viewportCodes=new Set(['INVALID_VIEWPORT_REQUEST','UNSUPPORTED_VIEWPORT','VIEWPORT_BUSY','STALE_VIEWPORT_REQUEST','STALE_SESSION','PAGE_TRANSITION','STALE_EPOCH','STALE_VIEWPORT','STALE_LEASE','INPUT_QUEUE_FULL','SESSION_CLOSED','VIEWPORT_RESIZE_FAILED','VIEWPORT_SUPERSEDED']);
const viewportId=value=>Number.isSafeInteger(value)&&value>=1;
const number=(n,limit=1e7)=>Number.isFinite(n)&&Math.abs(n)<=limit;
export function validateInput(event,viewport){
 if(!event||typeof event!=='object')reject('INVALID_EVENT');
 const modifiers=event.modifiers??0;if(!Number.isInteger(modifiers)||modifiers<0||modifiers>15)reject('INVALID_MODIFIERS');
 if(event.kind==='mouse'||event.kind==='wheel'){
  if(!number(event.x)||!number(event.y)||event.x<0||event.y<0||event.x>=viewport.cssWidth||event.y>=viewport.cssHeight)reject('INVALID_COORDINATES');
  if(event.kind==='wheel'){
   if(!number(event.deltaX,10000)||!number(event.deltaY,10000))reject('INVALID_WHEEL');
   return {method:'Input.dispatchMouseEvent',params:{type:'mouseWheel',x:event.x,y:event.y,deltaX:event.deltaX,deltaY:event.deltaY,modifiers}};
  }
  if(!['mouseMoved','mousePressed','mouseReleased'].includes(event.type)||!['none','left','middle','right'].includes(event.button)||!Number.isInteger(event.buttons)||event.buttons<0||event.buttons>7||!Number.isInteger(event.clickCount)||event.clickCount<0||event.clickCount>2)reject('INVALID_MOUSE');
  return {method:'Input.dispatchMouseEvent',params:{type:event.type,x:event.x,y:event.y,button:event.button,buttons:event.buttons,clickCount:event.clickCount,modifiers}};
 }
 if(event.kind==='key'){
  if(!['keyDown','rawKeyDown','keyUp'].includes(event.type)||typeof event.key!=='string'||event.key.length>64||typeof event.code!=='string'||event.code.length>64||event.text!==undefined&&(typeof event.text!=='string'||event.text.length>32))reject('INVALID_KEY');
  const params={type:event.type,key:event.key,code:event.code,modifiers};
  for(const field of ['windowsVirtualKeyCode','nativeVirtualKeyCode'])if(event[field]!==undefined){if(!Number.isInteger(event[field])||event[field]<0||event[field]>65535)reject('INVALID_KEY');params[field]=event[field];}
  if(event.text!==undefined)params.text=event.text;
  // Native Mac editor shortcuts need an explicit Blink edit command when
  // injected through CDP. Client-supplied command strings are never executed.
  if(event.type!=='keyUp'&&(modifiers&6)&&event.key.toLowerCase()==='a')params.commands=['selectAll'];
  return {method:'Input.dispatchKeyEvent',params};
 }
 if(event.kind==='text'){
  if(typeof event.text!=='string'||event.text.length>8192)reject('INVALID_TEXT');
  return {method:'Input.insertText',params:{text:event.text}};
 }
 if(event.kind==='composition'){
  if(!['start','update','commit','cancel'].includes(event.phase)||typeof event.text!=='string'||event.text.length>8192)reject('INVALID_COMPOSITION');
  if(event.phase==='commit'&&event.text)return {method:'Input.insertText',params:{text:event.text}};
  const text=event.phase==='cancel'?'':event.text,start=event.selectionStart??text.length,end=event.selectionEnd??text.length;
  if(![start,end].every(n=>Number.isInteger(n)&&n>=0&&n<=text.length)||start>end)reject('INVALID_COMPOSITION_RANGE');
  return {method:'Input.imeSetComposition',params:{text,selectionStart:start,selectionEnd:end}};
 }
 reject('INVALID_EVENT');
}
export class ControlLease {
 constructor(source,cdp,{ttl=30000}={}){
  this.source=source;this.cdp=cdp;this.ttl=ttl;this.sessionId=randomUUID();this.mode='agent';this.holder=null;this.lease=null;this.version=0;
  this.nextSeq=1;this.tail=Promise.resolve();this.queued=0;this.closed=false;this.peers=new Map();this.keys=new Map();this.buttons=new Map();this.pointer={x:0,y:0};this.feedbackNamespace=randomUUID();
  this.viewportRequests=new Map();this.viewportPending=null;
  this.onInvalidate=()=>{this.revoke('page-changed').catch(()=>{});};source.on('invalidate',this.onInvalidate);
  this.inputRevision=0;this.feedbackRevision=0;this.lastFeedbackAt=0;
  this.onFrame=()=>this.scheduleFeedback();source.on('frame',this.onFrame);
 }
 attach(peer){this.peers.set(peer.id,peer);this.sendState(peer);}
 detach(id){this.peers.delete(id);this.viewportRequests.delete(id);if(this.holder===id)this.revoke('disconnected').catch(()=>{});}
 state(){return {mode:this.mode,holder:this.holder,expiresAt:this.expiresAt??null,pageEpoch:this.source.pageEpoch,viewportVersion:this.source.viewportVersion};}
 sendState(peer){if(peer.ready&&!peer.closed)peer.send({type:'ControlState',...this.state()});}
 broadcast(){for(const peer of this.peers.values())this.sendState(peer);}
 enqueue(fn){
  if(this.closed)reject('SESSION_CLOSED');if(this.queued>=64)reject('INPUT_QUEUE_FULL');this.queued++;
  const promise=this.tail.then(fn);this.tail=promise.catch(()=>{}).finally(()=>this.queued--);return promise;
 }
 tags(message){
  if(message.sessionId!==this.sessionId)reject('STALE_SESSION');
  if(this.source.transitioning)reject('PAGE_TRANSITION');
  if(message.pageEpoch!==this.source.pageEpoch)reject('STALE_EPOCH');
  if(message.viewportVersion!==this.source.viewportVersion)reject('STALE_VIEWPORT');
 }
 validLease(peer,message){
  this.tags(message);
  if(this.mode!=='human'||this.holder!==peer||message.lease!==this.lease||Date.now()>=this.expiresAt)reject('STALE_LEASE');
 }
 armExpiry(){clearTimeout(this.expiryTimer);this.expiryTimer=setTimeout(()=>{this.revoke('expired').catch(()=>{});},this.ttl);this.expiryTimer.unref?.();}
 async acquire(peer,message){
  this.tags(message);if(!this.source.latest)reject('NO_DISPLAY_FRAME');
  if(this.mode==='human'&&this.holder===peer&&Date.now()<this.expiresAt){this.expiresAt=Date.now()+this.ttl;this.armExpiry();return this.grant();}
  if(this.mode!=='agent')reject('CONTROL_BUSY');
  const version=++this.version;this.mode='handoff';this.holder=peer;this.broadcast();
  await this.fence(()=>this.cleanup());
  if(this.closed||this.version!==version||this.holder!==peer)reject('HANDOFF_CANCELED');
  try{this.tags(message);}catch(error){await this.revoke('page-changed');throw error;}
  this.mode='human';this.lease=randomBytes(24).toString('hex');this.feedbackSignature=null;this.expiresAt=Date.now()+this.ttl;this.armExpiry();this.broadcast();return this.grant();
 }
 grant(){return {sessionId:this.sessionId,lease:this.lease,feedbackEpoch:this.version,nextSeq:this.nextSeq,expiresAt:this.expiresAt,pageEpoch:this.source.pageEpoch,viewportVersion:this.source.viewportVersion};}
 renew(peer,message){this.validLease(peer,message);this.expiresAt=Date.now()+this.ttl;this.armExpiry();return this.grant();}
 async dispatch(event){
  const command=validateInput(event,this.source.viewport);await this.cdp.send(command.method,command.params);
  if(event.kind==='mouse'){
   this.pointer={x:event.x,y:event.y};
   if(event.type==='mousePressed')this.buttons.set(event.button,event.button);if(event.type==='mouseReleased')this.buttons.delete(event.button);
  }
  if(event.kind==='key'){
   if(event.type==='keyUp')this.keys.delete(event.code);else this.keys.set(event.code,{...command.params,type:'keyUp',text:undefined,commands:undefined,modifiers:0});
  }
 }
 async optimisticState(event){
  if(!['key','text','composition'].includes(event.kind)&&!(event.kind==='mouse'&&['mousePressed','mouseReleased'].includes(event.type)))return undefined;
  const descriptor={kind:event.kind,phase:event.phase,textLength:event.textLength??event.text?.length??0,selectionStart:event.selectionStart};
  try{return await this.source.page.evaluate(readPublicEditor,{namespace:this.feedbackNamespace,event:descriptor}).catch(()=>null);}catch{return null;}
 }
 async pointerState(event){
  if(event.kind!=='mouse')return undefined;
  try{return await this.source.page.evaluate(readPointerFeedback,{x:event.x,y:event.y}).catch(()=>null);}catch{return null;}
 }
 scheduleFeedback(){
  if(this.closed||this.mode!=='human')return;
  const peer=this.peers.get(this.holder);
  if(!peer?.feedback||!peer.ready||peer.closed)return;
  this.feedbackDirty=true;if(this.feedbackReading||this.feedbackTimer)return;
  this.feedbackTimer=setTimeout(()=>{this.feedbackTimer=null;void this.readFeedback();},Math.max(0,100-(Date.now()-this.lastFeedbackAt)));this.feedbackTimer.unref?.();
 }
 async readFeedback(){
  const peer=this.peers.get(this.holder),latest=this.source.latest;
  if(this.closed||this.mode!=='human'||!peer?.feedback||peer.closed||this.injecting||!latest||(latest.lastProcessedInputSeq??0)<this.source.inputSeq)return;
  this.feedbackReading=true;this.feedbackDirty=false;this.lastFeedbackAt=Date.now();
  const version=this.version,revision=this.inputRevision,pageEpoch=this.source.pageEpoch,viewportVersion=this.source.viewportVersion,afterInputSeq=this.source.inputSeq;
  try{
   const [editor,pointer]=await Promise.all([this.optimisticState(this.compositionEvent??{kind:'text'}),this.pointerState({kind:'mouse',...this.pointer})]);
   if(this.closed||this.mode!=='human'||version!==this.version||revision!==this.inputRevision||this.injecting||pageEpoch!==this.source.pageEpoch||viewportVersion!==this.source.viewportVersion||peer.closed)return;
   const signature=JSON.stringify({afterInputSeq,editor,pointer});if(signature===this.feedbackSignature)return;this.feedbackSignature=signature;
   peer.send({type:'FeedbackState',sessionId:this.sessionId,feedbackEpoch:version,revision:++this.feedbackRevision,afterInputSeq,pageEpoch,viewportVersion,native:this.source.latest?.native??null,editor:editor??null,pointer:pointer??null});
  }catch{this.feedbackSignature=null;}finally{this.feedbackReading=false;if(this.feedbackDirty||revision!==this.inputRevision)this.scheduleFeedback();}
 }
 input(peer,message){
  this.validLease(peer,message);if(!Number.isSafeInteger(message.seq)||message.seq!==this.nextSeq)reject('STALE_SEQUENCE');
  validateInput(message.event,this.source.viewport);const version=this.version;
  const promise=this.enqueue(async()=>{
   this.validLease(peer,message);if(this.version!==version)reject('STALE_LEASE');
   this.inputRevision++;this.injecting=true;
   try{await this.dispatch(message.event);}finally{this.injecting=false;}
   this.source.inputSeq=message.seq;this.source.requestCapture?.();
   this.compositionEvent=message.event.kind==='composition'&&['start','update'].includes(message.event.phase)?{kind:'composition',phase:message.event.phase,textLength:message.event.text.length,selectionStart:message.event.selectionStart}:null;
   this.scheduleFeedback();
   return {type:'InputAck',seq:message.seq,accepted:true,stage:'input-injected',lastProcessedInputSeq:this.source.inputSeq};
  });
  this.nextSeq++;return promise;
 }
 resizeViewport(peer,message){
  const fields=['type','requestId','width','height','sessionId','pageEpoch','viewportVersion','lease'];
  if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).length!==fields.length||!fields.every(k=>Object.hasOwn(message,k))||message.type!=='ResizeViewport'||!viewportId(message.requestId)||![message.width,message.height].every(n=>Number.isInteger(n)&&n>=1&&n<=4096))reject('INVALID_VIEWPORT_REQUEST');
  this.validLease(peer,message);if(!this.peers.has(peer))reject('STALE_LEASE');if(typeof this.source.resize!=='function'||this.source.viewport.deviceScaleFactor!==1)reject('UNSUPPORTED_VIEWPORT');if(this.viewportPending)reject('VIEWPORT_BUSY');
  if(message.requestId<=(this.viewportRequests.get(peer)??0))reject('STALE_VIEWPORT_REQUEST');this.viewportRequests.set(peer,message.requestId);
  const version=this.version,work=this.enqueue(async()=>{
   this.validLease(peer,message);if(this.version!==version)reject('STALE_LEASE');
   const changed=this.source.viewport.cssWidth!==message.width||this.source.viewport.cssHeight!==message.height;
   const result=()=>({type:'ViewportResized',requestId:message.requestId,changed,pageEpoch:this.source.pageEpoch,viewportVersion:this.source.viewportVersion,viewport:{cssWidth:this.source.viewport.cssWidth,cssHeight:this.source.viewport.cssHeight,deviceScaleFactor:1}});
   if(!changed)return result();
   try{
    await this.source.resize({width:message.width,height:message.height});
    if(this.source.closed||!Number.isSafeInteger(this.source.pageEpoch)||this.source.pageEpoch<message.pageEpoch||!Number.isSafeInteger(this.source.viewportVersion)||this.source.viewportVersion<=message.viewportVersion||this.source.viewport.cssWidth!==message.width||this.source.viewport.cssHeight!==message.height||this.source.viewport.deviceScaleFactor!==1)reject('VIEWPORT_SUPERSEDED');
    if(this.version===version)void this.revoke('viewport-changed').catch(()=>{});return result();
   }catch(error){
    // Once Source.resize was entered, a failed transport/CDP/capture wait does
    // not prove no mutation. Revoke without awaiting our own queue tail.
    void this.revoke('viewport-failed').catch(()=>{});const failure=new InputError(error instanceof InputError&&error.code==='VIEWPORT_SUPERSEDED'?'VIEWPORT_SUPERSEDED':'VIEWPORT_RESIZE_FAILED');failure.outcome='unknown';throw failure;
   }
  });this.viewportPending=work;void work.finally(()=>{if(this.viewportPending===work)this.viewportPending=null;}).catch(()=>{});return work;
 }
 async cleanup(){
  const commands=[['Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}],
   ...[...this.keys.values()].map(params=>['Input.dispatchKeyEvent',params]),
   // A lease can end between press and release. Moving outside the page
   // before releasing prevents ordinary HTML button activation on cleanup.
   ...(this.buttons.size?[['Input.dispatchMouseEvent',{type:'mouseMoved',x:-1,y:-1,button:'none',buttons:[...this.buttons.keys()].reduce((bits,b)=>bits|({left:1,right:2,middle:4}[b]??0),0),clickCount:0}]]:[]),
   ...[...this.buttons.keys()].map(button=>['Input.dispatchMouseEvent',{type:'mouseReleased',x:-1,y:-1,button,buttons:0,clickCount:0}])];
  this.keys.clear();this.buttons.clear();for(const [method,params] of commands){try{await this.cdp.send(method,params);}catch{}}
 }
 fence(fn){const promise=this.tail.then(fn);this.tail=promise.catch(()=>{});return promise;}
 async revoke(reason='released'){
  if(this.closed)return;const version=++this.version;clearTimeout(this.expiryTimer);
  this.mode='handoff';this.holder=null;this.lease=null;this.expiresAt=null;this.feedbackSignature=null;this.compositionEvent=null;clearTimeout(this.feedbackTimer);this.feedbackTimer=null;this.broadcast();
  // Existing CDP work cannot be undone. Fence it, reject queued stale inputs,
  // clear held keys/buttons/composition, then let managed Agent work resume.
  await this.fence(()=>this.cleanup());
  if(this.version===version&&!this.closed){this.mode='agent';this.broadcast();}
  return {reason};
 }
 agent(event){
  if(this.mode!=='agent')reject('AGENT_PAUSED');validateInput(event,this.source.viewport);
  const epoch=this.source.pageEpoch,viewport=this.source.viewportVersion;
  return this.enqueue(async()=>{if(this.source.transitioning||this.source.pageEpoch!==epoch||this.source.viewportVersion!==viewport)reject('STALE_AGENT_PAGE');const release=this.source.acquirePageRun?.();try{await this.dispatch(event);this.source.requestCapture?.();}finally{release?.();}});
 }
 async handle(peer,message){
  try{
   if(message.type==='AcquireControl'){const grant=await this.acquire(peer.id,message);peer.send({type:'ControlGranted',...grant});this.scheduleFeedback();}
   else if(message.type==='RenewControl'){peer.send({type:'ControlGranted',...this.renew(peer.id,message)});}
   else if(message.type==='ReleaseControl'){this.validLease(peer.id,message);await this.revoke('released');}
   else if(message.type==='Input'){peer.send(await this.input(peer.id,message));}
   else if(message.type==='ResizeViewport'){const result=await this.resizeViewport(peer.id,message);if(!peer.closed)peer.send(result);}
   else reject('UNKNOWN_CONTROL_MESSAGE');
  }catch(error){
   if(!peer.closed)peer.send(message.type==='ResizeViewport'?{type:'ViewportResizeDenied',requestId:viewportId(message.requestId)?message.requestId:null,code:viewportCodes.has(error.code)?error.code:'VIEWPORT_RESIZE_FAILED',outcome:error.outcome==='unknown'?'unknown':'not-applied'}:message.type==='Input'?{type:'InputAck',seq:message.seq,accepted:false,code:error.code??'CDP_ERROR',lastProcessedInputSeq:this.source.inputSeq}:{type:'ControlDenied',code:error.code??'CDP_ERROR'});
  }
 }
 close(){
  if(this.closePromise)return this.closePromise;
  this.source.off('invalidate',this.onInvalidate);this.source.off('frame',this.onFrame);clearTimeout(this.expiryTimer);clearTimeout(this.feedbackTimer);
  const closing=this.revoke('closed');closing.catch(()=>{});this.closed=true;
  return this.closePromise=(async()=>{
   const errors=[];
   if(this.source.targetCrashed){try{await this.source.close();}catch(error){errors.push(error);}}
   try{await closing;await this.tail;if(!this.source.targetCrashed)await this.cdp.detach?.();}catch(error){errors.push(error);}
   this.peers.clear();this.viewportRequests.clear();if(errors.length)throw new AggregateError(errors,'Control close failed');
  })();
 }
}
export async function createControl(source){const cdp=await source.page.context().newCDPSession(source.page);return new ControlLease(source,cdp);}
