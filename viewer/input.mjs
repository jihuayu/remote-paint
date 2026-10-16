// Local textarea captures text/IME only. The remote page remains the editor.
export function predictOptimistic(state,event){
 if(!state||!['input','textarea','contenteditable'].includes(state.kind))return null;
 const text=state.text,start=Math.max(0,Math.min(text.length,Number.isInteger(state.selectionStart)?state.selectionStart:text.length));
 const end=Math.max(start,Math.min(text.length,Number.isInteger(state.selectionEnd)?state.selectionEnd:start));
 let next=text,nextStart=start,nextEnd=start;
 const replace=value=>{next=text.slice(0,start)+value+text.slice(end);nextStart=nextEnd=start+value.length;};
 if(event.kind==='text'||event.kind==='key'&&event.type==='keyDown'&&event.text!==undefined)replace(event.text);
 else if(event.kind==='key'&&event.type==='keyDown'){
  if(event.key==='Backspace'){if(start!==end)replace('');else if(start>0){next=text.slice(0,start-1)+text.slice(end);nextStart=nextEnd=start-1;}}
  else if(event.key==='Delete'){if(start!==end)replace('');else if(end<text.length){next=text.slice(0,start)+text.slice(end+1);nextStart=nextEnd=start;}}
  else if(event.key==='ArrowLeft'){nextStart=nextEnd=Math.max(0,start-1);}
  else if(event.key==='ArrowRight'){nextStart=nextEnd=Math.min(text.length,end+1);}
  else if(event.key==='Home'){nextStart=nextEnd=0;}
  else if(event.key==='End'){nextStart=nextEnd=text.length;}
  else return null;
 }else if(event.kind==='composition'&&event.phase==='commit')replace(event.text);
 else return null;
 return {...state,text:next,selectionStart:nextStart,selectionEnd:nextEnd,style:{...state.style}};
}
export class ViewerInput {
 constructor({canvas,proxy,button,label,overlay,send}){
  Object.assign(this,{canvas,proxy,button,label,overlay,send});this.queue=[];this.active=false;this.frame=null;this.composing=false;
  this.overlaySeq=0;this.lastFrameInputSeq=0;
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
   e.preventDefault();const text=e.metaKey||e.ctrlKey||e.altKey?undefined:e.key==='Enter'?'\r':e.key==='Tab'?'\t':e.key.length===1?e.key:undefined;
   this.push({kind:'key',type:type==='keydown'?'keyDown':'keyUp',key:e.key,code:e.code,windowsVirtualKeyCode:e.keyCode,modifiers:modifiers(e),...(type==='keydown'&&text!==undefined?{text}:{})});
  });
  proxy.addEventListener('paste',e=>{if(!this.active)return;e.preventDefault();this.push({kind:'text',text:e.clipboardData.getData('text/plain')});proxy.value='';});
  proxy.addEventListener('compositionstart',()=>{if(!this.active)return;this.composing=true;this.push({kind:'composition',phase:'start',text:''});});
  proxy.addEventListener('compositionupdate',e=>{if(this.active)this.push({kind:'composition',phase:'update',text:e.data});});
  proxy.addEventListener('compositionend',e=>{if(!this.active)return;this.composing=false;this.push({kind:'composition',phase:e.data?'commit':'cancel',text:e.data});proxy.value='';});
  proxy.addEventListener('beforeinput',e=>{
   if(!this.active)return;if(this.composing||e.isComposing)return;e.preventDefault();
   // Composition text was handled while isComposing was true. A later
   // insertText is a distinct edit, even when it equals the last IME commit.
   if(e.inputType==='insertText'&&e.data)this.push({kind:'text',text:e.data});
  });
  proxy.addEventListener('input',()=>{if(!this.composing)proxy.value='';});
  window.addEventListener('blur',()=>{if(this.active)this.send({type:'ReleaseControl',...this.tags()});});
  this.reset();
 }
 tags(){return {sessionId:this.sessionId,pageEpoch:this.frame?.pageEpoch,viewportVersion:this.frame?.viewportVersion,lease:this.lease};}
 welcome(message){this.reset();this.frame=null;this.enabled=message.input;this.sessionId=message.sessionId;this.peerId=message.peerId;this.button.hidden=!this.enabled;}
 display(frame){if(this.active&&(frame.pageEpoch!==this.frame?.pageEpoch||frame.viewportVersion!==this.frame?.viewportVersion))this.reset();this.frame=frame;this.lastFrameInputSeq=Math.max(this.lastFrameInputSeq,frame.lastProcessedInputSeq??0);if(this.overlaySeq&&this.lastFrameInputSeq>=this.overlaySeq)this.clearOptimistic();this.button.disabled=!this.enabled||(this.mode&&this.mode!=='agent'&&!this.active);}
 reset(){clearTimeout(this.ackTimer);clearInterval(this.renewTimer);this.active=false;this.lease=null;this.pending=null;this.queue=[];this.composing=false;this.proxy.value='';this.proxy.blur();this.clearOptimistic();this.lastFrameInputSeq=0;this.button.textContent='接管操作';this.button.disabled=true;this.label.textContent='只读';}
 clearOptimistic(){this.overlaySeq=0;if(this.overlay)this.overlay.replaceChildren();window.remotePaintOptimistic=null;}
  showOptimistic(seq,state){
  if(!this.overlay||!this.frame||!state||!['input','textarea','contenteditable'].includes(state.kind))return;
  const values=['x','y','width','height'].map(key=>state[key]);if(!values.every(Number.isFinite)||values.some(value=>value<0)||state.width<=0||state.height<=0||typeof state.text!=='string'||state.text.length>8192)return;
  const safeStyle=Object.fromEntries(Object.entries(state.style??{}).filter(([key,value])=>typeof value==='string'&&value.length<=256&&!/[;{}<>]|url\s*\(|expression\s*\(/i.test(value)));
  const bounds=this.canvas.getBoundingClientRect(),scaleX=bounds.width/this.frame.viewport.cssWidth,scaleY=bounds.height/this.frame.viewport.cssHeight;
  const element=document.createElement('div');element.className='optimistic-input';
  Object.assign(element.style,{left:`${state.x*scaleX}px`,top:`${state.y*scaleY}px`,width:`${state.width*scaleX}px`,height:`${state.height*scaleY}px`,
   fontFamily:safeStyle.fontFamily??'system-ui',fontSize:`${(parseFloat(safeStyle.fontSize)||16)*scaleY}px`,fontWeight:safeStyle.fontWeight??'400',
   lineHeight:safeStyle.lineHeight??'normal',letterSpacing:safeStyle.letterSpacing??'normal',color:safeStyle.color??'#000',
   backgroundColor:safeStyle.backgroundColor??'transparent',border:safeStyle.border??'0',borderRadius:safeStyle.borderRadius??'0',
   padding:safeStyle.padding??'0',textAlign:safeStyle.textAlign??'left',whiteSpace:state.kind==='contenteditable'?'pre-wrap':'pre'});
  const start=Math.max(0,Math.min(state.text.length,Number.isInteger(state.selectionStart)?state.selectionStart:state.text.length));
  const end=Math.max(start,Math.min(state.text.length,Number.isInteger(state.selectionEnd)?state.selectionEnd:start));
  const before=document.createElement('span'),selected=document.createElement('span'),after=document.createElement('span'),caret=document.createElement('span');
  before.textContent=state.text.slice(0,start);selected.textContent=state.text.slice(start,end);after.textContent=state.text.slice(end);caret.className='optimistic-caret';
  if(start!==end)selected.className='optimistic-selection';element.append(before,caret,selected,after);this.overlay.replaceChildren(element);this.overlaySeq=seq;
  this.optimisticState={...state,style:{...state.style}};window.remotePaintOptimistic={seq,shownAt:performance.now()};
 }
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
   clearTimeout(this.ackTimer);this.pending=null;if(!message.accepted){if(this.active)this.send({type:'ReleaseControl',...this.tags()});this.reset();this.label.textContent=`输入已停止：${message.code}`;return true;}
   if(message.optimistic&&message.seq>this.lastFrameInputSeq)this.showOptimistic(message.seq,message.optimistic);
   this.pump();return true;
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
 pump(){if(!this.active||this.pending||!this.queue.length)return;const message={type:'Input',...this.tags(),seq:this.nextSeq++,event:this.queue.shift()};this.pending=message;const predicted=predictOptimistic(this.optimisticState,message.event);if(predicted)this.showOptimistic(message.seq,predicted);this.send(message);this.ackTimer=setTimeout(()=>{if(this.active)this.send({type:'ReleaseControl',...this.tags()});this.reset();this.label.textContent='输入确认超时，已交还控制';},5000);}
}
