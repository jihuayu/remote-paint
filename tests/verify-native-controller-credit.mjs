// Hold the actual Mapper with a diagnostic resource wait; native credit still
// requires real Broker work/revocation. No synthetic credit is sent here.
import assert from 'node:assert/strict';
import net from 'node:net';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {NativeBroker} from '../native/broker.mjs';
import {NativeSubscription} from '../capture/subscription.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_CONTROLLER_CREDIT_OUTPUT??'artifacts/native-controller-credit';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-controller-credit-'),endpoint=directory+'/viz.sock',token=randomBytes(32).toString('hex');
const fixture=createServer((req,res)=>res.end('<!doctype html><style>html,body{margin:0;background:white}div{width:32px;height:32px;will-change:background-color}</style><div></div><script>window.ticks=0;function draw(){document.querySelector("div").style.backgroundColor=++ticks%2?"red":"blue";requestAnimationFrame(draw);}draw();</script>'));
const broker=new NativeBroker(),events=[],errors=[],checks=[],diagnostics={},ready=new Set(),trace=[],counts={map:0,publish:0};
let browser,page,driver,controller,socket,input=0,failure,reenter=false,reentered=false,drainedBeforeEnable=false;
const clean=s=>String(s).replaceAll(token,'[redacted]');broker.on('failure',e=>errors.push(clean(e.message)));broker.on('event',e=>{if(e.event==='VizReady'&&!e.error)ready.add(e.captureId);});
const request=broker.request.bind(broker);broker.request=(op,args)=>{
 if(op==='map'||op==='publish')counts[op]++;
 const work=request(op,args);
 if(reenter&&op==='nativePolicy'&&!args.enabled){reenter=false;work.then(()=>{reentered=true;controller.resume();}).catch(()=>{});}
 return work;
};
const until=async(fn,label)=>{const deadline=Date.now()+10000;while(!await fn()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0);assert.ok(Date.now()<deadline,`Timed out: ${label}`);await delay(5);}};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);};
const send=body=>new Promise((resolve,reject)=>socket.write(Buffer.concat([u32(body.length),body]),e=>e?reject(e):resolve()));
async function hold(id){
 await broker.request('expectViz',{captureId:id,resources:true});await send(Buffer.from(JSON.stringify({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:[0,0,320,180],quads:[]}]})));await until(()=>ready.has(id),'diagnosticVizReady');
 let settled=false;const mapping=broker.request('map',{capture:{captureId:id,nativeResources:true,viz:{native:true}},epoch:1,viewportVersion:1,viewport:{cssWidth:320,cssHeight:180,deviceScaleFactor:1}}).then(value=>{settled=true;return value;});mapping.catch(()=>{});
 return {mapping,settled:()=>settled,async release(){const metadata={captureId:id,producer:'controller-diagnostic',nativeResources:true,resources:[]};await send(Buffer.concat([Buffer.from('RPA2\x01\x01'),str(id),str(JSON.stringify(metadata)),u32(0)]));return mapping;}};
}
try{
 await broker.request('listenViz',{path:endpoint});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});page=await browser.newPage({viewport:{width:320,height:180}});driver=await startBeginFrames(page);await page.goto(`http://127.0.0.1:${fixture.address().port}`,{waitUntil:'commit'});
 controller=new NativeSubscription(page,{token,broker,frameDriver:driver,viewport:{width:320,height:180},interval:100,inputSeq:()=>input});controller.on('captureError',e=>errors.push(clean(e.stack)));controller.on('frame',e=>{events.push(e);assert.ok(events.length<128);});await controller.initialize();controller.setDemand(1);await until(()=>events.length>0,'initialnativeframe');
 const command=controller.commandIn.bind(controller);controller.commandIn=async(world,op,id,...args)=>{
  if(reentered&&op==='enable'&&args[0]){assert.ok(drainedBeforeEnable,'Resume enabled before native inflight drain');trace.push('reenable-after-native-drain');}
  const result=await command(world,op,id,...args);
  if(reentered&&op==='enable'&&!args[0])trace.push('native-disable-ACK');
  if(reentered&&op==='inspect'&&result.ok&&!result.inflight){drainedBeforeEnable=true;trace.push('native-inflight-false');}
  return result;
 };
 socket=net.createConnection(endpoint);socket.on('error',()=>{});await once(socket,'connect');const first=await hold('controller-credit-old');controller.requestCapture();let held;
 await until(async()=>{held=await controller.command('inspect',controller.binding.config.id);return held.awaitingCredit;},'actualnativeawaitingcredit');assert.equal(first.settled(),false);const delivered=events.at(-1).captureOrdinal,fence=await controller.fence();assert.equal(fence.captureOrdinal,held.lastStarted);assert.ok(fence.captureOrdinal>delivered);diagnostics.fence={delivered,fence: fence.captureOrdinal,inflight:true};checks.push('observationfence returnsactualnative encoding/inIPCordinal beyondlastpublishedcompactevent withoutrequestinganothercapture');
 const inputCdp=await page.context().newCDPSession(page);await inputCdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'7',code:'Digit7',windowsVirtualKeyCode:55});await inputCdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'7',code:'Digit7',windowsVirtualKeyCode:55});input=7;const started=performance.now();for(let n=0;n<1000;n++)controller.requestCapture();await controller.work;const updated=await controller.command('inspect',controller.binding.config.id);assert.equal(updated.lastStarted,held.lastStarted);assert.equal(updated.inputSeq,7);assert.ok(performance.now()-started<1500);const acks=driver.stats.acked;await delay(150);assert.ok(driver.stats.acked>acks);assert.equal(first.settled(),false);
 await first.release();await until(()=>events.some(e=>e.captureOrdinal===held.lastStarted),'oldnativeactualpublication');const old=events.find(e=>e.captureOrdinal===held.lastStarted);assert.equal(old.inputSeq,0);await until(()=>events.some(e=>e.captureOrdinal>held.lastStarted&&e.inputSeq===7),'newnativeinput7publication');const fresh=events.find(e=>e.captureOrdinal>held.lastStarted&&e.inputSeq===7);assert.ok(fresh.sourceFrame>=updated.minimumSourceFrame);diagnostics.input={oldOrdinal:old.captureOrdinal,oldInput:old.inputSeq,freshOrdinal:fresh.captureOrdinal,freshInput:fresh.inputSeq,sourceFrame:fresh.sourceFrame,minimumSourceFrame:updated.minimumSourceFrame};checks.push('1000coalescedcontrols progresswhileactualMapperheld;realkeyACKtheninput7 preservesoldjobinput0 andnextactualSourceFramefloor');
 const second=await hold('controller-credit-pause');controller.requestCapture();await until(async()=>{held=await controller.command('inspect',controller.binding.config.id);return held.awaitingCredit;},'secondactualcreditwait');const canceledOrdinal=held.lastStarted;
 reenter=true;await controller.suspend();await controller.work;assert.equal(reentered,true);assert.equal(drainedBeforeEnable,true);assert.ok(trace.indexOf('native-disable-ACK')<trace.indexOf('native-inflight-false'));assert.ok(trace.indexOf('native-inflight-false')<trace.indexOf('reenable-after-native-drain'));await second.release();await until(()=>events.some(e=>e.captureOrdinal>canceledOrdinal&&e.inputSeq===7&&e.resourcesComplete),'resumerealfullresources');assert.ok(!events.some(e=>e.captureOrdinal===canceledOrdinal));diagnostics.reentrantResume={canceledOrdinal,trace};checks.push('resume arrivingafterBrokerdisableACK butbeforenative disable/drain waitsforactualC++inflightfalse;revokedheldframe neverpublishes andresume forcesfullresources');
 assert.equal(counts.map,2,'Only two explicit diagnostic waits may use map');assert.equal(counts.publish,0);assert.deepEqual(errors,[]);
}catch(e){failure=clean(e.stack);}
finally{await controller?.close().catch(e=>errors.push(clean(e.stack)));socket?.destroy();await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});await broker.close();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});}
const report={at:new Date().toISOString(),status:failure||errors.length?'failed':'passed',scope:'ActualproductionNativeSubscription/privateIPC/Brokercredit/nativeordinalfence/inputwatermark/reentrantpause-resume. Twoexplicit diagnosticmapwaits;nosyntheticnativecredit. No pixels/defaultSource/fullSession claim.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),checks,diagnostics,events,counts,errors,clock:driver?.stats,cleanup:{exited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners},...(failure?{error:failure}:{})};await writeFile(output+'/credit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,diagnostics,counts,error:failure}));if(report.status!=='passed')throw new Error(failure??errors.join('\n'));
