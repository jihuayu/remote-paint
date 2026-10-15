// Real browser input/CDP boundary. Drawing uses an explicitly declared fixture
// unless REMOTE_PAINT_CHROMIUM is supplied, in which case verify the full path.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';
import {fakeSource} from './live-helpers.mjs';
import {createControl} from '../live/input.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {startLive} from '../live.mjs';
const native=!!process.env.REMOTE_PAINT_CHROMIUM,viewerBrowser=await launchCaptureBrowser();
let live,source,sourceBrowser,fixture;
try{
 if(native){live=await startLive({port:0});source=live.source;}
 else {
  fixture=await startDynamicFixture();sourceBrowser=await launchCaptureBrowser();const page=await sourceBrowser.newPage({viewport:{width:960,height:640}});await page.goto(fixture.url);
  source=fakeSource();Object.assign(source,{page,pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640},inputSeq:0});source.control=await createControl(source);live=await startLiveTransport(source,{port:0});
 }
 const page=await viewerBrowser.newPage({viewport:{width:720,height:900}}),errors=[],requests=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(new URL(request.url()).origin));
 await page.goto(live.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 const click=async selector=>{
  const box=await source.page.locator(selector).boundingBox();assert.ok(box);const canvas=await page.locator('#viewport').boundingBox();
  await page.mouse.click(canvas.x+(box.x+box.width/2)*canvas.width/960,canvas.y+(box.y+box.height/2)*canvas.height/640);
 };
 await click('#name');await page.keyboard.press('Meta+A');await page.keyboard.type('English');await source.page.waitForFunction(()=>document.querySelector('#name').value==='English');
 // Drive a real local composition in the Viewer input proxy. Its DOM events
 // must cause real remote imeSetComposition + insertText, not only key events.
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await cdp.send('Input.imeSetComposition',{text:'中文输入',selectionStart:4,selectionEnd:4});await cdp.send('Input.insertText',{text:'中文输入'});
 await source.page.waitForFunction(()=>document.querySelector('#name').value==='English中文输入');
 await page.keyboard.press('Meta+A');
 // Clipboard event at the local editor boundary, using plain text only.
 await page.locator('#inputProxy').evaluate(element=>{const transfer=new DataTransfer();transfer.setData('text/plain','粘贴🌈ABC');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));});
 await source.page.waitForFunction(()=>document.querySelector('#name').value==='粘贴🌈ABC');await page.keyboard.press('Backspace');await source.page.waitForFunction(()=>document.querySelector('#name').value==='粘贴🌈AB');
 await click('#save');await source.page.waitForFunction(()=>document.querySelector('#saved').textContent==='已保存：粘贴🌈AB');
 await click('#editor');await page.keyboard.press('Meta+A');await page.keyboard.type('rich text');await source.page.waitForFunction(()=>document.querySelector('#editor').textContent==='rich text');
 const canvas=await page.locator('#viewport').boundingBox();await page.mouse.move(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await page.mouse.wheel(0,500);await source.page.waitForFunction(()=>scrollY>200);
 const header=await source.page.locator('header').boundingBox();assert.equal(header.y,0);
 await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='Agent 控制');assert.equal(source.control.mode,'agent');
 const peer=[...live.peers][0],grant=await source.control.acquire(peer.id,{sessionId:source.control.sessionId,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});
 const before=source.inputSeq;for(const bad of [{pageEpoch:0},{viewportVersion:0},{lease:'revoked'},{seq:0}])assert.throws(()=>source.control.input(peer.id,{...grant,seq:grant.nextSeq,event:{kind:'text',text:'BAD'},...bad}));assert.equal(source.inputSeq,before);
 await source.control.revoke('test');await cdp.detach();assert.ok(requests.every(origin=>origin===live.origin));assert.deepEqual(errors,[]);
 await mkdir('artifacts/input',{recursive:true});await page.screenshot({path:'artifacts/input/viewer.png'});
 const report={verifiedAt:new Date().toISOString(),nativeDrawing:native,drawingFixtureOnly:!native,sourceBrowser:source.page.context().browser().version(),viewerBrowser:viewerBrowser.version(),sourceInput:await source.page.locator('#name').inputValue(),saved:await source.page.locator('#saved').textContent(),editor:await source.page.locator('#editor').textContent(),scrollY:await source.page.evaluate(()=>scrollY),cssScaling:true,imeViaActualLocalAndRemoteCDP:true,physicalOsImeCandidateWindowTested:false,leaseAndStaleTags:true,lastProcessedInputSeq:source.inputSeq,viewerSourceRequests:0,errors};
 await writeFile('artifacts/input/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await viewerBrowser.close();await live?.close();if(!native){await source?.control?.close();await sourceBrowser?.close();await fixture?.close();}}
