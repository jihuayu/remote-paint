// Local textarea captures text/IME only. The remote page remains the editor.
export class ViewerInput {
 constructor({canvas,proxy,button,label,send}){
  Object.assign(this,{canvas,proxy,button,label,send});this.queue=[];this.active=false;this.frame=null;this.composing=false;
  button.onclick=()=>{if(this.active)this.send({type:'ReleaseControl',...this.tags()});else if(this.frame)this.send({type:'AcquireControl',...this.tags()});};
  const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
  const point=e=>{const r=canvas.getBoundingClientRect(),v=this.frame.viewport;return {x:Math.min(v.cssWidth-0.001,Math.max(0,(e.clientX-r.left)*v.cssWidth/r.width)),y:Math.min(v.cssHeight-0.001,Math.max(0,(e.clientY-r.top)*v.cssHeight/r.height))};};
  for(const [name,type] of [['pointerdown','mousePressed'],['pointermove','mouseMoved'],['pointerup','mouseReleased']])canvas.addEventListener(name,e=>{
   if(!this.active)return;e.preventDefault();if(name==='pointerdown'){canvas.setPointerCapture(e.pointerId);proxy.focus({preventScroll:true});}
   this.push({kind:'mouse',type,...point(e),button:name==='pointermove'?'none':['left','middle','right'][e.button]??'none',buttons:e.buttons,clickCount:name==='pointermove'?0:Math.min(2,e.detail||1),modifiers:modifiers(e)});
  });
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{if(!this.active)return;e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?this.frame.viewport.cssHeight:1;this.push({kind:'wheel',...point(e),deltaX:Math.max(-10000,Math.min(10000,e.deltaX*unit)),deltaY:Math.max(-10000,Math.min(10000,e.deltaY*unit)),modifiers:modifiers(e)});},{passive:false});
  for(const type of ['keydown','keyup'])proxy.addEventListener(type,e=>{
   if(!this.active)return;if(e.isComposing||this.composing||e.key==='Process'||e.key==='Unidentified')return;
   // Let the local paste event deliver plain text; never expose host clipboard to CDP.
   if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='v')return;
   e.preventDefault();const printable=e.key.length===1&&!e.metaKey&&!e.ctrlKey&&!e.altKey;
   this.push({kind:'key',type:type==='keydown'?'keyDown':'keyUp',key:e.key,code:e.code,windowsVirtualKeyCode:e.keyCode,modifiers:modifiers(e),...(type==='keydown'&&printable?{text:e.key}:{})});
  });
  proxy.addEventListener('paste',e=>{if(!this.active)return;e.preventDefault();this.push({kind:'text',text:e.clipboardData.getData('text/plain')});proxy.value='';});
  proxy.addEventListener('compositionstart',()=>{if(!this.active)return;this.composing=true;this.push({kind:'composition',phase:'start',text:''});});
  proxy.addEventListener('compositionupdate',e=>{if(this.active)this.push({kind:'composition',phase:'update',text:e.data});});
  proxy.addEventListener('compositionend',e=>{if(!this.active)return;this.composing=false;this.suppressText=e.data;this.push({kind:'composition',phase:e.data?'commit':'cancel',text:e.data});proxy.value='';});
  proxy.addEventListener('beforeinput',e=>{
   if(!this.active)return;if(this.composing||e.isComposing)return;e.preventDefault();
   if(e.data&&e.data===this.suppressText){this.suppressText=null;return;}
   if(e.inputType==='insertText'&&e.data)this.push({kind:'text',text:e.data});
  });
  proxy.addEventListener('input',()=>{if(!this.composing)proxy.value='';});
  window.addEventListener('blur',()=>{if(this.active)this.send({type:'ReleaseControl',...this.tags()});});
  this.reset();
 }
 tags(){return {sessionId:this.sessionId,pageEpoch:this.frame?.pageEpoch,viewportVersion:this.frame?.viewportVersion,lease:this.lease};}
 welcome(message){this.reset();this.enabled=message.input;this.sessionId=message.sessionId;this.peerId=message.peerId;this.button.hidden=!this.enabled;}
 display(frame){if(this.active&&(frame.pageEpoch!==this.frame?.pageEpoch||frame.viewportVersion!==this.frame?.viewportVersion))this.reset();this.frame=frame;this.button.disabled=!this.enabled||(this.mode&&this.mode!=='agent'&&!this.active);}
 reset(){clearInterval(this.renewTimer);this.active=false;this.lease=null;this.pending=null;this.queue=[];this.composing=false;this.suppressText=null;this.proxy.value='';this.proxy.blur();this.button.textContent='接管操作';this.button.disabled=true;this.label.textContent='只读';}
 message(message){
  if(message.type==='ControlState'){
   this.mode=message.mode;if(message.mode!=='human'||message.holder!==this.peerId){this.reset();this.button.disabled=!this.enabled||!this.frame||message.mode!=='agent';}
   this.label.textContent=message.mode==='handoff'?'正在交接':message.mode==='agent'?'Agent 控制':message.holder===this.peerId?'你正在操作':'其他 Viewer 控制';return true;
  }
  if(message.type==='ControlGranted'){
   if(message.pageEpoch!==this.frame?.pageEpoch||message.viewportVersion!==this.frame?.viewportVersion){this.send({...message,type:'ReleaseControl'});return true;}
   this.active=true;this.lease=message.lease;if(!this.pending)this.nextSeq=message.nextSeq;this.button.disabled=false;this.button.textContent='交还 Agent';this.label.textContent='你正在操作';
   clearInterval(this.renewTimer);this.renewTimer=setInterval(()=>this.send({type:'RenewControl',...this.tags()}),10000);return true;
  }
  if(message.type==='ControlDenied'){this.reset();this.label.textContent=`操作被拒绝：${message.code}`;this.button.disabled=!this.enabled||!this.frame;return true;}
  if(message.type==='InputAck'){
   if(!this.pending||message.seq!==this.pending.seq)return true;
   this.pending=null;if(!message.accepted){this.reset();this.label.textContent=`输入已停止：${message.code}`;return true;}this.pump();return true;
  }
  return false;
 }
 push(event){
  if(!this.active)return;const previous=this.queue.at(-1);
  if(previous&&event.kind==='mouse'&&event.type==='mouseMoved'&&previous.kind==='mouse'&&previous.type==='mouseMoved')this.queue[this.queue.length-1]=event;
  else if(previous&&event.kind==='wheel'&&previous.kind==='wheel'&&previous.modifiers===event.modifiers){previous.deltaX=Math.max(-10000,Math.min(10000,previous.deltaX+event.deltaX));previous.deltaY=Math.max(-10000,Math.min(10000,previous.deltaY+event.deltaY));}
  else {if(this.queue.length>=60){this.send({type:'ReleaseControl',...this.tags()});this.reset();this.label.textContent='输入过快，已交还控制';return;}this.queue.push(event);}
  this.pump();
 }
 pump(){if(!this.active||this.pending||!this.queue.length)return;const message={type:'Input',...this.tags(),seq:this.nextSeq++,event:this.queue.shift()};this.pending=message;this.send(message);}
}
