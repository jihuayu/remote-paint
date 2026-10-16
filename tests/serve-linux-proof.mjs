// Private acceptance channel over a bind-mounted directory. No test/control
// HTTP endpoint or CDP port is added to the Viewer transport.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startLive} from '../live.mjs';
import {runtimeMetrics} from '../native/runtime-metrics.mjs';
import {nativeRuntimeInfo} from '../native/launch.mjs';
import {installInputLatencyProbe} from './input-latency.mjs';
assert.equal(process.platform,'linux');assert.equal(process.arch,'arm64');
const directory=resolve(process.env.REMOTE_PAINT_LINUX_PROOF??'artifacts/linux-mac');
await mkdir(directory,{recursive:true});
const live=await startLive({host:'0.0.0.0',port:4176}),source=live.source,runId=randomUUID();
assert.ok(source.frameDriver,'Native Linux acceptance requires BeginFrame');
const atomic=async(name,value)=>{const path=join(directory,name);await writeFile(`${path}.tmp`,JSON.stringify(value,null,2));await rename(`${path}.tmp`,path);};
const selectors=['header','header h1','header p','#name','#save','#saved','#editor','#start-stream','#stop-clock','#stream','#private-image','#blob-image'];
const snapshot=async()=>({
 ...nativeRuntimeInfo(source.frameDriver),browser:source.browser.version(),stats:{...source.stats},viz:{...source.viz.stats},
 native:source.latest?.native??null,captures:source.stats.captures,demand:source.demand,inputSeq:source.inputSeq,
 pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:{...source.viewport},controlMode:source.control.mode,
 document:await source.page.evaluate(selectors=>({
  name:document.querySelector('#name').value,saved:document.querySelector('#saved').textContent,
  editor:document.querySelector('#editor').innerText,stream:document.querySelector('#stream').textContent,scrollY,
  elements:Object.fromEntries(selectors.map(selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();return [selector,{
   box:{x:r.x,y:r.y,width:r.width,height:r.height},foreground:getComputedStyle(el).color.match(/[\d.]+/g).slice(0,3).map(Number),
  }];})),
 }),selectors),
});
await atomic('ready.json',{runId,url:live.url,origin:live.origin,streamOrigin:live.streamOrigin,source:await snapshot()});
console.log(`Native Linux proof Viewer: ${live.url}`);
let handled=null,closing=false,timer;
async function poll(){
 if(closing)return;
 try{
  const command=JSON.parse(await readFile(join(directory,'request.json'),'utf8'));
  if(command.runId===runId&&command.id!==handled&&/^[a-f0-9-]{36}$/.test(command.id)){
   handled=command.id;
   try{
    let probe=null,metrics=null;
    switch(command.op){
     case 'snapshot':break;
     case 'metrics':metrics={...await runtimeMetrics(source),peers:[...live.peers].map(p=>({id:p.id,stats:{...p.stats}}))};break;
     case 'freeze':await source.page.locator('#stop-clock').click();await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.pause()));break;
     case 'animate':await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.play()));break;
     case 'reload':await source.page.reload();break;
     case 'resize':await source.resize({width:800,height:600});break;
     case 'reset':await source.resize({width:960,height:640});await source.page.reload();break;
     case 'screenshot':await source.page.screenshot({path:join(directory,`source-${command.id}.png`)});break;
     case 'latency-baseline':source.capture.interval=120;source.capture.captureOnInput=false;probe=await installInputLatencyProbe(source.page);break;
     case 'latency-optimized':source.capture.interval=1000/60;source.capture.captureOnInput=true;probe=await installInputLatencyProbe(source.page);break;
     case 'latency-done':source.capture.interval=1000/60;source.capture.captureOnInput=true;await source.page.evaluate(()=>window.removeInputLatencyProbe?.());break;
     default:throw new Error('Unknown Linux proof operation');
    }
    await atomic('response.json',{id:command.id,state:await snapshot(),probe,metrics,screenshot:command.op==='screenshot'?`source-${command.id}.png`:null});
   }catch(error){await atomic('response.json',{id:command.id,error:error.stack});}
  }
 }catch(error){if(error.code!=='ENOENT')console.error(error);}
 finally{if(!closing)timer=setTimeout(()=>void poll(),50);}
}
void poll();
const stop=async()=>{closing=true;clearTimeout(timer);await live.close();process.exit(0);};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
