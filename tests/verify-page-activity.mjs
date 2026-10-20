import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {startLiveSource} from '../live/source.mjs';

assert.equal(process.platform,'linux','Real external BeginFrame source required');
const fixture=createServer((req,res)=>res.end('<!doctype html><meta charset="utf-8"><h1>Page activity</h1><script>window.ticks=0;requestAnimationFrame(function tick(){window.ticks++;requestAnimationFrame(tick);});</script>'));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let source;
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`});
 source.setDemand(0);await source.frameDriver.stop();
 const sample=()=>source.page.evaluate(()=>window.ticks),initial=await sample();await delay(150);assert.equal(await sample(),initial);
 const releaseFirst=source.acquirePageActivity(),releaseSecond=source.acquirePageActivity();assert.equal(source.activityDemand,2);
 await delay(250);const active=await sample();assert.ok(active>initial);assert.equal(source.stats.captures,0,'Agent-only activity must not serialize display scenes');
 releaseFirst();releaseFirst();assert.equal(source.activityDemand,1);await delay(100);assert.ok(await sample()>active,'One consumer cannot release another activity');
 await source.resize({width:800,height:600});assert.equal(source.demand,0);assert.equal(source.activityDemand,1);assert.equal(source.frameDriver.running,true);
 const resized=await sample();await delay(150);assert.ok(await sample()>resized,'Agent clock must resume after resize without a Viewer');assert.equal(source.stats.captures,0);
 releaseSecond();await source.frameDriver.stop();const stopped=await sample();await delay(150);assert.equal(await sample(),stopped);assert.equal(source.activityDemand,0);
 source.setDemand(1);const releaseViewerOverlap=source.acquirePageActivity();releaseViewerOverlap();assert.equal(source.frameDriver.running,true,'Releasing Agent activity must not stop visible consumers');
 const deadline=Date.now()+5000;while(!source.stats.captures&&Date.now()<deadline)await delay(20);assert.ok(source.stats.captures>0);
 source.setDemand(0);await source.capture.drain();await source.frameDriver.stop();const noViewers=source.stats.captures;await delay(150);assert.equal(source.stats.captures,noViewers);assert.equal(source.frameDriver.running,false);
 const releaseBeforeClose=source.acquirePageActivity(),stats={...source.frameDriver.stats};await source.close();assert.equal(source.activityDemand,0);releaseBeforeClose();assert.throws(()=>source.acquirePageActivity(),/closed/);assert.equal(source.frameDriver.running,false);
 const report={at:new Date().toISOString(),scope:'Actual custom Linux Chromium external BeginFrame; real rAF paused/resumed under independent display and Agent leases, Agent-only resize and zero display serialization. Explicit caller-owned activity API; not automatic inference of all external CDP clients.',initial,active,stopped,independentLeases:true,agentOnlyCaptures:0,agentResizeResumed:true,displaySurvivesAgentRelease:true,lastDisplayStopsCaptures:true,lateReleaseAfterCloseSafe:true,stats,status:'passed'};
 source=null;await mkdir('artifacts/lifecycle',{recursive:true});await writeFile('artifacts/lifecycle/page-activity.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await source?.close();await new Promise(resolve=>fixture.close(resolve));}
