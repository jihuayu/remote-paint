// Real Linux NativeSource; an explicit test barrier holds the actual retired
// subscription during resize. No scheduler response or kernel proof is mocked.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {startLiveSource} from '../live/source.mjs';
import {createLinuxSourceClockProbe} from './linux-source-clock.mjs';

assert.equal(process.platform,'linux');assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
const directory=process.env.REMOTE_PAINT_CLOCK_REBIND_OUTPUT??'artifacts/linux-source-clock-rebind';await mkdir(directory,{recursive:true});
const fixture=createServer((_request,response)=>response.end('<!doctype html><style>body{margin:0;background:rgb(31,79,191)}</style><canvas width=32 height=32></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="rgb(43,161,89)";c.fillRect(0,0,32,32)</script>'));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const errors=[],checks=[],probes=[],rejectedProbes=[],transitions=[],identities=new Map();let source,releaseHold,held=false,phase='startup',failure,cleanup;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function until(predicate,label){const end=performance.now()+12000;while(!await predicate()){assert.deepEqual(errors,[]);assert.ok(performance.now()<end,label);await delay(5);}}
function context(){return {bindingId:source.capture.binding?.config.id??null,producer:source.producer,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,documentToken:source.nativeDocumentToken,transitioning:source.transitioning};}
async function processStart(pid){try{const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}}
async function pinProcesses(){const cdp=await source.browser.newBrowserCDPSession();try{const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');for(const row of processInfo){const pid=Number(row.id),start=await processStart(pid);if(start)identities.set(pid+':'+start,{pid,start});}}finally{await cdp.detach();}const pid=source.broker.child.pid,start=await processStart(pid);if(start)identities.set(pid+':'+start,{pid,start});}
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:320,height:180}});source.on('captureError',error=>errors.push(error.message));source.setDemand(1);
 await until(()=>source.latest&&source.producer&&!source.transitioning,'actual first NativeFrame');assert.equal(source.nativeAutopublish,true);await pinProcesses();
 const probe=createLinuxSourceClockProbe(()=>source);probes.push(await probe());
 const retire=source.capture.retire.bind(source.capture),barrier=new Promise(resolve=>releaseHold=resolve);let holdNext=true;
 source.capture.retire=async()=>{await retire();if(holdNext){holdNext=false;held=true;await barrier;}};
 phase='held-resize';const initial=context();await source.resize({width:384,height:200});await until(()=>held,'actual resize retirement barrier');
 transitions.push({phase,before:initial,held:context()});assert.equal(source.capture.binding,null);assert.equal(source.producer,null);assert.equal(source.viewportVersion,initial.viewportVersion+1);
 let settled=false;const started=performance.now(),pending=probe().then(value=>{settled=true;return {value};},error=>{settled=true;return {error:error.stack};});
 await delay(120);const settledBeforeRelease=settled;releaseHold();const result=await pending;
 transitions.at(-1).probe={settledBeforeRelease,elapsedMs:performance.now()-started,error:result.error??null};
 assert.equal(settledBeforeRelease,false,'Probe rejected or accepted before the actual rebind became ready');assert.equal(result.error,undefined);probes.push(result.value);
 assert.equal(result.value.viewportVersion,initial.viewportVersion+1);assert.notEqual(result.value.provenance.bindingId,initial.bindingId);checks.push('Probe waits across actual missing binding/producer after acknowledged resize; same original5s total limit and real process/namespace/clock proof');
 source.capture.retire=retire;
 phase='immediate-resize-probes';
 for(let i=0;i<12;i++){
  await source.resize({width:i%2?384:400,height:200});const before=context(),started=performance.now(),value=await probe();
  assert.equal(value.viewportVersion,before.viewportVersion);assert.equal(value.pageEpoch,before.pageEpoch);assert.ok(performance.now()-started<=5000);probes.push(value);transitions.push({phase,before,after:context()});
 }
 checks.push('Twelve immediate probes after real resize completion acquire the fresh actual binding/producer without a caller sleep');
 phase='crosssite-probe';const oldEpoch=source.pageEpoch;await source.page.goto(`http://localhost:${fixture.address().port}/next`,{waitUntil:'commit'});const navigated=await probe();assert.equal(navigated.pageEpoch,oldEpoch+1);probes.push(navigated);await pinProcesses();checks.push('Immediate crosssite probe pins current renderer start identity and time namespace in the new document');
 phase='changed-during-probe';const command=source.capture.command.bind(source.capture);let changeOnce=true;
 source.capture.command=async(operation,...args)=>{const reply=await command(operation,...args);if(operation==='scheduler'&&changeOnce){changeOnce=false;await source.resize({width:416,height:200});}return reply;};
 await assert.rejects(probe(),error=>{rejectedProbes.push({phase,message:error.message,diagnostic:error.clockProbe});return /Source clock context changed during identity probe/.test(error.message);});source.capture.command=command;checks.push('Actual viewport change after scheduler response still rejects the in-flight proof; readiness acquisition does not weaken identity fences');
 probes.push(await probe());await pinProcesses();assert.deepEqual(errors,[]);assert.equal(source.stats.errors,0);
 phase='held-readiness-deadline';const deadlineBarrier=new Promise(resolve=>releaseHold=resolve);holdNext=true;held=false;
 source.capture.retire=async()=>{await retire();if(holdNext){holdNext=false;held=true;await deadlineBarrier;}};
 await source.resize({width:432,height:200});await until(()=>held,'actual deadline retirement barrier');const deadlineStarted=performance.now();
 try{await assert.rejects(probe(),error=>{rejectedProbes.push({phase,elapsedMs:performance.now()-deadlineStarted,message:error.message,diagnostic:error.clockProbe});return error.clockProbe?.stage==='acquiring-context'&&error.clockProbe.acquisition.last.bindingId===null&&error.cause?.name==='AbortError';});}finally{releaseHold();source.capture.retire=retire;}
 probes.push(await probe());checks.push('An actually held Native rebind times out under the original5s budget without accepting a proof; releasing it allows a fresh real identity/clock proof');
 for(const value of probes){assert.equal(value.provenance.linuxMonotonic.interval.integerStampAllowanceNs,1000);assert.equal(value.provenance.producer.split(':')[0],String(value.provenance.linuxMonotonic.rendererIdentity.pid));}
 phase='complete';
}catch(error){failure=error.stack;}
finally{
 releaseHold?.();const closeErrors=[];try{await source?.close();}catch(error){closeErrors.push(error.message);}await new Promise(resolve=>fixture.close(resolve));
 try{await until(async()=>{for(const row of identities.values())if(await processStart(row.pid)===row.start)return false;return true;},'actual Native process identities retired');}catch(error){closeErrors.push(error.message);}
 cleanup={closeErrors,retiredProcesses:identities.size,browserConnected:source?.browser.isConnected(),brokerExited:source?.broker.exited,pending:source?.broker.pending.size,requestOwners:source?.broker.requestMemory.stats().owners,responseOwners:source?.broker.responses.stats().owners,bindingPresent:!!source?.capture.binding,fixtureListening:fixture.listening};
 try{assert.deepEqual(cleanup,{closeErrors:[],retiredProcesses:identities.size,browserConnected:false,brokerExited:true,pending:0,requestOwners:0,responseOwners:0,bindingPresent:false,fixtureListening:false});assert.ok(identities.size>=3);}catch(error){failure??=error.stack;}
}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Linux NativeSource clock acquisition across explicit retirement barrier,12 immediate resize probes,crosssite document change,in-flight mutation rejection,real readiness deadline and observed process cleanup. No synthetic native clock or process proof; not Viewer frame age,physical scanout,8h acceptance or sole-cause proof for the earlier8h failure.',phase,checks,probes,rejectedProbes,transitions,errors,cleanup,versions:{browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))},...(failure?{error:failure}:{})};
await writeFile(directory+'/clock-rebind.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,phase,checks:checks.length,probes:probes.length,cleanup,error:failure}));if(failure)throw new Error(failure);
