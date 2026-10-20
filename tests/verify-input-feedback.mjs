import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {readPublicEditor} from '../live/feedback.mjs';

// All strings here are generated fixtures. Receipts store counts and stages,
// never form values or complete control packets.
const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;background:white}input,textarea,button,[contenteditable]{display:block;margin:6px;width:260px;padding:8px;font:16px system-ui}#masked{-webkit-text-security:disc}#offset{transform:rotate(5deg)}#button{cursor:url("/fixture-cursor.png"),pointer;margin-left:-80px}</style>
<input id="public" data-remote-paint-preview="plain-text" value="PUBLIC">
<input id="password" type="password" data-remote-paint-preview="plain-text" value="password-fixture">
<input id="otp" autocomplete="one-time-code" data-remote-paint-preview="plain-text" value="otp-fixture">
<input id="card" autocomplete="cc-number" data-remote-paint-preview="plain-text" value="card-fixture">
<input id="masked" data-remote-paint-preview="plain-text" value="masked-fixture">
<input id="private" data-remote-paint-sensitive data-remote-paint-preview="plain-text" value="private-fixture">
<input id="ordinary" value="ordinary-fixture"><input id="offset" data-remote-paint-preview="plain-text" value="offset-fixture">
<div id="rich" contenteditable data-remote-paint-preview="plain-text"><b>rich-fixture</b></div>
<button id="button">Hover target</button><textarea id="multiline" data-remote-paint-preview="plain-text">first\nsecond</textarea>
<script>document.querySelector('#public').addEventListener('input',e=>{const el=e.target,at=el.selectionStart;el.value=el.value.toUpperCase();el.setSelectionRange(at,at);});</script>`;
const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let live,browser;const report={at:new Date().toISOString(),dataPlane:process.env.REMOTE_PAINT_DATA_PLANE==='node'?'node':'native',scope:'Real custom Chromium native capture → Gateway → CanvasKit Viewer, generated form fixtures and local input events; composition validation is synthetic, no physical OS IME claim',variants:[]};
try{
 live=await startLive({url:`http://127.0.0.1:${server.address().port}`,port:0});browser=await launchCaptureBrowser();const source=live.source;
 for(const main of [false,true]){
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.feedbackPackets=[];window.inputAcks=[];const OriginalWorker=Worker;window.Worker=class extends OriginalWorker {constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.type==='control'){const m=data.message;if(m.type==='FeedbackState')window.feedbackPackets.push(m);if(m.type==='InputAck')window.inputAcks.push(m);}});}};const Socket=WebSocket;window.WebSocket=class extends Socket {constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(typeof data!=='string')return;const m=JSON.parse(data);if(m.type==='FeedbackState'){window.feedbackPackets.push(m);if(window.feedbackPackets.length>1000)window.feedbackPackets.shift();}if(m.type==='InputAck')window.inputAcks.push(m);});}};});
  const url=new URL(live.url);if(main)url.search='mainThread&cpu';await page.goto(url.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
  const evaluate=source.page.evaluate.bind(source.page);
  const focus=async selector=>{await evaluate(selector=>document.querySelector(selector).focus(),selector);source.control.feedbackSignature=null;source.control.scheduleFeedback();};
  const latest=()=>page.evaluate(()=>window.feedbackPackets.at(-1));
  const waitText=async text=>{await page.waitForFunction(text=>{const m=window.feedbackPackets.at(-1),v=window.remotePaintResult?.native;return m?.editor?.text===text&&(!m.native||v?.producer===m.native.producer&&v.frameToken>=m.native.frameToken);},text).catch(async error=>{console.error(JSON.stringify({feedback:await page.evaluate(()=>{const m=window.feedbackPackets.at(-1);return m?{...m,editor:m.editor?{kind:m.editor.kind,textLength:m.editor.text.length}:null}:null;}),visible:await page.evaluate(()=>window.remotePaintResult?.native),source:source.latest?.native,peerCaps:[...live.peers].map(p=>p.feedback)}));throw error;});await page.evaluate(()=>new Promise(requestAnimationFrame));};
  await focus('#public');await waitText('PUBLIC');
  // A DOM getter trap proves eligibility precedes reading sensitive values.
  const denied=['password','otp','card','masked','private','ordinary','offset'];
  await evaluate(ids=>{window.deniedValueReads=0;for(const id of ids){const el=document.getElementById(id),descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');Object.defineProperty(el,'value',{get(){window.deniedValueReads++;return descriptor.get.call(this);},set(value){descriptor.set.call(this,value);},configurable:true});}},denied);
  for(const id of [...denied,'rich']){
   await focus(`#${id}`);await page.waitForFunction(()=>window.feedbackPackets.at(-1)?.editor===null);
   const state=await evaluate(readPublicEditor,{namespace:'policy-probe',event:{kind:'text',textLength:0}});assert.equal(state,null,id);
  }
  assert.equal(await evaluate(()=>window.deniedValueReads),0);
  // Formatting changes happen remotely; the next confirmed state corrects it.
  await focus('#public');await waitText('PUBLIC');
  await evaluate(()=>{const el=document.querySelector('#public');el.setSelectionRange(el.value.length,el.value.length);});source.control.feedbackSignature=null;source.control.scheduleFeedback();await page.waitForTimeout(150);
  const pending=await page.locator('#inputProxy').evaluate(proxy=>{proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));return {text:document.querySelector('#optimisticOverlay').textContent,debug:window.remotePaintOptimistic};});
  assert.equal(pending.text,'PUBLIC•');assert.equal(pending.debug.stage,'pending');await source.page.waitForFunction(()=>document.querySelector('#public').value==='PUBLICX');await waitText('PUBLICX');
  // A source-script focus race cannot put freshly typed secrets into the old
  // public overlay. Hold only optional feedback; input ACK must still arrive.
  let releaseRead,readStarted;const started=new Promise(r=>readStarted=r);source.page.evaluate=async(fn,args)=>{if(fn===readPublicEditor)await new Promise(r=>{releaseRead=r;readStarted();});return evaluate(fn,args);};
  source.control.feedbackSignature=null;source.control.scheduleFeedback();await started;
  await evaluate(()=>{const el=document.querySelector('#password');el.value='';el.focus();});
  const before=source.inputSeq,secret='S3cret-fixture';const masked=await page.locator('#inputProxy').evaluate((proxy,secret)=>{proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:secret,bubbles:true,cancelable:true}));return {text:document.querySelector('#optimisticOverlay').textContent,debug:window.remotePaintOptimistic};},secret);
  assert.ok(masked.text.includes('•'.repeat(secret.length)));assert.ok(!masked.text.includes(secret));
  await page.waitForFunction(seq=>window.inputAcks.some(m=>m.seq>seq&&m.accepted),before,{timeout:3000});
  assert.equal(await evaluate(()=>Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get.call(document.querySelector('#password'))),secret);
  source.page.evaluate=evaluate;releaseRead();await page.waitForFunction(()=>window.feedbackPackets.at(-1)?.editor===null);
  const exposed=await page.evaluate(()=>JSON.stringify({feedback:window.feedbackPackets,acks:window.inputAcks,debug:window.remotePaintOptimistic,overlay:document.querySelector('#optimisticOverlay').textContent}));
  for(const value of [secret,...denied.map(id=>`${id}-fixture`),'rich-fixture'])assert.ok(!exposed.includes(value),`Fixture leaked to feedback: ${value}`);
  // Composition update/cancel/commit remains local and masked until the
  // source confirms the opted-in editor, including a non-collapsed selection.
  await evaluate(()=>{const el=document.querySelector('#public');el.value='PUBLIC';el.focus();el.setSelectionRange(1,3);});source.control.feedbackSignature=null;source.control.scheduleFeedback();await waitText('PUBLIC');await page.waitForTimeout(150);
  const compose=async(phase,data)=>page.locator('#inputProxy').evaluate((proxy,{phase,data})=>{proxy.dispatchEvent(new CompositionEvent(phase,{data,bubbles:true}));return {text:document.querySelector('#optimisticOverlay').textContent,debug:window.remotePaintOptimistic};},{phase,data});
  await compose('compositionstart','');const composed=await compose('compositionupdate','中文');assert.equal(composed.text,'P••LIC');assert.equal(composed.debug.stage,'pending');
  const canceled=await compose('compositionend','');assert.equal(canceled.text,'PUBLIC');await source.page.waitForFunction(()=>document.querySelector('#public').value==='PLIC');await waitText('PLIC');
  await page.waitForFunction(()=>window.inputAcks.at(-1)?.accepted===true);await page.waitForTimeout(200);
  await evaluate(()=>{const el=document.querySelector('#public');el.value='PUBLIC';el.setSelectionRange(el.value.length,el.value.length);});source.control.feedbackSignature=null;source.control.scheduleFeedback();await waitText('PUBLIC');await page.waitForTimeout(150);
  await compose('compositionstart','');await compose('compositionupdate','输入');await compose('compositionend','输入');await source.page.waitForFunction(()=>document.querySelector('#public').value==='PUBLIC输入');await waitText('PUBLIC输入');
  // A source editor already scrolled horizontally must keep the local
  // caret visible rather than drawing the beginning of its long text.
  const longText='A'.repeat(400);await evaluate(text=>{const el=document.querySelector('#public');el.value=text;el.focus();el.setSelectionRange(text.length,text.length);el.scrollLeft=el.scrollWidth;},longText);source.control.feedbackSignature=null;source.control.scheduleFeedback();await waitText(longText);await page.waitForTimeout(150);
  const scrolled=await page.locator('#inputProxy').evaluate(proxy=>{proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));const el=document.querySelector('#optimisticOverlay .optimistic-input'),caret=el?.querySelector('.optimistic-caret');return {editor:el?.getBoundingClientRect().toJSON(),caret:caret?.getBoundingClientRect().toJSON(),scrollLeft:el?.scrollLeft};});assert.ok(scrolled.editor&&scrolled.caret);assert.ok(scrolled.caret.x>=scrolled.editor.x-1&&scrolled.caret.right<=scrolled.editor.right+1,JSON.stringify(scrolled));await waitText(longText+'X');
  // Tab is a real focus-changing key. Its old public baseline is invalidated
  // synchronously before the remote password receives subsequent text.
  const tab=await page.locator('#inputProxy').evaluate(proxy=>{proxy.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',keyCode:9,bubbles:true,cancelable:true}));return document.querySelector('#optimisticOverlay').textContent;});assert.equal(tab,'');await source.page.waitForFunction(()=>document.activeElement.id==='password');await page.waitForFunction(()=>window.feedbackPackets.at(-1)?.editor===null);
  // Cursor/hover contains geometry and a built-in cursor only.
  const box=await source.page.locator('#button').boundingBox(),canvas=await page.locator('#viewport').boundingBox();await page.mouse.move(canvas.x+(Math.max(0,box.x)+20)*canvas.width/960,canvas.y+(box.y+10)*canvas.height/640);
  await page.waitForFunction(()=>window.remotePaintPointer?.cursor==='pointer'&&document.querySelector('#pointerOverlay .remote-hover'));
  const hover=await page.locator('#pointerOverlay .remote-hover').evaluate(el=>({left:parseFloat(el.style.left),width:parseFloat(el.style.width),cursor:document.querySelector('#viewport').style.cursor}));assert.ok(hover.left>=0&&hover.width>0&&hover.width<=canvas.width);assert.equal(hover.cursor,'pointer');
  await page.locator('#viewport').dispatchEvent('pointerleave');assert.equal(await page.evaluate(()=>window.remotePaintPointer),null);
  const packets=await page.evaluate(()=>({feedback:window.feedbackPackets.length,acks:window.inputAcks.length,ackBodies:window.inputAcks.some(m=>'optimistic'in m||'pointer'in m)}));assert.equal(packets.ackBodies,false);assert.deepEqual(errors,[]);
  await page.locator('#viewport').dispatchEvent('pointercancel');await page.waitForFunction(()=>!document.querySelector('#pointerOverlay').children.length&&document.querySelector('#controlState').textContent==='Agent 控制');
  report.variants.push({worker:!main,privacyCases:denied.length+1,sensitiveGetterReads:await evaluate(()=>window.deniedValueReads),sourceCorrection:true,focusRaceMasked:true,ackWhileFeedbackBlocked:true,compositionMasked:true,compositionCancelPreviewCorrected:true,remoteSelectionRestoration:false,compositionCommit:true,tabInvalidation:true,scrolledCaretVisible:true,pointerCleanup:true,...packets});
  await page.close();await evaluate(()=>{for(const id of ['password','otp','card','masked','private','ordinary','offset'])delete document.getElementById(id).value;const el=document.querySelector('#public');el.value='PUBLIC';el.focus();});
 }
 report.sourceErrors=source.stats.errors;assert.equal(report.sourceErrors,0);report.status='passed';await mkdir('artifacts/input',{recursive:true});await writeFile('artifacts/input/feedback.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await live?.close();await new Promise(r=>server.close(r));}
