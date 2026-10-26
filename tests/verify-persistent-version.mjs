import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';
import assert from 'node:assert/strict';
import {appendFile,cp,copyFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {fixture,KEY,flush} from './fixtures/viewer-access-harness.mjs';
import {snapshot,hash} from './live-helpers.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';

// Rebundle actual Viewer modules without changing the pinned renderer bytes,
// then switch to a new real Registry Session at the same browser origin.
// Cross-CanvasKit/Native/Chromium version upgrades are not qualified here.
const output=resolve(process.argv[2]??'outputs/persistent-version-proof');
await mkdir(output,{recursive:true});
const cleanups=[],transports=[];let context,viewer,variantRoot,selectedTransport,browser,ownedProcess;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function startOwnedBrowser(){
 const options=cacheBrowserOptions();
 const child=ownedProcess=spawn(options.executablePath,['--headless','--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+output+'/owned-chrome-profile',...options.args],{stdio:['ignore','ignore','pipe']});
 let stderr='';
 const endpoint=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Owned browser launch deadline')),10000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned browser exited before CDP'));});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-32768);const match=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
 });
 browser=await chromium.connectOverCDP(endpoint,{timeout:10000});context=browser.contexts()[0];
}
async function killOwnedBrowser(){
 const child=ownedProcess;if(!child)return;
 const done=child.exitCode===null&&child.signalCode===null?once(child,'exit',{signal:AbortSignal.timeout(5000)}):Promise.resolve();
 if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 await done;await browser?.close().catch(()=>{});ownedProcess=null;context=null;browser=null;
}
async function closeViewer(){if(viewer){viewer.closeAllConnections();await new Promise(r=>viewer.close(r));viewer=null;}}
async function counts(page){return page.evaluate(async()=>{
 const request=indexedDB.open('remote-paint-private-resources-v1',1);
 await new Promise((resolve,reject)=>{request.onsuccess=resolve;request.onerror=()=>reject(request.error);});
 const db=request.result;try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(['meta','bodies'],'readonly'),a=tx.objectStore('meta').getAll(),b=tx.objectStore('bodies').count();
  tx.oncomplete=()=>resolve({rows:a.result,bodies:b.result});tx.onabort=()=>reject(new Error('Owned cache snapshot aborted'));
 });}finally{db.close();}
});}
async function until(callback){const end=performance.now()+2500;while(!await callback()){assert.ok(performance.now()<end,'Owned cache settlement deadline');await new Promise(r=>setTimeout(r,10));}}
try{
 const full=await prepareViewerAssets({mode:'public'});
 variantRoot=await mkdtemp(join(tmpdir(),'remote-paint-cache-renderer-'));
 // Use the unchanged production bundler in an owned temporary source tree.
 for(const directory of ['live','viewer','protocol','sdk'])await cp(new URL('../'+directory,import.meta.url),join(variantRoot,directory),{recursive:true});
 await mkdir(join(variantRoot,'node_modules/canvaskit-wasm/bin/full'),{recursive:true});
 for(const extension of ['js','wasm'])await copyFile(new URL('../node_modules/canvaskit-wasm/bin/full/canvaskit.'+extension,import.meta.url),join(variantRoot,'node_modules/canvaskit-wasm/bin/full/canvaskit.'+extension));
 await appendFile(join(variantRoot,'viewer/live.mjs'),'\n// Owned static build transition fixture.\n');
 const {prepareViewerAssets:prepareVariant}=await import(pathToFileURL(join(variantRoot,'live/viewer-assets.mjs')).href);
 const updated=await prepareVariant({mode:'public'});
 assert.equal(full.wasmSha256,updated.wasmSha256);assert.notEqual(full.build,updated.build);
 const h=await fixture({after:fn=>cleanups.push(fn)},{ttlSeconds:300,wasmSha256:full.wasmSha256,viewerBuild:full.build,
  resolveSource:(args,{transport})=>({tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,...(selectedTransport??transport)})});
 h.source.latest=snapshot();h.source.viewport=h.source.latest.viewport;
 await startOwnedBrowser();
 const results=[];let port,currentSession=h.sessionId;
 for(const mainThread of [false,true]){
  const stages=[];let oldRealm,namespace,referencePng;
  for(const [index,assets]of [full,updated,full].entries()){
   if(index===2){const created=h.registry.create('a',{ttlSeconds:300},{idempotencyKey:'version-path-'+mainThread});await flush();currentSession=created.sessionId;assert.equal(h.registry.requireReady('a',currentSession).state,'ready');}
   if(index===0)currentSession=h.sessionId;
   await closeViewer();
   if(selectedTransport){await selectedTransport.close();selectedTransport=null;}
   if(index===0)selectedTransport=h.transport;
   else{selectedTransport=await startLiveTransport(h.source,{port:0,preparedAssets:assets});transports.push(selectedTransport);}
   // A separate worker/main path starts after the original fixture transport
   // has closed, so create a fresh private transport for that path too.
   if(index===0&&mainThread){selectedTransport=await startLiveTransport(h.source,{port:0,preparedAssets:assets});transports.push(selectedTransport);}
   viewer=await createPublicViewerServer({gatewayOrigin:h.base,allowedParentOrigins:[],preparedAssets:assets});
   viewer.listen(port??0,'127.0.0.1');await once(viewer,'listening');port=viewer.address().port;
   const origin='http://127.0.0.1:'+port,page=await context.newPage(),errors=[];
   page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   if(mainThread)await page.addInitScript(()=>Object.defineProperty(HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:undefined}));
   await page.exposeFunction('fixtureViewerTicket',async()=>{const reply=await h.api('/v1/sessions/'+currentSession+'/viewer-tickets',{method:'POST',key:KEY,body:{role:'readonly',audience:origin,ttlSeconds:120}});assert.equal(reply.status,200);return reply.data;});
   await page.goto(origin);await page.evaluate(async({base,sessionId})=>{await window.remotePaintViewer.ready;window.remotePaintViewer.connect({gatewayOrigin:base,sessionId,role:'readonly',getTicket:()=>window.fixtureViewerTicket()});},{base:h.base,sessionId:currentSession});
   await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
   const cold=await page.evaluate(()=>({result:window.remotePaintResult,startup:window.remotePaintStartup}));
   assert.equal(!!cold.startup.worker,!mainThread);assert.equal(cold.result.resourcesReceived,index===1?0:1);if(index===1)assert.ok(cold.result.persistentCache.hits>0);else assert.equal(cold.result.persistentCache.hits,0);
   let stored;await until(async()=>{stored=await counts(page);return stored.rows.some(row=>row.id===hash)&&stored.bodies>0;});
   const realms=new Set(stored.rows.map(row=>row.realm));assert.equal(realms.size,1);
   const realm=stored.rows[0].realm,identity=JSON.parse(realm);assert.equal(identity[3],assets.wasmSha256);
   if(index===1){assert.equal(identity[1],namespace);assert.equal(realm,oldRealm,'compatible renderer reuses private data across static module builds');}
   else if(index===2){assert.notEqual(identity[1],namespace);assert.notEqual(realm,oldRealm,'new Session purges old scope');}
   else namespace=identity[1];
   const png=await page.locator('#viewport').screenshot();if(referencePng)assert.equal(sha(png),referencePng);else referencePng=sha(png);
   await writeFile(output+'/'+(mainThread?'main':'worker')+'-'+index+'.png',png);
   await page.locator('#reconnect').click();await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,cold.result.connectionGeneration);
   const warm=await page.evaluate(()=>window.remotePaintResult);assert.ok(warm.persistentCache.hits>0);assert.equal(warm.resourcesReceived,0);assert.deepEqual(errors,[]);
   const stage={variant:index===1?'updated-viewer-modules':'original-viewer-modules',sessionId:currentSession,viewerBuild:assets.build,wasmSha256:assets.wasmSha256,realm,cold,warm,physicalRows:stored.rows.length,physicalBodies:stored.bodies,canvasPngSha256:sha(png)};
   if(index<2){
    // Kill only the exact child launched above. Abrupt browser exit cannot
    // execute pagehide, so the next launch sees physically retained rows.
    console.log(JSON.stringify({mainThread,stage:index,step:'kill-owned-browser'}));
    await killOwnedBrowser();await startOwnedBrowser();
    const observer=await context.newPage();await observer.goto(origin+'/viewer-config');
    const afterCrash=await counts(observer);assert.ok(afterCrash.rows.some(row=>row.realm===realm));assert.ok(afterCrash.bodies>0);await observer.close();
    stage.abruptViewerCrash={actualOwnedBrowserKill:true,pagehidePurgeBypassedByAbruptExit:true,oldPhysicalRows:afterCrash.rows.length,oldPhysicalBodies:afterCrash.bodies};
   }else{
    await page.evaluate(()=>window.remotePaintViewer.disconnect());const cleared=await counts(page);assert.equal(cleared.rows.length,0);assert.equal(cleared.bodies,0);await page.close();stage.logout={meta:0,bodies:0};
   }
   stages.push(stage);oldRealm=realm;
   console.log(JSON.stringify({mainThread,stage:index,variant:stage.variant,coldResources:cold.result.resourcesReceived,warmResources:warm.resourcesReceived,oldRealmPurged:index===2}));
  }
  results.push({mainThread,stages});
 }
 const result={status:'passed',results,actualIndexedDb:true,actualViewerStaticBuildChange:true,compatibleRendererReused:true,sameCanvasKitPackageVersion:'0.42.0',actualPublicProxy:true,sameOrigin:true,newRealRegistrySessionIsolation:true,crossCanvasKitVersionUpgradeQualified:false,abruptOwnedBrowserExit:true,nativeSourceVersionUpgradeQualified:false,crossReleaseChromiumUpgradeQualified:false,source:'virtual Node Source with existing SKP',performanceQualified:false};
 await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{await killOwnedBrowser();await closeViewer();for(const transport of transports.reverse())await transport.close();for(const cleanup of cleanups.reverse())await cleanup();if(variantRoot)await rm(variantRoot,{recursive:true,force:true});}
