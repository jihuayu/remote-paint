import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';

const executablePath=process.env.REMOTE_PAINT_CHROMIUM;
if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the compiled native browser');
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}canvas{display:block}</style><canvas width="320" height="240"></canvas><script>
const c=document.querySelector('canvas');const gl=c.getContext('webgl2',{preserveDrawingBuffer:true})||c.getContext('webgl',{preserveDrawingBuffer:true});
window.webglStatus={available:!!gl};
if(gl){gl.clearColor(.1,.75,.25,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();const p=new Uint8Array(4);gl.readPixels(100,100,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);window.webglStatus.pixel=[...p];window.webglStatus.version=gl.getParameter(gl.VERSION);const e=gl.getExtension('WEBGL_debug_renderer_info');window.webglStatus.renderer=e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
else{document.body.insertAdjacentHTML('beforeend','<p>WebGL unavailable</p>');}
</script>`;
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const originalLaunch=chromium.launch.bind(chromium);
const report={at:new Date().toISOString(),scope:'Isolated source and Viewer with the supplied native browser; static WebGL clear, not arbitrary WebGL compatibility',variants:[]};
try{
 for(const [name,extra] of [['current-default',[]],['diagnostic-swiftshader',['--enable-unsafe-swiftshader','--use-angle=swiftshader']]]){
  chromium.launch=options=>originalLaunch({...options,args:[...(options.args??[]),...extra]});
  let live,viewer;
  const result={name,extraArgs:extra};report.variants.push(result);
  try{
   live=await startLive({url:`http://127.0.0.1:${fixture.address().port}/`,port:0});
   result.webgl=await live.source.page.evaluate(()=>window.webglStatus);
   result.captureErrors=[];live.source.on('captureError',error=>result.captureErrors.push(error.message));
   viewer=await chromium.launch({executablePath,headless:true,args:['--no-sandbox','--disable-gpu-rasterization']});
   const page=await viewer.newPage({viewport:{width:1100,height:900}});
   await page.goto(live.url);
   try{await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:12000});result.viewerFrame=true;}
   catch(error){result.viewerFrame=false;result.viewerError=error.message.split('\n')[0];}
   const source=PNG.sync.read(await live.source.page.screenshot());
   const offset=(100*source.width+100)*4;result.sourcePixel=[...source.data.subarray(offset,offset+4)];
   if(result.viewerFrame){
    const data=await page.locator('canvas').evaluate(c=>c.toDataURL());
    const replay=PNG.sync.read(Buffer.from(data.split(',')[1],'base64'));
    const at=(100*replay.width+100)*4;result.viewerPixel=[...replay.data.subarray(at,at+4)];
    result.centerPixelMatches=result.sourcePixel.every((v,i)=>Math.abs(v-result.viewerPixel[i])<=3);
   }
   result.stats=live.source.stats;
  }catch(error){result.error=error.message;}
  finally{await viewer?.close();await live?.close();}
 }
}finally{chromium.launch=originalLaunch;await new Promise(resolve=>fixture.close(resolve));}
console.log(JSON.stringify(report,null,2));
