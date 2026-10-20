// Private file-channel source for short stress and eight-hour Mac Viewer runs.
// Only the Viewer HTTP/WS ports are published; CDP and test commands stay local.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {atomicJson,deadline,startMemoryDiagnostics} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'linux');
const directory=resolve(process.env.REMOTE_PAINT_MEMORY_DIR??'artifacts/memory-soak');await mkdir(directory,{recursive:true,mode:0o700});
await mkdir(join(directory,'requests'),{recursive:true});await mkdir(join(directory,'responses'),{recursive:true});const handledIds=new Set();
const port=Number(process.env.REMOTE_PAINT_MEMORY_PORT??39176),runId=randomUUID();let imageBytes=0,imageRequests=0;
const diagnosticInterval=Number(process.env.REMOTE_PAINT_MEMORY_DIAGNOSTIC_INTERVAL??10000),fault=process.env.REMOTE_PAINT_MEMORY_TEST_FAULT;
assert.ok(Number.isInteger(diagnosticInterval)&&diagnosticInterval>=1000&&diagnosticInterval<=60000);
assert.ok(!fault||['renderer-crash','cleanup-error'].includes(fault));
function image(n){
 const png=new PNG({width:256,height:256});let state=(n+1)>>>0;
 for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data[i]=state&255;png.data[i+1]=(state>>>8)&255;png.data[i+2]=(state>>>16)&255;png.data[i+3]=255;}
 png.data.set([n&255,(n>>8)&255,199,255]);return PNG.sync.write(png,{deflateLevel:1,filterType:0});
}
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:18px sans-serif}input{position:absolute;left:20px;top:20px;width:280px;height:36px}img{position:absolute;left:20px;top:80px;width:256px;height:256px}#marker,#cycle{position:absolute;top:30px;width:24px;height:24px}#marker{left:340px;background:rgb(0,0,42)}#cycle{left:400px}#words{position:absolute;left:300px;top:100px;width:300px}</style><input id="name"><div id="marker"></div><div id="cycle"></div><img><div id="words"></div><script>
document.querySelector('input').oninput=e=>{const n=e.target.value.length;document.querySelector('#marker').style.background='rgb('+((n>>8)&255)+','+(n&255)+',42)';};
window.update=async n=>{const img=document.querySelector('img');img.src='/image?n='+n;await img.decode();document.querySelector('#cycle').style.background='rgb('+(n&255)+','+((n>>8)&255)+',199)';document.querySelector('#words').textContent='Memory 内存测试 '+n+'，透明叠加与字体更新。';window.cycle=n;};window.loaded=update(Number(new URLSearchParams(location.search).get('n')??0));
</script>`;
const fixture=createServer((request,response)=>{const url=new URL(request.url,'http://localhost');if(url.pathname==='/image'){const bytes=image(Number(url.searchParams.get('n')));imageBytes+=bytes.length;imageRequests++;response.setHeader('Content-Type','image/png');response.end(bytes);}else{response.setHeader('Content-Type','text/html; charset=utf-8');response.end(html);}});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const sourceUrl=`http://127.0.0.1:${fixture.address().port}`,live=await startLive({url:sourceUrl,host:'0.0.0.0',port}),source=live.source;
await source.page.evaluate(()=>window.loaded);let phase='startup',unexpected=[],transitions=0,handled,closing=false,timer;
source.on('captureError',error=>{if(['navigation','resize'].includes(phase)&&/Navigation invalidated|Execution context was destroyed|Cannot find context|Inspected target navigated or closed/.test(error.message))transitions++;else{unexpected.push({phase,message:error.message});unexpected=unexpected.slice(-32);}});
const atomic=(name,value)=>atomicJson(directory,name,value),diagnostics=await startMemoryDiagnostics({source,directory,runId,interval:diagnosticInterval});
if(fault==='renderer-crash'){
 const trace=[];
 for(const [label,owner]of [['control',source.control],['source',source],['capture',source.capture],['frame-driver',source.frameDriver],['browser',source.browser],['viz',source.viz],['broker',source.broker]]){
  if(!owner?.close)continue;const close=owner.close.bind(owner);
  owner.close=async(...args)=>{trace.push({at:new Date().toISOString(),label,event:'begin'});await atomic('source-close-trace.json',trace);try{return await close(...args);}finally{trace.push({at:new Date().toISOString(),label,event:'end'});await atomic('source-close-trace.json',trace);}};
 }
}
const state=async()=>({at:new Date().toISOString(),pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:source.viewport,captures:source.stats.captures,inputSeq:source.inputSeq,...await deadline(source.page.evaluate(()=>({cycle:window.cycle,inputLength:document.querySelector('input').value.length})),2000,'page state').catch(error=>({pageStateError:error.message})),control:source.control.mode,stats:source.stats,transitionInvalidations:transitions,unexpectedErrors:unexpected,imageBytes,imageRequests,peers:[...live.peers].map(p=>({id:p.id,stats:p.stats}))});
await atomic('ready.json',{runId,url:live.url,startedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,browser:source.browser.version(),diagnosticIntervalMs:diagnosticInterval,state:await state()});console.log(JSON.stringify({ready:true,runId,port}));
let stopPromise;
const stop=()=>stopPromise??=(async()=>{
 closing=true;clearTimeout(timer);diagnostics.beginClose();const steps=[];
 for(const [name,close]of [
  ['live',async()=>{await live.close();if(fault==='cleanup-error')throw new Error('Injected soak cleanup failure');}],
  ['fixture',()=>new Promise((resolve,reject)=>{fixture.close(error=>error?reject(error):resolve());fixture.closeAllConnections();})],
  ['diagnostics',()=>diagnostics.stop()],
 ]){try{await close();steps.push({name,status:'closed'});}catch(error){steps.push({name,status:'failed',error:error.stack});}}
 const receipt={at:new Date().toISOString(),runId,status:steps.every(step=>step.status==='closed')?'closed':'failed',steps,fixtureListening:fixture.listening,sourceClosed:source.closed,brokerClosed:source.broker?source.broker.child.exitCode!==null||source.broker.child.signalCode!==null:null,remainingProcesses:diagnostics.last?.metrics.processes};
 await atomic('source-stopped.json',receipt);if(receipt.status==='failed')process.exitCode=1;return receipt;
})();
async function poll(){
 if(closing)return;
 try{
  const file=(await readdir(join(directory,'requests'))).find(name=>/^[a-f0-9-]{36}\.json$/.test(name)&&!handledIds.has(name.slice(0,-5)));if(!file)return;
  const command=await readFile(join(directory,'requests',file),'utf8').then(JSON.parse);
  if(command.runId===runId&&command.id!==handled){
   handled=command.id;handledIds.add(command.id);if(handledIds.size>1024)handledIds.delete(handledIds.values().next().value);try{
    if(command.op==='update'){phase='update';assert.ok(Number.isInteger(command.cycle)&&command.cycle>0);await source.page.evaluate(n=>window.update(n),command.cycle);source.requestCapture();}
    else if(command.op==='resize'){phase='resize';await source.resize(command.viewport);}
    else if(command.op==='reload'){phase='navigation';await source.page.goto(`${sourceUrl}/?n=${command.cycle}`,{waitUntil:'domcontentloaded'});await source.page.evaluate(()=>window.loaded);source.requestCapture();}
    else if(command.op==='metrics'||command.op==='snapshot'){}
    else if(command.op==='crash'&&fault==='renderer-crash'){await deadline(source.capture.cdp.send('Page.crash'),2000,'injected crash').catch(()=>{});}
    else if(command.op==='stop'){await atomic(`responses/${command.id}.json`,{id:command.id,stopped:true});await stop();return;}
    else throw new Error('Unknown memory test operation');
    const snapshot=await state(),diagnostic=['metrics','snapshot','crash'].includes(command.op)?await diagnostics.sample(command.op):null;await atomic(`responses/${command.id}.json`,{id:command.id,state:snapshot,...(diagnostic?{metrics:diagnostic.metrics,health:diagnostic.health}:{})});
   }catch(error){await atomic(`responses/${command.id}.json`,{id:command.id,error:error.stack});}
  }
 }catch(error){if(error.code!=='ENOENT')console.error(error.stack);}
 finally{if(!closing)timer=setTimeout(()=>void poll(),25);}
}
void poll();const signalStop=()=>void stop().catch(error=>{console.error(error.stack);process.exitCode=1;});process.once('SIGTERM',signalStop);process.once('SIGINT',signalStop);
