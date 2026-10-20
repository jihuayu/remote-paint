// Opt-in legacy-mode integration on an isolated working browser package.
// This does not activate or qualify the new Chromium Native download bridge.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile,stat,readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {startLive} from '../live.mjs';
import {createManagedAgentRun} from '../live/managed-agent-run.mjs';
import {acquireSourceDownloadReader} from '../live/source-download-spool.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_SOURCE_DOWNLOAD_SPOOL_OUTPUT;assert.ok(output);await mkdir(output,{mode:0o700});
const bytes=Buffer.from(Array.from({length:8003},(_,i)=>(i*19+7)%256)),sha=v=>createHash('sha256').update(v).digest('hex');
const sockets=new Set(),requests=[],errors=[],knownProcesses=[];let live,run,activity,root,browser,page,originalContext,launches=0,pages=0,stage='fixture',failed=null;
async function until(check,ms=20000){const end=performance.now()+ms;for(;;){const value=await check();if(value)return value;assert.ok(performance.now()<end,'Source spool integration deadline');await new Promise(r=>setTimeout(r,10));}}
async function bounded(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Source spool integration operation deadline')),30000))]);}finally{clearTimeout(timer);}}
async function identity(pid){try{const value=await readFile('/proc/'+pid+'/stat','utf8');return value.slice(value.lastIndexOf(') ')+2).split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const fixture=createServer((req,res)=>{
 try{
  requests.push({path:req.url,cookie:req.headers.cookie??null});assert.ok(requests.length<=16);
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html','set-cookie':'spool-proof=original-page; HttpOnly; SameSite=Lax'});res.end('<!doctype html><style>a{display:block;height:50px}</style><a href="/owned" download>Owned</a><a href="/unarmed" download>Unarmed</a>');return;}
  if(req.url==='/owned'||req.url==='/unarmed'){assert.equal(req.headers.cookie,'spool-proof=original-page');res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="report.bin"'});res.end(bytes);return;}
  res.writeHead(404);res.end();
 }catch(error){errors.push({at:'fixture',message:error.message});res.destroy();}
});fixture.on('connection',socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const originalLaunch=chromium.launch;
chromium.launch=async function(options){
 launches++;assert.equal(launches,1);root=options.downloadsPath;assert.equal(typeof root,'string');assert.equal((await stat(root)).mode&0o777,0o700);assert.ok(!options.args.includes('--remote-paint-download-budget-v1'));
 browser=await originalLaunch.call(this,options);const newPage=browser.newPage.bind(browser);
 browser.newPage=async options=>{pages++;assert.equal(pages,1);page=await newPage(options);return page;};return browser;
};
const observations={};
try{
 stage='original-source';live=await bounded(startLive({url:'http://127.0.0.1:'+fixture.address().port+'/',port:0,nativePort:0}));const source=live.source;assert.equal(source.nativeAutopublish,true);assert.equal(source.browser,browser);assert.equal(source.page,page);originalContext=page.context();const frame=once(source,'frame');source.setDemand(1);await bounded(frame);activity=source.acquirePageRun();source.setDemand(0);
 const cdp=await browser.newBrowserCDPSession();try{for(const row of [...(await cdp.send('SystemInfo.getProcessInfo')).processInfo,{id:source.broker.child.pid}]){const pid=Number(row.id),startTicks=await identity(pid);if(startTicks)knownProcesses.push({pid,startTicks});}}finally{await cdp.detach();}
 run=createManagedAgentRun(source.control,{tenantId:'spool-proof',sessionId:'ses_'+randomUUID(),version:'chromium:'+browser.version()+';wasm:'+'a'.repeat(64),authorize:()=>true});const context=await until(()=>{try{return run.observationContext();}catch(e){if(['STALE_AGENT_PAGE','AGENT_OBSERVATION_BUSY'].includes(e.code))return null;throw e;}});
 stage='armed-real-intake';let pathWork;page.once('download',download=>{pathWork=download.path();void pathWork.catch(()=>{});});const armed=await run.armDownload(context,{maxBytes:10000}),event=once(page,'download');await page.locator('a[href="/owned"]').click();await bounded(event);const file=await pathWork;assert.equal(dirname(file),root);const ready=await until(async()=>{const info=await run.downloadInfo(armed.downloadId,context);return info.stage==='download-ready'?info:null;});const parts=[];let offset=0;
 for(;;){const chunk=await run.readDownload(armed.downloadId,offset,context,3072);assert.ok(Buffer.byteLength(JSON.stringify(chunk))<=6144);parts.push(Buffer.from(chunk.data,'base64'));offset+=chunk.byteLength;if(chunk.complete)break;}
 assert.deepEqual(Buffer.concat(parts),bytes);assert.equal(ready.sha256,sha(bytes));assert.equal(ready.fileName,'report.bin');await assert.rejects(stat(file),e=>e.code==='ENOENT');await run.releaseDownload(armed.downloadId,context);await run.close();run=null;
 observations.armed={bytes:bytes.length,sha256:sha(bytes),actualOriginalPage:true,cookiePreserved:true,spoolFileRemoved:true,sdkEnvelopePreserved:true};
 stage='legacy-unarmed-residual';const unarmedEvent=once(page,'download');await page.locator('a[href="/unarmed"]').click();const [unarmed]=await bounded(unarmedEvent),residual=await unarmed.path();assert.equal(dirname(residual),root);assert.equal((await stat(residual)).size,bytes.length);assert.equal(page.context(),originalContext);assert.equal(requests.filter(r=>r.path==='/owned').length,1);assert.equal(requests.filter(r=>r.path==='/unarmed').length,1);
 observations.unarmed={legacyBehaviorUnchanged:true,privateRootOwnsResidual:true,noRefetch:true};
 stage='retire';activity();activity=null;await bounded(live.close());await assert.rejects(stat(root),e=>e.code==='ENOENT');assert.equal(browser.isConnected(),false);assert.throws(()=>acquireSourceDownloadReader(page),e=>e.code==='SOURCE_DOWNLOAD_SPOOL_FAILED');observations.retirement={privateRootAbsent:true,newReadersRejected:true,launches,pages,originalContextPreserved:true};
}catch(error){failed={stage,code:error.code??null,message:String(error.message).slice(0,700),stack:String(error.stack).split('\n').slice(0,6)};}
finally{
 chromium.launch=originalLaunch;
 try{await bounded(run?.close());}catch(e){errors.push({at:'run-close',message:e.message});}activity?.();
 try{await bounded(live?.close());}catch(e){errors.push({at:'source-close',message:e.message});}
 for(const socket of sockets)socket.destroy();await new Promise(r=>fixture.close(r));
 try{await until(async()=>{for(const p of knownProcesses)if(await identity(p.pid)===p.startTicks)return false;return true;});}catch(e){errors.push({at:'known-process-retirement',message:e.message});}
}
const result={at:new Date().toISOString(),status:failed||errors.length?'failed':'passed',stage,observations,requests,knownProcesses,knownProcessesRetired:!errors.some(e=>e.at==='known-process-retirement'),failed,errors,scope:'Legacy-mode isolated original Source launch/Page/context, actual HTTP cookie download, bounded existing Run chunks, private residual directory removal after original local Browser ChildProcess close and Playwright close. New Chromium Native bridge and whole namespace/physical memory are not runtime qualified.',sourceDownloadBudgetActivated:false,sourceDownloadBridgeWired:false,downloadTransferReady:false,wholeGoalQualified:false};
await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:result.status,stage,failed,errors,knownProcesses:knownProcesses.length}));if(result.status!=='passed')process.exitCode=1;
