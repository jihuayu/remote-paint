import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

const image=n=>{
 const png=new PNG({width:256,height:256});let state=n+1;
 for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data[i]=state&255;png.data[i+1]=(state>>>8)&255;png.data[i+2]=(state>>>16)&255;png.data[i+3]=255;}
 png.data.set([n&255,(n>>8)&255,199,255]);return PNG.sync.write(png,{deflateLevel:1,filterType:0});
};
let encodedImageBytes=0;
const fixture=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.pathname==='/image'){const bytes=image(Number(url.searchParams.get('n')));encodedImageBytes+=bytes.length;response.setHeader('Content-Type','image/png');response.end(bytes);return;}
 response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:24px sans-serif}img{position:absolute;left:0;top:60px;width:256px;height:256px}</style>Stable font ABCDEFG 12345<img><script>window.update=async n=>{const img=document.querySelector('img');img.src='/image?n='+n;await img.decode();};window.loaded=update(0);</script>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const baseline=process.env.REMOTE_PAINT_ASSET_CACHE_BASELINE==='1';
let live,browser;const errors=[],samples=[],fontWork=[],started=performance.now();
const displayed=async(page,n)=>page.waitForFunction(n=>{
 const source=document.querySelector('#viewport');if(!window.remotePaintResult)return false;
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.drawImage(source,0,60,1,1,0,0,1,1);const data=context.getImageData(0,0,1,1).data;
 return data[0]===(n&255)&&data[1]===((n>>8)&255)&&data[2]===199;
},n,{timeout:15000});
try{
 live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});
 live.source.on('captureError',error=>errors.push(error.message));
 await live.source.page.waitForFunction(()=>typeof window.update==='function');await live.source.page.evaluate(()=>window.loaded);
 live.source.capture.on('capture',native=>{const timing=native.timing;const cache=timing?.assetCache;if(timing)fontWork.push({fontMs:timing.fontMs,fontCacheHits:timing.fontCacheHits,fontEncodingShares:timing.fontEncodingShares??0});if(cache)samples.push({...cache,fontCacheHits:timing.fontCacheHits,imageCacheHits:timing.imageCacheHits,fontEncodingShares:timing.fontEncodingShares,imageEncodingShares:timing.imageEncodingShares});});
 browser=await launchCaptureBrowser();const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 const url=new URL(live.url);url.search='cpu';await page.goto(url.href);await displayed(page,0);
 for(let n=1;n<=140;n++){await live.source.page.evaluate(n=>window.update(n),n);live.source.requestCapture();await displayed(page,n);}
 assert.deepEqual(errors,[]);assert.ok(fontWork.length>=140);
 const first=samples[0]??null,last=samples.at(-1)??null;
 if(!baseline){
 assert.ok(samples.length>=140,'Native cache telemetry must accompany actual captures');
 for(const sample of samples){assert.ok(sample.fontBytes<=32*1024*1024);assert.ok(sample.imageBytes<=32*1024*1024);assert.ok(sample.fontEntries<=128&&sample.imageEntries<=128);assert.ok(sample.fontPending<=32&&sample.imagePending<=32);}
 assert.ok(last.imageEvictions>0,'Working set must trigger native image LRU eviction');assert.ok(last.imageEncodes>=140);
 assert.equal(last.fontEncodes,first.fontEncodes,'Image pressure must not re-encode the stable font');assert.equal(last.fontEvictions,0);
 assert.ok(samples.some(sample=>sample.fontCacheHits>0),'Changed recordings must reuse the font subset');
 }
 const report={at:new Date().toISOString(),status:baseline?'baseline-measured':'passed',scope:'Actual Linux native Chromium/Rust → CPU CanvasKit Worker, 140 noisy PNG replacements with constant source glyphs and per-update visible pixel confirmation. Native cache charge estimates exclude active serializer/IPC pins and physical process/driver overhead; no latency A/B claim. Baseline mode measures the old binary and does not certify new cache budgets or expose encoding ownership, so its frame-level timing cannot establish avoided cold encodings.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),updates:140,encodedImageBytes,elapsedMs:performance.now()-started,first,last,maximum:baseline?null:{fontBytes:Math.max(...samples.map(s=>s.fontBytes)),imageBytes:Math.max(...samples.map(s=>s.imageBytes)),fontEntries:Math.max(...samples.map(s=>s.fontEntries)),imageEntries:Math.max(...samples.map(s=>s.imageEntries))},captureSamples:fontWork.length,errors};
 await mkdir('artifacts/asset-cache',{recursive:true});await writeFile(`artifacts/asset-cache/${baseline?'native-lru-baseline':'native-lru'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
