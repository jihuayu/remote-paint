import {randomUUID,randomBytes} from 'node:crypto';
export class InputError extends Error {constructor(code){super(code);this.code=code;}}
const reject=code=>{throw new InputError(code);};
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
  this.nextSeq=1;this.tail=Promise.resolve();this.queued=0;this.closed=false;this.peers=new Map();this.keys=new Map();this.buttons=new Map();this.pointer={x:0,y:0};
  this.onInvalidate=()=>{this.revoke('page-changed').catch(()=>{});};source.on('invalidate',this.onInvalidate);
 }
 attach(peer){this.peers.set(peer.id,peer);this.sendState(peer);}
 detach(id){this.peers.delete(id);if(this.holder===id)this.revoke('disconnected').catch(()=>{});}
 state(){return {mode:this.mode,holder:this.holder,expiresAt:this.expiresAt??null,pageEpoch:this.source.pageEpoch,viewportVersion:this.source.viewportVersion};}
 sendState(peer){if(peer.ready&&!peer.closed)peer.send({type:'ControlState',...this.state()});}
 broadcast(){for(const peer of this.peers.values())this.sendState(peer);}
 enqueue(fn){
  if(this.closed)reject('SESSION_CLOSED');if(this.queued>=64)reject('INPUT_QUEUE_FULL');this.queued++;
  const promise=this.tail.then(fn);this.tail=promise.catch(()=>{}).finally(()=>this.queued--);return promise;
 }
 tags(message){
  if(message.sessionId!==this.sessionId)reject('STALE_SESSION');
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
  this.mode='human';this.lease=randomBytes(24).toString('hex');this.expiresAt=Date.now()+this.ttl;this.armExpiry();this.broadcast();return this.grant();
 }
 grant(){return {sessionId:this.sessionId,lease:this.lease,nextSeq:this.nextSeq,expiresAt:this.expiresAt,pageEpoch:this.source.pageEpoch,viewportVersion:this.source.viewportVersion};}
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
 input(peer,message){
  this.validLease(peer,message);if(!Number.isSafeInteger(message.seq)||message.seq!==this.nextSeq)reject('STALE_SEQUENCE');
  validateInput(message.event,this.source.viewport);const version=this.version;
  const promise=this.enqueue(async()=>{
   this.validLease(peer,message);if(this.version!==version)reject('STALE_LEASE');
   await this.dispatch(message.event);this.source.inputSeq=message.seq;
   return {type:'InputAck',seq:message.seq,accepted:true,lastProcessedInputSeq:this.source.inputSeq};
  });
  this.nextSeq++;return promise;
 }
 async cleanup(){
  const commands=[['Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0}],
   ...[...this.keys.values()].map(params=>['Input.dispatchKeyEvent',params]),
   ...[...this.buttons.keys()].map(button=>['Input.dispatchMouseEvent',{type:'mouseReleased',...this.pointer,button,buttons:0,clickCount:1}])];
  this.keys.clear();this.buttons.clear();for(const [method,params] of commands){try{await this.cdp.send(method,params);}catch{}}
 }
 fence(fn){const promise=this.tail.then(fn);this.tail=promise.catch(()=>{});return promise;}
 async revoke(reason='released'){
  if(this.closed)return;const version=++this.version;clearTimeout(this.expiryTimer);
  this.mode='handoff';this.holder=null;this.lease=null;this.expiresAt=null;this.broadcast();
  // Existing CDP work cannot be undone. Fence it, reject queued stale inputs,
  // clear held keys/buttons/composition, then let managed Agent work resume.
  await this.fence(()=>this.cleanup());
  if(this.version===version&&!this.closed){this.mode='agent';this.broadcast();}
  return {reason};
 }
 agent(event){
  if(this.mode!=='agent')reject('AGENT_PAUSED');validateInput(event,this.source.viewport);
  const epoch=this.source.pageEpoch,viewport=this.source.viewportVersion;
  return this.enqueue(async()=>{if(this.source.pageEpoch!==epoch||this.source.viewportVersion!==viewport)reject('STALE_AGENT_PAGE');await this.dispatch(event);});
 }
 async handle(peer,message){
  try{
   if(message.type==='AcquireControl'){const grant=await this.acquire(peer.id,message);peer.send({type:'ControlGranted',...grant});}
   else if(message.type==='RenewControl'){peer.send({type:'ControlGranted',...this.renew(peer.id,message)});}
   else if(message.type==='ReleaseControl'){this.validLease(peer.id,message);await this.revoke('released');}
   else if(message.type==='Input'){peer.send(await this.input(peer.id,message));}
   else reject('UNKNOWN_CONTROL_MESSAGE');
  }catch(error){
   if(!peer.closed)peer.send(message.type==='Input'?{type:'InputAck',seq:message.seq,accepted:false,code:error.code??'CDP_ERROR',lastProcessedInputSeq:this.source.inputSeq}:{type:'ControlDenied',code:error.code??'CDP_ERROR'});
  }
 }
 async close(){
  this.source.off('invalidate',this.onInvalidate);clearTimeout(this.expiryTimer);
  const closing=this.revoke('closed');this.closed=true;await closing;await this.tail;await this.cdp.detach?.();this.peers.clear();
 }
}
export async function createControl(source){const cdp=await source.page.context().newCDPSession(source.page);return new ControlLease(source,cdp);}
