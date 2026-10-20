import test from 'node:test';
import assert from 'node:assert/strict';
import {predictOptimistic} from '../viewer/input.mjs';
import {estimateJsMetadata} from '../protocol/client-memory.mjs';

const state={preview:'plain-text',editorId:'editor',kind:'input',x:0,y:0,width:200,height:40,text:'abcd',selectionStart:2,selectionEnd:2,style:{fontSize:'16px'}};
test('predicts printable insertion and preserves editor metadata',()=>{
 const next=predictOptimistic(state,{kind:'key',type:'keyDown',key:'X',text:'X'});
 assert.deepEqual(next,{...state,text:'ab•cd',selectionStart:3,selectionEnd:3,composition:null,tentative:true,style:{fontSize:'16px'}});
});
test('predicts deletion and selection movement without mutating the committed state',()=>{
 const next=predictOptimistic({...state,selectionStart:1,selectionEnd:3},{kind:'key',type:'keyDown',key:'Backspace'});
 assert.equal(next.text,'ad');assert.equal(next.selectionStart,1);assert.equal(next.selectionEnd,1);assert.equal(state.text,'abcd');
 assert.equal(predictOptimistic(state,{kind:'key',type:'keyDown',key:'PageDown'}),null);
});

import {ViewerInput} from '../viewer/input.mjs';
function inputHarness(options={}){
 const prior=globalThis.window;globalThis.window={addEventListener(){}};
 const element=()=>({addEventListener(){},blur(){},value:'',textContent:'',disabled:false});
 const sent=[],canvas=element(),proxy=element(),button=element(),label=element();
 const input=new ViewerInput({canvas,proxy,button,label,send:message=>sent.push(message),...options});
 input.welcome({input:true,inputFeedback:true,sessionId:'s',peerId:'p'});input.display({pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640},lastProcessedInputSeq:0});
 input.message({type:'ControlGranted',lease:'l',feedbackEpoch:1,nextSeq:1,pageEpoch:1,viewportVersion:1});
 return {input,sent,label,close(){input.reset();globalThis.window=prior;}};
}
const key=type=>({kind:'key',type,key:'a',code:'KeyA',text:type==='keyDown'?'a':undefined});
test('own-holder control state waits for the actual lease grant before advertising input readiness',()=>{
 const h=inputHarness();try{
  h.input.reset();h.input.message({type:'ControlState',mode:'human',holder:'p',pageEpoch:1,viewportVersion:1});
  assert.equal(h.input.active,false);assert.equal(h.label.textContent,'正在接管');assert.equal(h.input.button.disabled,true);
  h.input.push({kind:'text',text:'x'});assert.equal(h.sent.length,0);
  h.input.message({type:'ControlGranted',lease:'l',feedbackEpoch:1,nextSeq:1,pageEpoch:1,viewportVersion:1});assert.equal(h.input.active,true);assert.equal(h.label.textContent,'你正在操作');assert.equal(h.input.button.disabled,false);
  h.input.push({kind:'text',text:'x'});assert.equal(h.sent.length,1);assert.equal(h.sent[0].type,'Input');assert.equal(h.sent[0].seq,1);
  h.input.message({type:'InputAck',seq:1,accepted:true});
 }finally{h.close();}
});
test('bounded input window keeps key pairs and composition ordered through delayed acknowledgements',()=>{
 const h=inputHarness({inputWindow:4});
 try{
  const events=[key('keyDown'),key('keyUp'),{kind:'composition',phase:'start',text:''},{kind:'composition',phase:'update',text:'中'},{kind:'composition',phase:'commit',text:'中'},key('keyUp')];
  events.forEach(e=>h.input.push(e));assert.equal(h.sent.length,4);assert.equal(h.input.queue.length,2);
  h.input.message({type:'InputAck',seq:1,accepted:true});assert.equal(h.sent.length,5);
  for(let seq=2;seq<=6;seq++)h.input.message({type:'InputAck',seq,accepted:true});
  assert.deepEqual(h.sent.map(m=>m.seq),[1,2,3,4,5,6]);assert.deepEqual(h.sent.map(m=>m.event),events);
  assert.equal(h.input.pending.size,0);assert.equal(h.input.queue.length,0);
 }finally{h.close();}
});
test('lease loss discards queued and inflight inputs and ignores delayed old acknowledgements',()=>{
 const h=inputHarness({inputWindow:2});
 try{
  for(let i=0;i<6;i++)h.input.push(key('keyUp'));
  h.input.message({type:'ControlState',mode:'agent'});
  h.input.message({type:'InputAck',seq:1,accepted:true});
  assert.equal(h.sent.length,2);assert.equal(h.input.pending.size,0);assert.equal(h.input.queue.length,0);assert.equal(h.input.active,false);
 }finally{h.close();}
});
test('only unsent pointer moves with matching button state are coalesced',()=>{
 const h=inputHarness({inputWindow:1});
 try{
  h.input.push(key('keyDown'));
  const move=x=>({kind:'mouse',type:'mouseMoved',x,y:10,button:'none',buttons:1,clickCount:0,modifiers:0});
  h.input.push(move(1));h.input.push(move(2));h.input.push({...move(3),type:'mouseReleased',button:'left',buttons:0});h.input.push({...move(4),buttons:0});
  assert.equal(h.input.queue.length,3);assert.equal(h.input.queue[0].x,2);assert.equal(h.input.queue[1].type,'mouseReleased');
 }finally{h.close();}
});
test('out of order acknowledgements stop dispatch and release authority',()=>{
 const h=inputHarness();try{h.input.push(key('keyDown'));h.input.push(key('keyUp'));h.input.message({type:'InputAck',seq:2,accepted:true});assert.equal(h.input.active,false);assert.equal(h.sent.at(-1).type,'ReleaseControl');}finally{h.close();}
});
test('new sessions start at the granted sequence while lease renewals preserve the inflight window',()=>{
 const h=inputHarness();try{
  h.input.push(key('keyDown'));h.input.push(key('keyUp'));
  h.input.message({type:'ControlGranted',lease:'l',nextSeq:2,pageEpoch:1,viewportVersion:1});
  h.input.push(key('keyUp'));assert.equal(h.sent.at(-1).seq,3);
  h.input.welcome({input:true,sessionId:'new-session',peerId:'new-peer'});
  h.input.display({pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640}});
  h.input.message({type:'ControlGranted',lease:'new',nextSeq:1,pageEpoch:1,viewportVersion:1});
  h.input.push(key('keyDown'));assert.equal(h.sent.at(-1).seq,1);assert.equal(h.sent.at(-1).sessionId,'new-session');
 }finally{h.close();}
});

const feedback=(extra={})=>({type:'FeedbackState',sessionId:'s',feedbackEpoch:1,revision:1,afterInputSeq:0,pageEpoch:1,viewportVersion:1,editor:state,pointer:null,...extra});
test('plain text preview is explicit and local insertions always mask newly typed content',()=>{
 assert.equal(predictOptimistic({...state,preview:undefined},{kind:'text',text:'secret'}),null);
 assert.equal(predictOptimistic({...state,sensitive:true},{kind:'text',text:'secret'}),null);
 assert.equal(predictOptimistic(state,{kind:'text',text:'private'}).text,'ab•••••••cd');
 const unicode={...state,text:'a👨‍👩‍👧‍👦b',selectionStart:12,selectionEnd:12};assert.equal(predictOptimistic(unicode,{kind:'key',type:'keyDown',key:'Backspace'}).text,'ab');
});
test('composition previews replace the same masked range and cancellation restores the original selection',()=>{
 const start=predictOptimistic({...state,selectionStart:1,selectionEnd:3},{kind:'composition',phase:'start',text:''});
 const first=predictOptimistic(start,{kind:'composition',phase:'update',text:'中文'});assert.equal(first.text,'a••d');
 const second=predictOptimistic(first,{kind:'composition',phase:'update',text:'拼音候选'});assert.equal(second.text,'a••••d');
 const cancel=predictOptimistic(second,{kind:'composition',phase:'cancel',text:''});assert.equal(cancel.text,'abcd');assert.equal(cancel.selectionStart,1);assert.equal(cancel.selectionEnd,3);
 assert.equal(predictOptimistic(second,{kind:'composition',phase:'commit',text:'词'}).text,'a•d');
});
test('queued focus changes prevent both delayed ACKs and old semantic messages from restoring an editor',()=>{
 const h=inputHarness({inputWindow:1});try{
  h.input.message(feedback());assert.equal(h.input.optimisticState.text,'abcd');h.input.push(key('keyDown'));
  h.input.push({kind:'key',type:'keyDown',key:'Tab',code:'Tab',text:'\t'});assert.equal(h.input.contextBarrierSeq,Infinity);
  h.input.message(feedback({revision:2,afterInputSeq:1}));assert.equal(h.input.optimisticState,null);
  h.input.message({type:'InputAck',seq:1,accepted:true,optimistic:state});assert.equal(h.input.optimisticState,null);assert.equal(h.input.contextBarrierSeq,2);
  h.input.message(feedback({revision:3,afterInputSeq:1}));assert.equal(h.input.optimisticState,null);
  h.input.message(feedback({revision:4,afterInputSeq:2,editor:null}));assert.equal(h.input.optimisticState,null);
 }finally{h.close();}
});
test('source feedback waits for its native frame, rejects stale revisions and respects session/lease scope',()=>{
 const h=inputHarness();try{
  const native={producer:'p',namespace:[1,2],frameToken:10};h.input.frame.native={...native,frameToken:9};
  h.input.message(feedback({native}));assert.equal(h.input.optimisticState,null);assert.ok(h.input.pendingFeedback);
  h.input.display({...h.input.frame,native});assert.equal(h.input.optimisticState.text,'abcd');
  h.input.message(feedback({revision:2,editor:{...state,text:'corrected'}}));assert.equal(h.input.optimisticState.text,'corrected');
  for(const bad of [{revision:1,editor:state},{revision:3,feedbackEpoch:0,editor:null},{revision:3,sessionId:'old',editor:null}])h.input.message(feedback(bad));
  assert.equal(h.input.optimisticState.text,'corrected');h.input.message(feedback({revision:4,editor:null}));assert.equal(h.input.optimisticState,null);
 }finally{h.close();}
});
test('a corrected source baseline rebases only later pending events and a newer visible input invalidates it',()=>{
 const h=inputHarness();try{
  h.input.message(feedback());h.input.push(key('keyDown'));h.input.push(key('keyUp'));h.input.push(key('keyDown'));
  h.input.message(feedback({revision:2,afterInputSeq:2,editor:{...state,text:'A',selectionStart:1,selectionEnd:1}}));assert.equal(h.input.optimisticState.text,'A•');
  h.input.display({...h.input.frame,lastProcessedInputSeq:3});assert.equal(h.input.optimisticState.text,'A•');h.input.display({...h.input.frame,lastProcessedInputSeq:4});assert.equal(h.input.optimisticState,null);
 }finally{h.close();}
});

test('a frame including a locally predicted composition preserves its safe cancel baseline',()=>{
 const h=inputHarness();try{h.input.message(feedback());h.input.push({kind:'composition',phase:'start',text:''});h.input.push({kind:'composition',phase:'update',text:'中'});h.input.display({...h.input.frame,lastProcessedInputSeq:2});assert.equal(h.input.optimisticState.text,'ab•cd');h.input.push({kind:'composition',phase:'cancel',text:''});assert.equal(h.input.optimisticState.text,'abcd');}finally{h.close();}
});
test('input status distinguishes pending injection from accepted input and clears on a matching frame',()=>{
 const feedbackLabel={textContent:''},h=inputHarness({feedbackLabel});try{h.input.push(key('keyDown'));assert.equal(feedbackLabel.textContent,'输入待确认');h.input.message({type:'InputAck',seq:1,accepted:true});assert.equal(feedbackLabel.textContent,'输入已注入 · 等待画面');h.input.display({...h.input.frame,lastProcessedInputSeq:1});assert.equal(feedbackLabel.textContent,'');}finally{h.close();}
});
test('coalesced unsent wheel input retains the latest focus barrier context',()=>{
 const h=inputHarness({inputWindow:1});try{h.input.push(key('keyDown'));for(let i=0;i<3;i++)h.input.push({kind:'wheel',x:10,y:10,deltaX:0,deltaY:1,modifiers:0});assert.equal(h.input.queue.length,1);h.input.message({type:'InputAck',seq:1,accepted:true});assert.equal(h.input.contextBarrierSeq,2);h.input.message(feedback({afterInputSeq:2}));assert.equal(h.input.optimisticState.text,'abcd');}finally{h.close();}
});

test('input feedback keeps a bounded display stamp instead of retaining an entire committed scene',()=>{
 const h=inputHarness();try{h.input.display({...h.input.frame,scene:{unneeded:'x'.repeat(1024*1024)},viewport:{...h.input.frame.viewport,debug:'x'.repeat(1024*1024)},native:{producer:'p',namespace:[1,2],frameToken:10,extra:'x'.repeat(1024*1024)}});assert.ok(estimateJsMetadata(h.input.frame)<2048);assert.deepEqual(h.input.tags(),{sessionId:'s',pageEpoch:1,viewportVersion:1,lease:'l'});h.input.message(feedback({native:{producer:'p',namespace:[1,2],frameToken:10}}));assert.equal(h.input.optimisticState.text,'abcd');}finally{h.close();}
});
