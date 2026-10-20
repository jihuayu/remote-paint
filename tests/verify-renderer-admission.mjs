// Actual CanvasKit comparison with deliberately retained old modules to model
// delayed collection. This is a bounded admission test,not a growth soak.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const flags=new Map();for(let n=2;n<process.argv.length;n+=2)flags.set(process.argv[n],process.argv[n+1]);
for(const name of ['--base-project','--candidate-project','--output'])assert.ok(flags.get(name),name);
const base=resolve(flags.get('--base-project')),candidate=resolve(flags.get('--candidate-project')),output=resolve(flags.get('--output'));
await mkdir(output,{mode:0o700});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const {launchCaptureBrowser}=await import(pathToFileURL(base+'/capture/browser.mjs').href);
async function probe(origin){
 const {default:init}=await import(origin+'/canvaskit-worker.mjs'),{RendererRuntime}=await import(origin+'/renderer-runtime.mjs'),{ClientMemory,memoryPolicy}=await import(origin+'/protocol/client-memory.mjs');
 const wasm=await fetch(origin+'/vendor/canvaskit.wasm').then(r=>r.arrayBuffer()),locateFile=file=>origin+'/vendor/'+file;
 const fresh=async()=>{const modules=[],memory=new ClientMemory(memoryPolicy({profile:'compact'})),canvas=new OffscreenCanvas(64,64);let calls=0,contexts=0,hidden=false;
  const context=canvas.getContext.bind(canvas);canvas.getContext=type=>{contexts++;return hidden?null:context(type);};
  const factory=async options=>{calls++;const ck=await init(options);modules.push(ck);return ck;};
  const ck=await init({wasmBinary:wasm,locateFile});modules.push(ck);
  const runtime=new RendererRuntime(ck,canvas,{memory,gpu:false,factory,wasmBinary:wasm,locateFile});
  return {runtime,memory,canvas,modules,factory,get calls(){return calls;},get contexts(){return contexts;},hide(){hidden=true;}};
 };
 const frame={viewport:{cssWidth:64,cssHeight:64,deviceScaleFactor:1},scene:{rootPass:'root',passes:[{id:'root',output:[0,0,64,64],quads:[{kind:'solid',color:[0,0,1,1],rect:[0,0,64,64],visible:[0,0,64,64],matrix:[1,0,0,0,1,0,0,0,1],clip:null,opacity:1}]}]}};
 const s=await fresh(),pixels=[];let budgetError;
 for(let n=0;n<5;n++){
  const ck=s.runtime.ck,allocation=ck.Malloc(Uint8Array,132*1024*1024),view=allocation.toTypedArray();for(let i=0;i<view.length;i+=4096)view[i]=(i/4096)&255;ck.Free(allocation);
  try{await s.runtime.recycle();await s.runtime.draw(frame,new Map());const read=new OffscreenCanvas(1,1),context=read.getContext('2d');context.drawImage(s.canvas,0,0,1,1,0,0,1,1);pixels.push([...context.getImageData(0,0,1,1).data]);}
  catch(error){budgetError={code:error.code,reason:error.reason};break;}
 }
 const budget={factoryCalls:s.calls,createdModules:s.modules.length,successfulPixels:pixels,error:budgetError,memory:s.memory.snapshot()};s.runtime.dispose();budget.ownersAfterDispose=s.memory.snapshot().owners;
 // Separate genuine factory success followed by a presentation-context
 // failure. The newly constructed Wasm backing must remain in the ledger.
 const f=await fresh();f.hide();let constructionError;try{await f.runtime.recycle();}catch(error){constructionError=error.message;}
 const constructorFailure={error:constructionError,factoryCalls:f.calls,createdModules:f.modules.length,memory:f.memory.snapshot()};f.runtime.dispose();constructorFailure.ownersAfterDispose=f.memory.snapshot().owners;
 const d=await fresh();let finish;d.runtime.factory=options=>new Promise(resolve=>{finish=()=>d.factory(options).then(resolve);});
 const pending=d.runtime.recycle().then(()=>null,error=>error.message),admittedWhilePending=d.memory.snapshot().categories.wasmInitialization??0;
 d.runtime.dispose();const admittedAfterDispose=d.memory.snapshot().categories.wasmInitialization??0;await finish();const disposeError=await pending;
 const disposal={error:disposeError,contexts:d.contexts,admittedWhilePending,admittedAfterDispose,memory:d.memory.snapshot(),ownersAfterDispose:d.memory.snapshot().owners};
 return {budget,constructorFailure,disposal};
}
let browser;const servers=[],variants=[];let failure;
try{
 browser=await launchCaptureBrowser();
 for(const [version,project]of [['before',base],['after',candidate]]){
  const {prepareViewerAssets}=await import(pathToFileURL(project+'/live/viewer-assets.mjs').href),assets=await prepareViewerAssets();
  const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(path==='/'){res.end('<!doctype html><meta charset="utf-8">');return;}const asset=assets.get(path);if(!asset?.bytes){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',asset.type);res.end(asset.bytes);});servers.push(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  for(const realm of ['main','worker']){
   const page=await browser.newPage();let result;
   try{
    await page.goto(origin);
    result=realm==='main'?await page.evaluate(probe,origin):await page.evaluate(({source,origin})=>new Promise((resolve,reject)=>{const url=URL.createObjectURL(new Blob([`(${source})(${JSON.stringify(origin)}).then(result=>postMessage({result})).catch(error=>postMessage({error:error.stack}));`],{type:'text/javascript'})),worker=new Worker(url,{type:'module'});worker.onmessage=({data})=>{worker.terminate();URL.revokeObjectURL(url);data.error?reject(new Error(data.error)):resolve(data.result);};worker.onerror=error=>{worker.terminate();URL.revokeObjectURL(url);reject(new Error(error.message));};}),{source:probe.toString(),origin});
   }finally{await page.close();}
   const record={version,realm,result};variants.push(record);await writeFile(output+'/'+version+'-'+realm+'.json',JSON.stringify(record,null,2));
   assert.deepEqual(result.budget.error,{code:'VIEWER_MEMORY_LIMIT',reason:'combined resident estimate'});
   assert.equal(result.budget.factoryCalls,version==='before'?4:3);
   assert.equal(result.budget.createdModules,version==='before'?5:4);
   assert.equal(result.budget.successfulPixels.length,3);for(const pixel of result.budget.successfulPixels)assert.deepEqual(pixel,[0,0,255,255]);
   assert.match(result.constructorFailure.error,/Cannot allocate Viewer canvas/);
   assert.equal(result.constructorFailure.memory.retiredArenaCount,version==='before'?1:2);
   assert.equal(result.constructorFailure.memory.retiredWasmBytes,(version==='before'?1:2)*128*1024*1024);
   assert.match(result.disposal.error,/disposed/);assert.equal(result.disposal.contexts,version==='before'?2:1);
   for(const key of ['admittedWhilePending','admittedAfterDispose'])assert.equal(result.disposal[key],version==='before'?0:128*1024*1024);
   assert.equal(result.budget.ownersAfterDispose,0);assert.equal(result.disposal.ownersAfterDispose,0);
   assert.equal(result.constructorFailure.ownersAfterDispose,version==='before'?1:0,'Old constructor leaked its wasmBinary owner;candidate must release it');
   console.log(JSON.stringify({version,realm,factoryCalls:result.budget.factoryCalls,createdModules:result.budget.createdModules,retiredFailedConstructor:result.constructorFailure.memory.retiredArenaCount,disposalContexts:result.disposal.contexts}));
  }
 }
}catch(error){failure=error;await writeFile(output+'/failure.json',JSON.stringify({error:error.stack},null,2));}
finally{await browser?.close();for(const server of servers)await new Promise(resolve=>server.close(resolve));}
const sourceHashes={};for(const [version,project]of [['before',base],['after',candidate]])sourceHashes[version]=Object.fromEntries(await Promise.all(['viewer/renderer-runtime.mjs','viewer/frame-presenter.mjs','protocol/client-memory.mjs'].map(async n=>[n,sha(await readFile(project+'/'+n))])));
const report={at:new Date().toISOString(),status:failure?'failed':'passed-scoped-real-CanvasKit-admission',sourceHashes,variants,forcedGc:false,oldModulesIntentionallyHeld:true,scope:'Actual CanvasKit CPU main+Worker,same compact policy. Synthetic132MiB allocation/touch and heldoldreferences model delayedGC. Before/after factory admission,failedconstructor ownership,disposedinitialization and bluepixels. No NativeSource/SKP/growth/8h acceptance.',originalGrowthFixed:false,eightHourPassed:false};
await writeFile(output+'/report.json',JSON.stringify(report,null,2));if(failure)throw failure;
