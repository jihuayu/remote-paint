// Local textarea captures text/IME only. The remote page remains the editor.
export function predictOptimistic(state,event){
 if(!state||state.preview!=='plain-text'||typeof state.editorId!=='string'||state.sensitive||!['input','textarea','contenteditable'].includes(state.kind)||typeof state.text!=='string')return null;
 if(event.kind==='key'&&((event.modifiers??0)&7||event.modifiers===8&&event.text===undefined))return null;
 const text=state.text,start=Math.max(0,Math.min(text.length,Number.isInteger(state.selectionStart)?state.selectionStart:text.length));
 const end=Math.max(start,Math.min(text.length,Number.isInteger(state.selectionEnd)?state.selectionEnd:start));
 let next=text,nextStart=start,nextEnd=start,composition=state.composition;
 const boundaries=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].map(v=>v.index).concat(text.length):[...text].reduce((a,c)=>a.concat(a.at(-1)+c.length),[0]);
 const before=position=>boundaries.filter(n=>n<position).at(-1)??0,after=position=>boundaries.find(n=>n>position)??text.length;
 const replace=(value,left=start,right=end)=>{next=text.slice(0,left)+value+text.slice(right);nextStart=nextEnd=left+value.length;};
 const masked=value=>(state.kind==='input'?value.replace(/[\r\n\t]/g,''):value.replace(/\r\n?/g,'\n')).replace(/[^\n\t]/g,'•');
 if(event.kind==='text'||event.kind==='key'&&event.type==='keyDown'&&event.text!==undefined){replace(masked(event.text),composition?.start??start,composition?.end??end);composition=null;}
 else if(event.kind==='key'&&event.type==='keyDown'){
  if(event.key==='Backspace'){if(start!==end)replace('');else if(start>0)replace('',before(start),end);}
  else if(event.key==='Delete'){if(start!==end)replace('');else if(end<text.length)replace('',start,after(end));}
  else if(event.key==='ArrowLeft'){nextStart=nextEnd=start!==end?start:before(start);}
  else if(event.key==='ArrowRight'){nextStart=nextEnd=start!==end?end:after(end);}
  else if(event.key==='Home'){nextStart=nextEnd=start===0?0:text.lastIndexOf('\n',start-1)+1;}
  else if(event.key==='End'){const newline=text.indexOf('\n',end);nextStart=nextEnd=newline<0?text.length:newline;}
  else return null;
 }else if(event.kind==='composition'){
  if(event.phase==='start')composition={start,end,baseText:text,baseStart:start,baseEnd:end};
  else if(['update','commit'].includes(event.phase)){const left=composition?.start??start,right=composition?.end??end;replace(masked(event.text),left,right);composition=event.phase==='commit'?null:{...composition,start:left,end:nextEnd};}
  else if(event.phase==='cancel'){if(composition?.baseText===undefined)return null;next=composition.baseText;nextStart=composition.baseStart;nextEnd=composition.baseEnd;composition=null;}
  else return null;
 }
 else return null;
 if(next.length>8192)return null;
 return {...state,text:next,selectionStart:nextStart,selectionEnd:nextEnd,composition,tentative:true,style:{...state.style}};
}
const changesEditor=event=>event.kind==='wheel'||event.kind==='mouse'&&event.type!=='mouseMoved'||event.kind==='key'&&event.type!=='keyUp'&&(((event.modifiers??0)&7)!==0||['Tab','Escape','Enter','PageUp','PageDown'].includes(event.key));
const displayStamp=frame=>({pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,viewport:{cssWidth:frame.viewport.cssWidth,cssHeight:frame.viewport.cssHeight,deviceScaleFactor:frame.viewport.deviceScaleFactor},frameId:frame.frameId,baseFrameId:frame.baseFrameId,lastProcessedInputSeq:frame.lastProcessedInputSeq,
 native:frame.native?{producer:typeof frame.native.producer==='string'&&frame.native.producer.length<=128?frame.native.producer:undefined,namespace:Array.isArray(frame.native.namespace)&&frame.native.namespace.length===2&&frame.native.namespace.every(n=>Number.isSafeInteger(n)&&n>=0)?frame.native.namespace.slice():null,frameToken:Number.isSafeInteger(frame.native.frameToken)?frame.native.frameToken:undefined}:null});
const pointerCursors=new Set(['default','pointer','text','vertical-text','crosshair','move','wait','progress','help','not-allowed','no-drop','grab','grabbing','copy','alias','cell','context-menu','all-scroll','col-resize','row-resize','n-resize','s-resize','e-resize','w-resize','ne-resize','nw-resize','se-resize','sw-resize','ew-resize','ns-resize','nesw-resize','nwse-resize','zoom-in','zoom-out']);
export class ViewerInput {
 constructor({canvas,proxy,button,label,feedbackLabel,overlay,pointerOverlay,send,onControl,inputWindow=16,ackTimeout=5000}){
  this.inputWindow=Math.max(1,Math.min(32,inputWindow|0));this.ackTimeout=ackTimeout;
  Object.assign(this,{canvas,proxy,button,label,feedbackLabel,overlay,pointerOverlay,send,onControl});this.queue=[];this.active=false;this.frame=null;this.composing=false;
  this.overlaySeq=0;this.lastFrameInputSeq=0;
  button.onclick=()=>{if(this.active)this.releaseControl();else this.requestControl();};
  const modifiers=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
  const point=e=>{const r=this.canvas.getBoundingClientRect(),v=this.frame.viewport;return {x:Math.min(v.cssWidth-0.001,Math.max(0,(e.clientX-r.left)*v.cssWidth/r.width)),y:Math.min(v.cssHeight-0.001,Math.max(0,(e.clientY-r.top)*v.cssHeight/r.height))};};
  this.bindCanvas=target=>{this.canvas=target;
  for(const [name,type] of [['pointerdown','mousePressed'],['pointermove','mouseMoved'],['pointerup','mouseReleased']])target.addEventListener(name,e=>{
   if(target!==this.canvas||!this.active)return;e.preventDefault();if(name==='pointerdown'){target.setPointerCapture(e.pointerId);proxy.focus({preventScroll:true});}
   this.push({kind:'mouse',type,...point(e),button:name==='pointermove'?'none':['left','middle','right'][e.button]??'none',buttons:e.buttons,clickCount:name==='pointermove'?0:Math.min(2,e.detail||1),modifiers:modifiers(e)});
  });
  target.addEventListener('contextmenu',e=>e.preventDefault());
  target.addEventListener('pointerleave',()=>{if(target===this.canvas)this.clearPointer();});
  target.addEventListener('pointercancel',()=>{if(target===this.canvas&&this.active)this.stopInput('指针操作已取消，已交还控制');});
  target.addEventListener('wheel',e=>{if(target!==this.canvas||!this.active)return;e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?this.frame.viewport.cssHeight:1;this.push({kind:'wheel',...point(e),deltaX:Math.max(-10000,Math.min(10000,e.deltaX*unit)),deltaY:Math.max(-10000,Math.min(10000,e.deltaY*unit)),modifiers:modifiers(e)});},{passive:false});
  };this.bindCanvas(canvas);
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
 notifyControl(reason){try{this.onControl?.(reason);}catch{}}
 requestControl(){if(!this.enabled||!this.frame||this.active)return false;this.button.disabled=true;this.send({type:'AcquireControl',...this.tags()});return true;}
 releaseControl(){if(!this.active)return false;this.send({type:'ReleaseControl',...this.tags()});this.reset();return true;}
 tags(){return {sessionId:this.sessionId,pageEpoch:this.frame?.pageEpoch,viewportVersion:this.frame?.viewportVersion,lease:this.lease};}
 welcome(message){this.reset();this.frame=null;this.mode=undefined;this.controlHolder=null;this.controlExpiresAt=null;this.controlPageEpoch=null;this.controlViewportVersion=null;this.enabled=message.input;this.feedbackEnabled=message.inputFeedback===true;this.sessionId=message.sessionId;this.peerId=message.peerId;this.button.hidden=!this.enabled;this.notifyControl('welcome');}
 display(frame){if(this.active&&(frame.pageEpoch!==this.frame?.pageEpoch||frame.viewportVersion!==this.frame?.viewportVersion))this.reset();this.frame=displayStamp(frame);this.lastFrameInputSeq=Math.max(this.lastFrameInputSeq,frame.lastProcessedInputSeq??0);if(this.lastFrameInputSeq>this.editorConfirmedSeq&&(!this.optimisticState?.tentative||this.lastFrameInputSeq>this.editorPredictedSeq))this.invalidateEditor();else if(this.overlaySeq&&this.lastFrameInputSeq>=this.overlaySeq)this.clearOptimistic();if(this.feedbackSeq&&this.lastFrameInputSeq>=this.feedbackSeq)this.clearFeedbackLabel();this.flushFeedback();this.button.disabled=!this.enabled||(this.mode&&this.mode!=='agent'&&!this.active);this.notifyControl('frame');}
 reset(){clearTimeout(this.ackTimer);clearInterval(this.renewTimer);this.active=false;this.lease=null;this.nextSeq=undefined;this.pending=new Map();this.queue=[];this.eventContexts=new WeakMap();this.editorContext=0;this.contextBarrierSeq=0;this.editorConfirmedSeq=0;this.pendingFeedback=null;this.feedbackEpoch=null;this.lastFeedbackRevision=0;this.composing=false;this.proxy.value='';this.proxy.blur();this.invalidateEditor();this.clearPointer();this.clearFeedbackLabel();this.lastFrameInputSeq=0;this.button.textContent='接管操作';this.button.disabled=true;this.label.textContent='只读';this.notifyControl('reset');}
 clearFeedbackLabel(){this.feedbackSeq=0;if(this.feedbackLabel)this.feedbackLabel.textContent='';window.remotePaintInputStage=null;}
 showFeedbackLabel(seq,stage,preview=false){if(seq<=this.lastFrameInputSeq||seq<(this.feedbackSeq??0))return;this.feedbackSeq=seq;if(this.feedbackLabel)this.feedbackLabel.textContent=stage==='pending'?(preview?'本地预览 · 输入待确认':'输入待确认'):'输入已注入 · 等待画面';window.remotePaintInputStage={seq,stage};}
 clearOptimistic(){this.overlaySeq=0;if(this.overlay)this.overlay.replaceChildren();window.remotePaintOptimistic=null;}
 invalidateEditor(){this.clearOptimistic();this.optimisticState=null;this.editorPredictedSeq=0;}
 acceptEditor(seq,editor){
  if(!editor||editor.preview!=='plain-text'||typeof editor.editorId!=='string'||editor.editorId.length>128||editor.sensitive){this.invalidateEditor();return;}
  const prior=this.optimisticState,state={...editor,tentative:false};
  if(state.composition&&prior?.editorId===state.editorId&&prior.composition?.baseText!==undefined)state.composition={...prior.composition,...state.composition};
  this.invalidateEditor();this.showOptimistic(seq,state,'ack');if(!this.optimisticState)return;this.editorConfirmedSeq=seq;
  if(seq<=this.lastFrameInputSeq)this.clearOptimistic();
  for(const [pendingSeq,{message,context}] of this.pending){
   if(context!==this.editorContext||pendingSeq<=Math.max(seq,this.lastFrameInputSeq))continue;
   const predicted=predictOptimistic(this.optimisticState,message.event);
   if(predicted)this.showOptimistic(pendingSeq,predicted,'local');else if(message.event.kind!=='key'||message.event.type!=='keyUp')this.invalidateEditor();
  }
 }
 flushFeedback(){
  const message=this.pendingFeedback;if(!message||!this.active)return;
  if(message.afterInputSeq<this.contextBarrierSeq||message.afterInputSeq<this.lastFrameInputSeq){this.pendingFeedback=null;return;}
  if(message.native){const visible=this.frame?.native,minimum=message.native;if(!visible||visible.producer!==minimum.producer||JSON.stringify(visible.namespace)!==JSON.stringify(minimum.namespace)||visible.frameToken<minimum.frameToken)return;}
  this.pendingFeedback=null;this.acceptEditor(message.afterInputSeq,message.editor);if(message.pointer)this.showPointer(message.pointer);
 }
 clearPointer(){this.pointerPosition=null;if(this.canvas.style)this.canvas.style.cursor='default';this.pointerOverlay?.replaceChildren();window.remotePaintPointer=null;}
 showPointer(state){
  if(!this.feedbackEnabled||!this.active||!state||!pointerCursors.has(state.cursor)||!this.pointerPosition||state.x!==this.pointerPosition.x||state.y!==this.pointerPosition.y)return;
  if(this.canvas.style)this.canvas.style.cursor=state.cursor;this.pointerOverlay?.replaceChildren();
  const r=state.hover,v=this.frame?.viewport;if(r&&this.pointerOverlay&&v&&['x','y','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0){
   const x=Math.max(0,r.x),y=Math.max(0,r.y),right=Math.min(v.cssWidth,r.x+r.width),bottom=Math.min(v.cssHeight,r.y+r.height),bounds=this.canvas.getBoundingClientRect();
   if(right>x&&bottom>y){const box=document.createElement('div');box.className='remote-hover';Object.assign(box.style,{left:`${x*bounds.width/v.cssWidth}px`,top:`${y*bounds.height/v.cssHeight}px`,width:`${(right-x)*bounds.width/v.cssWidth}px`,height:`${(bottom-y)*bounds.height/v.cssHeight}px`});this.pointerOverlay.append(box);}
  }
  window.remotePaintPointer={cursor:state.cursor,x:state.x,y:state.y,stage:'input-injected'};
 }
  showOptimistic(seq,state,source='ack'){
  if(!this.feedbackEnabled||!this.frame||!state||state.preview!=='plain-text'||typeof state.editorId!=='string'||state.sensitive||!['input','textarea','contenteditable'].includes(state.kind))return;
  const values=['x','y','width','height'].map(key=>state[key]);if(!values.every(Number.isFinite)||values.some(value=>value<0)||state.width<=0||state.height<=0||typeof state.text!=='string'||state.text.length>8192)return;
  const safeStyle=Object.fromEntries(Object.entries(state.style??{}).filter(([key,value])=>typeof value==='string'&&value.length<=256&&!/[;{}<>]|url\s*\(|expression\s*\(/i.test(value)));
  this.optimisticState={...state,style:{...state.style}};if(source==='local')this.editorPredictedSeq=seq;if(!this.overlay)return;
  const bounds=this.canvas.getBoundingClientRect(),scaleX=bounds.width/this.frame.viewport.cssWidth,scaleY=bounds.height/this.frame.viewport.cssHeight;
  const element=document.createElement('div');element.className='optimistic-input';element.dataset.pending=String(source==='local');
  Object.assign(element.style,{left:`${state.x*scaleX}px`,top:`${state.y*scaleY}px`,width:`${state.width*scaleX}px`,height:`${state.height*scaleY}px`,
   fontFamily:safeStyle.fontFamily??'system-ui',fontSize:`${(parseFloat(safeStyle.fontSize)||16)*scaleY}px`,fontWeight:safeStyle.fontWeight??'400',
   lineHeight:safeStyle.lineHeight??'normal',letterSpacing:safeStyle.letterSpacing??'normal',color:safeStyle.color??'#000',
   backgroundColor:safeStyle.backgroundColor??'transparent',border:safeStyle.border??'0',borderRadius:safeStyle.borderRadius??'0',
   padding:safeStyle.padding??'0',textAlign:safeStyle.textAlign??'left',whiteSpace:state.kind==='input'?'pre':['pre','pre-wrap','break-spaces'].includes(safeStyle.whiteSpace)?safeStyle.whiteSpace:'pre-wrap',
   overflowWrap:['normal','break-word','anywhere'].includes(safeStyle.overflowWrap)?safeStyle.overflowWrap:'break-word',wordBreak:['normal','break-all','keep-all'].includes(safeStyle.wordBreak)?safeStyle.wordBreak:'normal',direction:safeStyle.direction==='rtl'?'rtl':'ltr'});
  const start=Math.max(0,Math.min(state.text.length,Number.isInteger(state.selectionStart)?state.selectionStart:state.text.length));
  const end=Math.max(start,Math.min(state.text.length,Number.isInteger(state.selectionEnd)?state.selectionEnd:start));
  const before=document.createElement('span'),selected=document.createElement('span'),after=document.createElement('span'),caret=document.createElement('span');
  before.textContent=state.text.slice(0,start);selected.textContent=state.text.slice(start,end);after.textContent=state.text.slice(end);caret.className='optimistic-caret';
  if(start!==end)selected.className='optimistic-selection';element.append(before,caret,selected,after);this.overlay.replaceChildren(element);this.overlaySeq=seq;
  element.scrollLeft=Number.isFinite(state.scrollLeft)?Math.max(-1e7,Math.min(1e7,state.scrollLeft))*scaleX:0;element.scrollTop=Number.isFinite(state.scrollTop)?Math.max(0,Math.min(1e7,state.scrollTop))*scaleY:0;
  // Keep the locally predicted caret inside this clipped preview. Source
  // text/selection/scroll positions replace these estimates on correction.
  if(source==='local'){
   const box=element.getBoundingClientRect(),cursor=caret.getBoundingClientRect();
   if(cursor.right>box.right-3)element.scrollLeft+=cursor.right-box.right+3;else if(cursor.left<box.left+3)element.scrollLeft-=box.left+3-cursor.left;
   if(cursor.bottom>box.bottom-3)element.scrollTop+=cursor.bottom-box.bottom+3;else if(cursor.top<box.top+3)element.scrollTop-=box.top+3-cursor.top;
   this.optimisticState.scrollLeft=element.scrollLeft/scaleX;this.optimisticState.scrollTop=element.scrollTop/scaleY;
  }
  window.remotePaintOptimistic={seq,shownAt:performance.now(),source,masked:source==='local',stage:source==='local'?'pending':'input-injected'};
  this.showFeedbackLabel(seq,source==='local'?'pending':'input-injected',source==='local');
 }
 message(message){
  if(message.type==='ControlState'){
   this.mode=message.mode;this.controlHolder=message.holder;this.controlExpiresAt=message.expiresAt;this.controlPageEpoch=message.pageEpoch;this.controlViewportVersion=message.viewportVersion;if(message.mode!=='human'||message.holder!==this.peerId){this.reset();this.button.disabled=!this.enabled||!this.frame||message.mode!=='agent';}
   if(message.mode==='human'&&message.holder===this.peerId&&!this.active)this.button.disabled=true;
   this.label.textContent=message.mode==='handoff'?'正在交接':message.mode==='agent'?'Agent 控制':message.holder===this.peerId?(this.active?'你正在操作':'正在接管'):'其他 Viewer 控制';this.notifyControl('state');return true;
  }
  if(message.type==='ControlGranted'){
   if(message.pageEpoch!==this.frame?.pageEpoch||message.viewportVersion!==this.frame?.viewportVersion){this.send({...message,type:'ReleaseControl'});return true;}
   this.mode='human';this.controlHolder=this.peerId;this.controlExpiresAt=message.expiresAt;this.controlPageEpoch=message.pageEpoch;this.controlViewportVersion=message.viewportVersion;this.active=true;this.lease=message.lease;this.feedbackEpoch=message.feedbackEpoch;this.nextSeq=Math.max(this.nextSeq??0,message.nextSeq);this.button.disabled=false;this.button.textContent='交还 Agent';this.label.textContent='你正在操作';
   clearInterval(this.renewTimer);this.renewTimer=setInterval(()=>this.send({type:'RenewControl',...this.tags()}),10000);this.notifyControl('granted');return true;
  }
  if(message.type==='ControlDenied'){this.controlDenied=message.code;this.reset();this.label.textContent=`操作被拒绝：${message.code}`;this.button.disabled=!this.enabled||!this.frame;this.notifyControl('denied');return true;}
  if(message.type==='FeedbackState'){
   if(!this.active||!this.feedbackEnabled||message.sessionId!==this.sessionId||message.feedbackEpoch!==this.feedbackEpoch||message.pageEpoch!==this.frame?.pageEpoch||message.viewportVersion!==this.frame?.viewportVersion||!Number.isSafeInteger(message.revision)||message.revision<=this.lastFeedbackRevision||!Number.isSafeInteger(message.afterInputSeq)||message.afterInputSeq<Math.max(this.contextBarrierSeq,this.lastFrameInputSeq)||message.afterInputSeq>=this.nextSeq)return true;
   if(message.native&&(!Number.isSafeInteger(message.native.frameToken)||message.native.frameToken<0||typeof message.native.producer!=='string'||!Array.isArray(message.native.namespace)||message.native.namespace.length!==2))return true;
   this.lastFeedbackRevision=message.revision;this.pendingFeedback=message;if(!message.editor)this.invalidateEditor();this.flushFeedback();return true;
  }
  if(message.type==='InputAck'){
   if(!this.pending.has(message.seq))return true;
   const oldest=this.pending.keys().next().value;
   if(message.seq!==oldest){this.stopInput('输入确认顺序错误，已交还控制');return true;}
   const acknowledged=this.pending.get(message.seq);this.pending.delete(message.seq);
   if(!message.accepted){this.stopInput(`输入已停止：${message.code}`);return true;}
   this.showFeedbackLabel(message.seq,'input-injected');
   if(message.pointer)this.showPointer(message.pointer);
   if(this.feedbackEnabled&&Object.hasOwn(message,'optimistic')&&acknowledged.context===this.editorContext&&message.seq>=this.lastFrameInputSeq){
    this.acceptEditor(message.seq,message.optimistic);
   }
   this.pump();return true;
  }
  return false;
 }
 push(event){
  if(!this.active)return;event={...event};if(changesEditor(event)){this.editorContext++;this.contextBarrierSeq=Infinity;this.pendingFeedback=null;this.invalidateEditor();this.clearPointer();}this.eventContexts.set(event,this.editorContext);if(event.kind==='mouse')this.pointerPosition={x:event.x,y:event.y};const previous=this.queue.at(-1);
  if(previous&&event.kind==='mouse'&&event.type==='mouseMoved'&&previous.kind==='mouse'&&previous.type==='mouseMoved'&&previous.buttons===event.buttons&&previous.modifiers===event.modifiers)this.queue[this.queue.length-1]=event;
  else if(previous&&event.kind==='wheel'&&previous.kind==='wheel'&&previous.modifiers===event.modifiers&&previous.x===event.x&&previous.y===event.y){previous.deltaX=Math.max(-10000,Math.min(10000,previous.deltaX+event.deltaX));previous.deltaY=Math.max(-10000,Math.min(10000,previous.deltaY+event.deltaY));this.eventContexts.set(previous,this.editorContext);}
  else {if(this.queue.length>=60){this.send({type:'ReleaseControl',...this.tags()});this.reset();this.label.textContent='输入过快，已交还控制';return;}this.queue.push(event);}
  this.pump();
 }
 stopInput(reason){if(this.active)this.send({type:'ReleaseControl',...this.tags()});this.reset();this.label.textContent=reason;}
 pump(){
  while(this.active&&this.pending.size<this.inputWindow&&this.queue.length){
   const message={type:'Input',...this.tags(),seq:this.nextSeq++,event:this.queue.shift()};
   this.pending.set(message.seq,{message,sentAt:performance.now(),context:this.eventContexts.get(message.event)??this.editorContext});
   if(changesEditor(message.event)&&this.eventContexts.get(message.event)===this.editorContext)this.contextBarrierSeq=message.seq;
   this.showFeedbackLabel(message.seq,'pending');
   const predicted=predictOptimistic(this.optimisticState,message.event);if(predicted)this.showOptimistic(message.seq,predicted,'local');
   this.send(message);
  }
  clearTimeout(this.ackTimer);const oldest=this.pending.values().next().value;
  if(oldest)this.ackTimer=setTimeout(()=>this.stopInput('输入确认超时，已交还控制'),Math.max(0,this.ackTimeout-(performance.now()-oldest.sentAt)));
 }
}
