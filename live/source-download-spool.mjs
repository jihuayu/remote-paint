// Server-owned directory for the original, locally launched Source browser.
// The original local Browser process must acknowledge close as well as its
// Playwright facade. This is not whole-process namespace retirement proof or
// a Chromium pre-write byte budget.
import {ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {constants} from 'node:fs';
import {lstat,mkdtemp,open,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const pages=new WeakMap();
const failure=()=>Object.assign(new Error('Source download spool cleanup is unconfirmed'),{code:'SOURCE_DOWNLOAD_SPOOL_FAILED'});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid;
const localPlaywrightVersion=createRequire(import.meta.url)('playwright-core/package.json').version;

function observeLocalProcess(browser,root){
 // In-process driver only; a remote connection or a changed driver shape is
 // not authority to claim that the original local writer has exited.
 if(localPlaywrightVersion!=='1.64.1')throw failure();
 const impl=browser?._connection?.toImpl?.(browser),process=impl?.options?.browserProcess?.process;
 if(impl?.options?.originalLaunchOptions?.downloadsPath!==root||!(process instanceof ChildProcess)||!Number.isSafeInteger(process.pid)||process.pid<=0||process.exitCode!==null||process.signalCode!==null)throw failure();
 let onClose;const wait=new Promise(resolve=>{onClose=()=>resolve();process.once('close',onClose);});
 return {wait,detach:()=>process.off('close',onClose)};
}

export async function createSourceDownloadSpool({observeProcess=observeLocalProcess}={}){
 const root=await mkdtemp(join(await realpath(tmpdir()),'remote-paint-download-'));
 let directory;
 try{
  directory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  await directory.chmod(0o700);
  const identity=await directory.stat();
  if(!identity.isDirectory()||(identity.mode&0o777)!==0o700||!same(identity,await lstat(root)))throw failure();
  let browser=null,closeBrowserMethod=null,isConnected=null,removeListener=null,onDisconnected=null,processExit=null;
  let launchStarted=false,launchSettled=null,closeRequested=false,closePromise=null,retiring=null;
  let pageBound=false,readers=0,drain=null,resolveDrain=null,writerClosed=false,browserProcessExited=false,pathRemoved=false,handleClosed=false,uncertain=false,cleanupFailed=false;
  const unconfirmed=()=>{uncertain=true;cleanupFailed=true;};
  const acquire=()=>{
   if(closeRequested||retiring||uncertain)throw failure();
   if(readers++===0)drain=new Promise(resolve=>{resolveDrain=resolve;});
   let settled=false;
   const settle=confirmed=>{
    if(settled)return;settled=true;if(!confirmed)unconfirmed();
    if(--readers===0){const resolve=resolveDrain;resolveDrain=null;drain=null;resolve();}
   };
   return Object.freeze({closed:()=>settle(true),uncertain:()=>settle(false)});
  };
  const closeBrowser=()=>{
   if(closePromise)return closePromise;
   // Prevent new local readers before asking the browser to stop its writes.
   closeRequested=true;
   closePromise=(async()=>{
    await launchSettled;
    if(!launchStarted){writerClosed=true;return;}
    let timer;
    try{
     if(!closeBrowserMethod)throw failure();
     // Even a missing exit capability must still attempt the known Browser's
     // real close. Its unconfirmed result cannot authorize path removal.
     await Promise.race([Promise.all([closeBrowserMethod(),processExit?.wait??Promise.reject(failure())]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure()),30000);})]);
     browserProcessExited=true;if(isConnected())unconfirmed();
    }
    catch{unconfirmed();}
    finally{
     clearTimeout(timer);
     try{removeListener?.('disconnected',onDisconnected);}catch{unconfirmed();}
     try{processExit?.detach();}catch{unconfirmed();}
     browser=null;closeBrowserMethod=null;isConnected=null;removeListener=null;onDisconnected=null;processExit=null;
    }
    if(uncertain)throw failure();writerClosed=true;
   })();
   return closePromise;
  };
  return Object.freeze({
   launch(factory){
    if(launchStarted||closeRequested||retiring||typeof factory!=='function')throw failure();
    launchStarted=true;
    // Own the pending launch before the factory can run or reenter cleanup.
    const work=Promise.resolve().then(()=>factory(root)).then(value=>{
     try{
      if(!value||typeof value.close!=='function'||typeof value.isConnected!=='function'||typeof value.on!=='function'||typeof value.off!=='function')throw failure();
      browser=value;closeBrowserMethod=value.close.bind(value);isConnected=value.isConnected.bind(value);removeListener=value.off.bind(value);
      onDisconnected=()=>{if(!closeRequested)unconfirmed();};
      value.on('disconnected',onDisconnected);
      if(!isConnected())throw failure();
      processExit=observeProcess(value,root);
      if(!processExit||!(processExit.wait instanceof Promise)||typeof processExit.detach!=='function')throw failure();
      return value;
     }catch{unconfirmed();throw failure();}
    },()=>{unconfirmed();throw failure();});
    // Do not retain the fulfilled launch Promise's Browser object graph.
    launchSettled=work.then(()=>undefined,()=>undefined);
    return work;
   },
   bindPage(page){
    if(pageBound||!browser||closeRequested||retiring||pages.has(page)||page?.context?.().browser()!==browser)throw failure();
    pages.set(page,acquire);pageBound=true;
   },
   closeBrowser,
   retire(){
    if(retiring)return retiring;
    retiring=(async()=>{
     try{
      await closeBrowser();
      if(drain)await drain;
      if(uncertain||!writerClosed)throw failure();
      const held=await directory.stat();
      if(!same(held,identity)||!held.isDirectory())throw failure();
      const current=await lstat(root);
      if(!current.isDirectory()||!same(current,identity))throw failure();
      await rm(root,{recursive:true});
      // APFS can keep the original link count on an unlinked directory FD.
      // Require our own identity-checked removal and confirm path absence.
      // An already missing path before removal could be a renamed original.
      try{await lstat(root);throw failure();}catch(error){if(error.code!=='ENOENT')throw error;}
      pathRemoved=true;
     }catch{unconfirmed();}
     finally{
      try{await directory.close();handleClosed=true;}catch{unconfirmed();}
      directory=null;
     }
     if(cleanupFailed)throw failure();
    })();
    return retiring;
   },
   status:()=>Object.freeze({launchStarted,closeRequested,writerClosed,browserProcessExited,readers,pathRemoved,handleClosed,uncertain,cleanupFailed})
  });
 }catch{
  // No browser has received this path, but an unpinned/replaced directory is
  // still not authority to recursively delete a path supplied by a race.
  try{await directory?.close();}catch{}
  throw failure();
 }
}

// Test/embedded Pages without a Source owner retain the existing reader path.
// Only startLiveSource can associate its exact original Page with this owner.
export function acquireSourceDownloadReader(page){return pages.get(page)?.();}
