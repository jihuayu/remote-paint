// External Agent connection to the container's existing source target.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const endpoint=new URL(process.argv[2]);
const expectedTarget=process.argv[3];
assert.equal(endpoint.hostname,'127.0.0.1');
assert.match(expectedTarget,/^[a-f0-9]{16,64}$/i);
const version=await (await fetch(new URL('/json/version',endpoint),{signal:AbortSignal.timeout(5000)})).json();
assert.match(version.webSocketDebuggerUrl,/^ws:\/\/127\.0\.0\.1:/);
const browser=await chromium.connectOverCDP(endpoint.href,{timeout:15000});
let source;
try{
 for(const context of browser.contexts())for(const page of context.pages()){
  const session=await context.newCDPSession(page);
  try{if((await session.send('Target.getTargetInfo')).targetInfo.targetId===expectedTarget)source=page;}
  finally{await session.detach();}
 }
 assert.ok(source,'Agent must attach to the existing Remote Paint Source, not open a new page');
 await source.goto('data:text/html,'+encodeURIComponent('<title>Remote Paint CDP proof</title><button onclick="document.body.dataset.clicked=\'yes\'">Agent click</button><script>window.ticks=0;function tick(){ticks++;requestAnimationFrame(tick)};tick()</script>'));
 await source.getByRole('button',{name:'Agent click'}).click();
 await source.waitForFunction(()=>document.body.dataset.clicked==='yes'&&window.ticks>=5);
 const png=await source.screenshot();assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
}finally{await browser.close();}
const targets=await (await fetch(new URL('/json/list',endpoint),{signal:AbortSignal.timeout(5000)})).json();
assert.ok(targets.some(t=>t.id===expectedTarget&&t.title==='Remote Paint CDP proof'),'Disconnecting the Agent must preserve the managed Source');
await mkdir('smoke-artifacts',{recursive:true});
const report={verifiedAt:new Date().toISOString(),platform:process.platform,cpu:process.arch,sourceTargetId:expectedTarget,existingSource:true,navigation:true,click:true,unattendedAnimation:true,screenshot:true,disconnectPreservesSource:true};
await writeFile('smoke-artifacts/container-cdp.json',JSON.stringify(report,null,2)+'\n');console.log(report);
