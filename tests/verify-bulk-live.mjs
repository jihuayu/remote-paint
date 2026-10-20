import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';

assert.equal(process.platform,'linux');assert.equal(process.env.REMOTE_PAINT_NETEM,'1','Run in a disposable CAP_NET_ADMIN container');
const tc=(...args)=>execFileSync('tc',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const clear=()=>{try{tc('qdisc','del','dev','lo','root');}catch{}};
const image=new PNG({width:512,height:512});image.data=randomBytes(512*512*4);for(let i=3;i<image.data.length;i+=4)image.data[i]=255;
const png=PNG.sync.write(image),html='<style>body{margin:0;background:white}input{position:absolute;left:20px;top:20px;width:300px;height:40px}img{position:absolute;left:20px;top:100px;width:512px;height:512px}</style><input id="name"><img id="large" hidden>';
const fixture=createServer((req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',req.url==='/noise.png'?'image/png':'text/html');res.end(req.url==='/noise.png'?png:html);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let live,browser;
try{
 live=await startLive({port:0,url:`http://127.0.0.1:${fixture.address().port}`});
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,args:['--no-sandbox']});const page=await browser.newPage();
 await page.addInitScript(()=>{window.inputAcks=[];const Original=WebSocket;window.WebSocket=class extends Original{constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(typeof data==='string'){const message=JSON.parse(data);if(message.type==='InputAck')window.inputAcks.push({seq:message.seq,accepted:message.accepted,at:performance.now(),imageBytes:window.remotePaintResult?.assetStats?.imageBytes??0});}});}};});
 const requests=[];page.on('request',request=>requests.push(new URL(request.url()).origin));
 await page.goto(live.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 const bounds=await page.locator('canvas').boundingBox();await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);await live.source.page.waitForFunction(()=>document.activeElement.id==='name');
 await page.waitForFunction(()=>window.inputAcks.length>=3);
 const initialImageBytes=await page.evaluate(()=>window.remotePaintResult.assetStats.imageBytes);
 const port=new URL(live.streamOrigin).port;tc('qdisc','add','dev','lo','root','handle','1:','prio','bands','3','priomap',...Array(16).fill('0'));
 tc('qdisc','add','dev','lo','parent','1:3','handle','30:','netem','limit','1000','delay','40ms','4ms','loss','1%','rate','2mbit');
 for(const direction of ['sport','dport'])tc('filter','add','dev','lo','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol','6','0xff','match','ip',direction,port,'0xffff','flowid','1:3');
 const peer=[...live.peers][0],previous=peer.stats.maxPendingBytes??0,bulkStarted=performance.now();
 await live.source.page.locator('#large').evaluate(img=>{img.hidden=false;img.src='/noise.png';});await live.source.page.waitForFunction(()=>document.querySelector('img').naturalWidth===512);
 const deadline=performance.now()+10000;while((peer.stats.maxPendingBytes??0)<previous+512*1024){assert.ok(performance.now()<deadline,'Actual native image did not enter the bulk queue');await new Promise(resolve=>setTimeout(resolve,5));}
 const inputs=await page.evaluate(async initialImageBytes=>{
  const results=[],proxy=document.querySelector('#inputProxy');let previous=window.inputAcks.at(-1)?.seq??0;
  for(let i=0;i<12;i++){
   const start=performance.now();proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));
   const deadline=start+3000;while(!window.inputAcks.some(ack=>ack.seq>previous)){if(performance.now()>deadline)throw new Error('Input ACK blocked behind image transfer');await new Promise(resolve=>setTimeout(resolve,5));}
   const ack=window.inputAcks.find(ack=>ack.seq>previous);previous=ack.seq;results.push({ms:ack.at-start,accepted:ack.accepted,beforeImage:ack.imageBytes<=initialImageBytes});await new Promise(resolve=>setTimeout(resolve,30));
  }return results;
 },initialImageBytes);
 assert.ok(inputs.every(input=>input.accepted));assert.ok(inputs.some(input=>input.beforeImage),'Input confirmation must arrive before the large image finishes');
 await live.source.page.waitForFunction(()=>document.querySelector('input').value==='x'.repeat(12));
 await page.waitForFunction(seq=>window.remotePaintResult.lastProcessedInputSeq>=seq,live.source.inputSeq,{timeout:30000});
 const original=PNG.sync.read(await live.source.page.screenshot()),replay=PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 for(const [x,y]of [[25,105],[200,300],[525,605]]){const at=(y*original.width+x)*4;assert.deepEqual([...replay.data.subarray(at,at+4)],[...original.data.subarray(at,at+4)],'Large private image pixels remain exact');}
 assert.ok(requests.every(origin=>origin===live.origin),'Viewer must not request source image URLs');
 const network=JSON.parse(tc('-s','-j','qdisc','show','dev','lo'));clear();
 const sorted=inputs.map(input=>input.ms).sort((a,b)=>a-b);
 const report={at:new Date().toISOString(),scope:'Actual native Linux Chromium source, image serialization, Rust paired transport and CanvasKit Worker pixels; kernel 80ms configured RTT, 1% loss, shared 2Mbit Gateway traffic class; internal CDP not impaired',pngBytes:png.length,inputAcks:inputs,p50AckMs:sorted[Math.ceil(sorted.length*.5)-1],p95AckMs:sorted[Math.ceil(sorted.length*.95)-1],sourceText:'x'.repeat(12),sourceImageRefetches:0,exactImageSamples:3,bulkThroughFinalPixelsMs:performance.now()-bulkStarted,network,peerStats:peer.stats,result:await page.evaluate(()=>window.remotePaintResult)};
 await mkdir('artifacts/network',{recursive:true});await writeFile('artifacts/network/bulk-live.json',JSON.stringify(report,null,2));console.log(report);
}finally{clear();await browser?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
