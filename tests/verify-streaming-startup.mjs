import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startLive} from '../live.mjs';

const sockets=new Set(),pending=new Set();
const output=process.env.REMOTE_PAINT_STREAMING_STARTUP_OUTPUT??'artifacts/startup';
const fixture=createServer((req,res)=>{
 if(req.url==='/slow'){pending.add(res);res.writeHead(200,{'Content-Type':'image/png'});res.flushHeaders();res.on('close',()=>pending.delete(res));return;}
 if(req.url==='/events'){pending.add(res);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: open\n\n');res.on('close',()=>pending.delete(res));return;}
 res.setHeader('Content-Type','text/html');res.write('<style>body{margin:0;background:#123456}</style><p>加载中也能显示</p><img src="/slow"><script>new EventSource("/events")</script>');
 // An unfinished document response also prevents the load/networkidle gates.
 pending.add(res);res.on('close',()=>pending.delete(res));
});fixture.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let live,browser;
try{
 const started=performance.now();live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});
 const sessionReadyMs=performance.now()-started;assert.ok(sessionReadyMs<8000,'Session creation must not wait for network idle');
 assert.equal(live.source.readiness.navigation,'committed');assert.equal(live.source.readiness.capture,'ready');assert.equal(live.source.readiness.firstScene,false);
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,args:['--no-sandbox']});const page=await browser.newPage();
 await page.goto(live.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:8000});
 await page.waitForFunction(()=>{const s=document.createElement('canvas');s.width=s.height=1;const ctx=s.getContext('2d');ctx.drawImage(document.querySelector('canvas'),500,500,1,1,0,0,1,1);return ctx.getImageData(0,0,1,1).data[0]===18;});
 assert.equal(live.source.readiness.firstScene,true);assert.ok(pending.size>=2,'Resources are still loading when the Viewer presents pixels');
 const report={at:new Date().toISOString(),scope:'Actual native browser, Rust data plane and CanvasKit pixels with an unfinished HTML response, slow image and event stream',sessionReadyMs,firstViewerPixelsMs:performance.now()-started,readiness:live.source.readiness,documentReadyState:await live.source.page.evaluate(()=>document.readyState),unfinishedResponses:pending.size};
 await mkdir(output,{recursive:true});await writeFile(`${output}/streaming.json`,JSON.stringify(report,null,2));console.log(report);
}finally{await browser?.close();await live?.close();for(const response of pending)response.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>fixture.close(resolve));}
