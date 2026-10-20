// Historical renderer ownership is retained by proc-directory FDs until close.
import assert from 'node:assert/strict';
import {readdir,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startSessionMemoryFixture} from './session-memory-fixture.mjs';
import {createSessionMemoryOwner} from './session-memory-owner.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
assert.equal(process.platform,'linux');
const directory=resolve(process.env.REMOTE_PAINT_NAVIGATION_OWNER_OUTPUT??'artifacts/session-owner-navigation');await mkdir(directory,{recursive:true});
const fds=async()=>(await readdir('/proc/self/fd')).length,baselineFd=await fds();
let fixture,owner,browser,page,closed,failure;const witnesses=[],renderers=new Map(),cleanupErrors=[];
const started=performance.now(),identityKey=x=>x.pid+':'+x.startTicks;
async function pixels(n){const h=await page.waitForFunction(({n,number})=>{
 const source=document.querySelector('#viewport');if(!window.remotePaintResult)return false;let p=window.__navigationPixelProbe;if(!p){const canvas=document.createElement('canvas');canvas.width=3;canvas.height=1;p=window.__navigationPixelProbe={canvas,ctx:canvas.getContext('2d',{willReadFrequently:true})};}p.ctx.clearRect(0,0,3,1);for(const[i,[x,y]]of [[20,80],[400,30],[450,30]].entries())p.ctx.drawImage(source,x,y,1,1,i,0,1,1);const d=p.ctx.getImageData(0,0,3,1).data;return d[0]===(n&255)&&d[1]===(n>>8)&&d[2]===199&&d[4]===(n&255)&&d[5]===(n>>8)&&d[6]===199&&d[8]===(number&255)&&d[9]===(number>>8)&&d[10]===211;
 },{n,number:owner.number},{timeout:15000});await h.dispose();}
function renderer(sample){const row=sample.sourceProcesses.find(row=>String(row.pid)===sample.sourceState.producer?.split(':')[0]);assert.ok(row);renderers.set(identityKey(row.identity),row.identity);return row.identity;}
try{
 fixture=await startSessionMemoryFixture();owner=await createSessionMemoryOwner(fixture);browser=await launchCaptureBrowser();page=await browser.newPage();const url=new URL(owner.url);url.search='cpu&mainThread&memory=compact';await page.goto(url.href);await pixels(0);await owner.pin();renderer(await owner.measure());
 for(let n=1;n<=12;n++){
  const before=await owner.navigate(n,n%2?'localhost':'127.0.0.1');assert.equal(before.ownershipFence.ordinal,n);assert.equal(before.ownershipFence.producerIdentity.pid,Number(before.producer.split(':')[0]));renderers.set(identityKey(before.ownershipFence.producerIdentity),before.ownershipFence.producerIdentity);await pixels(n);
  const sample=await owner.measure(),current=renderer(sample);assert.ok(sample.sourceState.pageEpoch>before.epoch);assert.notEqual(sample.sourceState.nativeDocumentToken,before.documentToken);assert.notEqual(sample.sourceState.producer.split(':')[0],before.producer.split(':')[0]);assert.equal(sample.ownership.navigationPins,n);assert.deepEqual(sample.errors,[]);assert.deepEqual(sample.nodeCalls,{map:0,publish:0,awaitPromise:0});witnesses.push({cycle:n,before,after:{epoch:sample.sourceState.pageEpoch,documentToken:sample.sourceState.nativeDocumentToken,producer:sample.sourceState.producer,identity:current},ownership:sample.ownership,fdCount:await fds()});
 }
}catch(error){failure=error;}
finally{
 try{await browser?.close();}catch(e){cleanupErrors.push(e.stack);}
 try{closed=await owner?.close();assert.equal(closed?.status,'closed');assert.equal(closed.navigationPins,12);assert.deepEqual(closed.errors,[]);assert.deepEqual(closed.cleanupErrors,[]);assert.equal(closed.after.sourceProcesses.length,0);assert.equal(closed.after.metrics.pss.completeObservedCohort,true);assert.deepEqual(closed.after.metrics.cgroup.provenance.outsideObservedPids,[1]);const retired=new Map(closed.retired.map(row=>[identityKey(row),row]));assert.ok(renderers.size>=2);for(const[key,id]of renderers){assert.ok(retired.has(key),'An actually observed historical renderer was not retained through retirement');assert.deepEqual(retired.get(key).uids,id.uids);assert.ok(['ESRCH','ENOENT'].includes(retired.get(key).retirement));}}
 catch(e){cleanupErrors.push(e.stack);}
 try{await fixture?.close();}catch(e){cleanupErrors.push(e.stack);}
}
let afterFd=await fds();for(let n=0;n<100&&afterFd>baselineFd+2;n++){await delay(10);afterFd=await fds();}if(afterFd>baselineFd+2)cleanupErrors.push('Controller FD did not return after closing all historical ownership probes');
const report={at:new Date().toISOString(),status:failure||cleanupErrors.length?'failed':'passed',scope:'Actual formal Linux native Source/CPUmain Viewer;12 true crosssite replacements,all actually observed renderer PID/start identities pinned before navigation and retained until actual ESRCH/ENOENT after close. No assumption of13 unique renderer PIDs;reuse remains identity-checked. Not physical8h/fullN1.',elapsedSeconds:(performance.now()-started)/1000,baselineFd,afterFd,witnesses,historicalRendererIdentities:[...renderers.values()],closed,cleanupErrors,error:failure?.stack};await writeFile(join(directory,'navigation-owner.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,crosssites:witnesses.length,historicalRenderers:renderers.size,retired:closed?.retired.length,baselineFd,afterFd,cleanupErrors:cleanupErrors.length}));if(report.status!=='passed')throw failure??new Error('Navigation ownership cleanup failed');
