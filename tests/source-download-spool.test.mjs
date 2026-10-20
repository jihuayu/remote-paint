import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,readFile,open,stat,lstat,rename,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createSourceDownloadSpool,acquireSourceDownloadReader} from '../live/source-download-spool.mjs';
import {observationFixture} from './fixtures/agent-observation-fixture.mjs';

const failed=e=>e.code==='SOURCE_DOWNLOAD_SPOOL_FAILED';
const missing=e=>e.code==='ENOENT';
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const observeProcess=browser=>{let onExit;const wait=new Promise(resolve=>{onExit=resolve;browser.once('process-exit',onExit);});return {wait,detach:()=>browser.off('process-exit',onExit)};};
const createFixtureSpool=()=>createSourceDownloadSpool({observeProcess});
async function until(check){const end=performance.now()+3000;while(!check()){assert.ok(performance.now()<end,'fixture deadline');await new Promise(r=>setTimeout(r,2));}}
function fakeBrowser(options={}){
 const b=new EventEmitter();let connected=true;b.calls=0;
 b.isConnected=()=>connected;
 b.disconnect=()=>{connected=false;b.emit('disconnected');};
 b.close=async()=>{b.calls++;await options.closeGate?.promise;if(options.closeError)throw new Error('fixture close failed');if(!options.stillConnected)b.disconnect();if(!options.holdExit)b.emit('process-exit');};
 return b;
}
async function fixture(t,options={}){
 const spool=await createFixtureSpool(),browser=fakeBrowser(options);let root;
 await spool.launch(path=>{root=path;return browser;});
 const page={context:()=>({browser:()=>browser})};spool.bindPage(page);
 // These fixtures have no external writer. Production never removes a
 // preserved failed/unknown launch merely because its test process is done.
 t.after(async()=>{try{await spool.retire();}catch{}await rm(root,{recursive:true,force:true});});
 return {spool,browser,page,root};
}

test('private spool is an absolute0700 directory and only its original Page acquires readers',async t=>{
 const f=await fixture(t),s=await lstat(f.root);assert.ok(isAbsolute(f.root)&&s.isDirectory());assert.equal(s.mode&0o777,0o700);
 assert.equal(acquireSourceDownloadReader({}),undefined);
 assert.throws(()=>f.spool.bindPage({context:()=>({browser:()=>f.browser})}),failed);
 const lease=acquireSourceDownloadReader(f.page);assert.equal(f.spool.status().readers,1);lease.closed();lease.closed();assert.equal(f.spool.status().readers,0);
 assert.equal(JSON.stringify(f.spool.status()).includes(f.root),false);
 await f.spool.retire();assert.equal(f.browser.calls,1);await assert.rejects(stat(f.root),missing);assert.equal(f.spool.status().pathRemoved,true);assert.equal(f.spool.status().handleClosed,true);
});
test('foreign Browser Page binding is rejected without claiming it',async t=>{
 const spool=await createFixtureSpool(),browser=fakeBrowser();let root;await spool.launch(path=>{root=path;return browser;});
 t.after(()=>rm(root,{recursive:true,force:true}));const foreign={context:()=>({browser:()=>fakeBrowser()})};assert.throws(()=>spool.bindPage(foreign),failed);assert.equal(acquireSourceDownloadReader(foreign),undefined);await spool.retire();
});
test('an unlaunched directory can retire without inventing a browser close',async()=>{
 const spool=await createFixtureSpool();await spool.retire();assert.deepEqual(spool.status(),{launchStarted:false,closeRequested:true,writerClosed:true,browserProcessExited:false,readers:0,pathRemoved:true,handleClosed:true,uncertain:false,cleanupFailed:false});assert.throws(()=>spool.launch(()=>fakeBrowser()),failed);
});
test('retirement owns an already pending launch and waits for the actual original close',async t=>{
 const spool=await createFixtureSpool(),launchGate=gate(),closeGate=gate(),browser=fakeBrowser({closeGate});let root;
 const launching=spool.launch(async path=>{root=path;await launchGate.promise;return browser;});await until(()=>!!root);t.after(()=>rm(root,{recursive:true,force:true}));
 let done=false;const retiring=spool.retire().then(()=>done=true);await new Promise(setImmediate);assert.equal(done,false);assert.equal(browser.calls,0);launchGate.resolve();assert.equal(await launching,browser);await until(()=>browser.calls===1);assert.equal(done,false);assert.equal((await stat(root)).isDirectory(),true);closeGate.resolve();await retiring;assert.equal(done,true);
});
test('a factory may reenter close without running before its pending launch is owned',async t=>{
 const spool=await createFixtureSpool(),browser=fakeBrowser();let root,closing;
 await spool.launch(path=>{root=path;closing=spool.closeBrowser();return browser;});t.after(()=>rm(root,{recursive:true,force:true}));await closing;await spool.retire();assert.equal(browser.calls,1);
});
test('rejected unknown launch preserves its directory and never returns a cleanup receipt',async t=>{
 const spool=await createFixtureSpool();let root;await assert.rejects(spool.launch(path=>{root=path;throw new Error('fixture unknown '+path);}),failed);t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'partial'),'partial');await assert.rejects(spool.retire(),e=>failed(e)&&!e.message.includes(root));assert.equal(await readFile(join(root,'partial'),'utf8'),'partial');assert.equal(spool.status().writerClosed,false);assert.equal(spool.status().pathRemoved,false);assert.equal(spool.status().handleClosed,true);
});
test('unexpected disconnection is not a process-exit witness even if a later close resolves',async t=>{
 const f=await fixture(t);f.browser.disconnect();await assert.rejects(f.spool.retire(),failed);assert.equal(f.browser.calls,1);assert.equal(f.spool.status().uncertain,true);assert.equal(f.spool.status().pathRemoved,false);assert.equal((await stat(f.root)).isDirectory(),true);
});
test('rejected browser close remains failed across repeated cleanup calls',async t=>{
 const f=await fixture(t,{closeError:true});const first=f.spool.closeBrowser();await assert.rejects(first,failed);assert.equal(f.spool.closeBrowser(),first);await assert.rejects(f.spool.retire(),failed);assert.equal(f.browser.calls,1);assert.equal(f.spool.status().writerClosed,false);assert.equal((await stat(f.root)).isDirectory(),true);
});
test('a fulfilled close that leaves the browser connected cannot authorize directory deletion',async t=>{
 const f=await fixture(t,{stillConnected:true});await assert.rejects(f.spool.retire(),failed);assert.equal(f.spool.status().writerClosed,false);assert.equal((await stat(f.root)).isDirectory(),true);
});
test('fulfilled Playwright close still waits for the independent original process-close event',async t=>{
 const f=await fixture(t,{holdExit:true});let retired=false;const closing=f.spool.retire().then(()=>retired=true);await until(()=>f.browser.calls===1&&!f.browser.isConnected());assert.equal(retired,false);assert.equal(f.spool.status().browserProcessExited,false);assert.equal((await stat(f.root)).isDirectory(),true);f.browser.emit('process-exit');await closing;assert.equal(f.spool.status().browserProcessExited,true);assert.equal(retired,true);
});
test('missing local driver process capability cannot fall back to a disconnected facade',async t=>{
 const spool=await createSourceDownloadSpool(),browser=fakeBrowser();let root;await assert.rejects(spool.launch(path=>{root=path;return browser;}),failed);t.after(()=>rm(root,{recursive:true,force:true}));await assert.rejects(spool.retire(),failed);assert.equal(spool.status().pathRemoved,false);assert.equal((await stat(root)).isDirectory(),true);
});
test('process-close deadline preserves failure even after a late actual close event',async t=>{
 const f=await fixture(t,{holdExit:true});t.mock.timers.enable({apis:['setTimeout']});
 const retired=assert.rejects(f.spool.retire(),failed);await new Promise(setImmediate);assert.equal(f.browser.calls,1);t.mock.timers.tick(30000);await retired;t.mock.timers.reset();assert.equal(f.spool.status().writerClosed,false);assert.equal(f.spool.status().pathRemoved,false);assert.equal(f.browser.listenerCount('process-exit'),0);f.browser.emit('process-exit');await new Promise(setImmediate);assert.equal(f.spool.status().uncertain,true);assert.equal((await stat(f.root)).isDirectory(),true);
});
test('actual open-file work holds directory retirement after the browser closes',async t=>{
 const f=await fixture(t),path=join(f.root,'held');await writeFile(path,'held bytes');const lease=acquireSourceDownloadReader(f.page),file=await open(path,'r');
 let retired=false;const closing=f.spool.retire().then(()=>retired=true);await until(()=>f.spool.status().writerClosed);assert.equal(retired,false);assert.equal((await file.stat()).nlink,1);assert.equal((await stat(path)).size,10);assert.throws(()=>acquireSourceDownloadReader(f.page),failed);
 await file.close();lease.closed();await closing;assert.equal(retired,true);assert.equal(f.spool.status().readers,0);await assert.rejects(stat(f.root),missing);
});
test('one settled reader cannot release another reader or a sticky unknown descriptor close',async t=>{
 const f=await fixture(t),one=acquireSourceDownloadReader(f.page),two=acquireSourceDownloadReader(f.page);one.closed();one.closed();assert.equal(f.spool.status().readers,1);two.uncertain();two.closed();await assert.rejects(f.spool.retire(),failed);assert.equal(f.spool.status().readers,0);assert.equal(f.spool.status().pathRemoved,false);assert.equal((await stat(f.root)).isDirectory(),true);
});
test('a renamed original directory cannot be mistaken for an already deleted directory',async t=>{
 const f=await fixture(t),moved=f.root+'-moved';await writeFile(join(f.root,'keep'),'keep');await rename(f.root,moved);t.after(()=>rm(moved,{recursive:true,force:true}));await assert.rejects(f.spool.retire(),failed);assert.equal(await readFile(join(moved,'keep'),'utf8'),'keep');assert.equal(f.spool.status().pathRemoved,false);
});
test('a replacement directory at the old path is preserved along with the renamed original',async t=>{
 const f=await fixture(t),moved=f.root+'-moved';await rename(f.root,moved);t.after(()=>rm(moved,{recursive:true,force:true}));await mkdir(f.root);await writeFile(join(f.root,'foreign'),'foreign');await assert.rejects(f.spool.retire(),failed);assert.equal(await readFile(join(f.root,'foreign'),'utf8'),'foreign');assert.equal((await stat(moved)).isDirectory(),true);
});
test('a symlink replacing the owned root never authorizes deleting the target',async t=>{
 const f=await fixture(t),moved=f.root+'-moved',foreign=await mkdtemp(join(tmpdir(),'remote-paint-spool-test-'));await rename(f.root,moved);await writeFile(join(foreign,'keep'),'keep');await symlink(foreign,f.root);t.after(async()=>{await rm(moved,{recursive:true,force:true});await rm(foreign,{recursive:true,force:true});});await assert.rejects(f.spool.retire(),failed);assert.equal(await readFile(join(foreign,'keep'),'utf8'),'keep');
});
test('deleting an owned descendant symlink leaves its external data intact',async t=>{
 const f=await fixture(t),foreign=await mkdtemp(join(tmpdir(),'remote-paint-spool-test-'));t.after(()=>rm(foreign,{recursive:true,force:true}));await writeFile(join(foreign,'keep'),'keep');await symlink(foreign,join(f.root,'link'));await f.spool.retire();assert.equal(await readFile(join(foreign,'keep'),'utf8'),'keep');await assert.rejects(stat(f.root),missing);
});
test('an unexpectedly missing original path cannot supply our own removal receipt',async t=>{
 const f=await fixture(t);await rm(f.root,{recursive:true});await assert.rejects(f.spool.retire(),failed);assert.equal(f.spool.status().pathRemoved,false);assert.equal(f.spool.status().uncertain,true);
});
test('retirement and original browser close are idempotent and unregister the lifecycle listener',async t=>{
 const f=await fixture(t);assert.equal(f.browser.listenerCount('disconnected'),1);const retiring=f.spool.retire();assert.equal(f.spool.retire(),retiring);await retiring;assert.equal(f.browser.listenerCount('disconnected'),0);assert.equal(f.browser.calls,1);assert.throws(()=>f.spool.bindPage(f.page),failed);assert.throws(()=>f.spool.launch(()=>f.browser),failed);
});
test('legacy intake holds the Source lease through real path and artifact settlement',async t=>{
 const h=observationFixture(t),page=h.source.page,events=new EventEmitter(),context=h.run.observationContext(),pathGate=gate(),deleteGate=gate();
 // Use the real observation/Run owner and its original Page, not a second Run.
 page.on=events.on.bind(events);page.off=events.off.bind(events);
 const spool=await createFixtureSpool();let root;const browser=fakeBrowser();await spool.launch(p=>{root=p;return browser;});page.context=()=>({browser:()=>browser});spool.bindPage(page);t.after(()=>rm(root,{recursive:true,force:true}));
 h.handler=(method,p)=>method==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('screenshotMetadata')?{result:{value:{ok:true,url:'',title:'',truncated:false}}}:undefined;
 const path=join(root,'owned');await writeFile(path,Buffer.from([0,255,3]));let pathCalled=false,deleteCalled=false;
 const ticket=await h.run.armDownload(context);events.emit('download',{page:()=>page,suggestedFilename:()=> 'report.bin',async path(){pathCalled=true;await pathGate.promise;return path;},async cancel(){},async delete(){deleteCalled=true;await deleteGate.promise;}});
 await until(()=>pathCalled);assert.equal(spool.status().readers,1);let retired=false;const retiring=spool.retire().then(()=>retired=true);await until(()=>spool.status().writerClosed);assert.equal(retired,false);pathGate.resolve();await until(()=>deleteCalled);await assert.rejects(stat(path),missing);assert.equal(retired,false);assert.equal(spool.status().readers,1);deleteGate.resolve();await retiring;assert.equal(spool.status().readers,0);
 const ready=await h.run.downloadInfo(ticket.downloadId,context);assert.equal(ready.stage,'download-ready');assert.equal(ready.byteLength,3);assert.equal(JSON.stringify(ready).includes(root),false);await h.run.releaseDownload(ticket.downloadId,context);
});
