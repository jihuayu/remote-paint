// Actual >=9MiB Source SKPs and Viewer Worker pixels, with real kernel TCP
// impairment. Local raw-window/ACK and 200ms close contracts stay separate.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {startFrameAgeLive,installFrameAgeObserver,beginFrameAge,finishFrameAge,frameAgeDistribution,observeFrameLoss} from './frame-age-observer.mjs';

assert.equal(process.platform,'linux');
assert.equal(process.env.REMOTE_PAINT_NETEM,'1','Use a task-owned disposable CAP_NET_ADMIN container');
assert.equal(process.env.REMOTE_PAINT_BULK_ISOLATED,'1');
assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
assert.equal(process.env.REMOTE_PAINT_TILED_CAPTURE??'1','1','Keep default tiled capture');
const output=process.env.REMOTE_PAINT_SOURCE_BULK_FRAME_AGE_OUTPUT??'artifacts/native-source-bulk-frame-age';await mkdir(output,{recursive:true});
const cases=JSON.parse(process.env.REMOTE_PAINT_BULK_NETWORK_CASES??JSON.stringify([[0,0,20],...[20,40,80,150].flatMap(r=>[.5,1,2].map(l=>[r,l,20])),[80,1,2]]));
const inputCount=1000,inputIntervalMs=25,inputAckMs=3000;
const minimum=9*1024*1024,finalMarker=[inputCount>>>8,inputCount&255,42,255],colors=[[31,79,191,255],[43,161,89,255]];
const html=`<!doctype html><style>body{margin:0;background:white}#bulk{position:absolute;left:20px;top:100px;width:512px;height:512px}input{position:absolute;left:20px;top:20px;width:280px;height:40px}#counter{position:absolute;left:600px;top:20px;width:24px;height:24px;background:rgb(0,0,42)}</style><canvas id=bulk width=64 height=64></canvas><input id=name><div id=counter></div><script>
const canvas=document.querySelector('canvas');window.draw=()=>{canvas.width=canvas.height=1792;const ctx=canvas.getContext('2d'),image=ctx.createImageData(1792,1792);let random=2;for(let i=0;i<image.data.length;i+=4){random^=random<<13;random^=random>>>17;random^=random<<5;image.data[i]=random&255;image.data[i+1]=(random>>>8)&255;image.data[i+2]=(random>>>16)&255;image.data[i+3]=255;}for(const [x,y]of [[0,0],[880,880],[1760,1760]])for(let dy=0;dy<32;dy++)for(let dx=0;dx<32;dx++)image.data.set([43,161,89,255],((y+dy)*1792+x+dx)*4);ctx.putImageData(image,0,0);};const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(31,79,191)';ctx.fillRect(0,0,64,64);document.querySelector('input').oninput=e=>{const n=e.target.value.length;document.querySelector('#counter').style.background='rgb('+(n>>>8)+','+(n&255)+',42)';};window.ticks=0;requestAnimationFrame(function step(){ticks++;requestAnimationFrame(step);});</script>`;
const fixture=createServer((req,res)=>res.end(html));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const tc=(...args)=>execFileSync(process.env.REMOTE_PAINT_TC??'tc',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
function clear(){try{tc('qdisc','del','dev','lo','root');}catch{}}
function impair(port,rtt,loss,rate){
 tc('qdisc','add','dev','lo','root','handle','1:','prio','bands','3','priomap',...Array(16).fill('0'));
 tc('qdisc','add','dev','lo','parent','1:3','handle','30:','netem','limit','1000','delay',`${rtt/2}ms`,`${rtt/20}ms`,'loss',`${loss}%`,'rate',`${rate}mbit`);
 for(const direction of ['sport','dport'])tc('filter','add','dev','lo','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol','6','0xff','match','ip',direction,String(port),'0xffff','flowid','1:3');
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const versions={browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))};
const browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,args:['--no-sandbox']});
const results=[];let live,context,progress,sourceErrors,pageErrors,nodeCalls,nativeReceipts,lastPage,lossObservation;
async function until(fn,label,timeout=15000){const end=performance.now()+timeout;while(!await fn()){assert.deepEqual(sourceErrors,[]);assert.deepEqual(pageErrors,[]);assert.ok(performance.now()<end,label);await delay(5);}}
async function kernelTx(port){const text=await readFile('/proc/net/tcp','utf8');return text.trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/)).filter(f=>parseInt(f[1].split(':')[1],16)===port&&f[3]==='01').map(f=>({remotePort:parseInt(f[2].split(':')[1],16),bytes:parseInt(f[4].split(':')[0],16)}));}
function tcpInfo(port){return execFileSync(process.env.REMOTE_PAINT_SS??'/usr/bin/ss',['-tin','sport','=',`:${port}`],{encoding:'utf8'});}
async function cleanup(){
 lossObservation?.close();lossObservation=null;clear();const errors=[];for(const close of [()=>context?.close(),()=>live?.close()])try{await close();}catch(e){errors.push(e.message);}
 const cleanup=live?{brokerExited:live.source.broker.exited,pending:live.source.broker.pending.size,requestOwners:live.source.broker.requestMemory.stats().owners,responseOwners:live.source.broker.responses.stats().owners,browserConnected:live.source.browser.isConnected(),errors}:null;
 context=null;live=null;return cleanup;
}
const scope='Actual default autonomous NativeSource/defaulttiled1792Canvas genuine>=9MiB SKP/privateIPC/nativeGateway/realViewerWorker CanvasKit pixels and1000actual paired-control CDP inputsat25ms,retainingthefirst16ACKchecks. Kernel netem matches Gateway TCP in both directions:configuredCases(default13RTT/loss/jitter20Mbit profiles plus80ms1%2Mbit). SourceCDP excluded. Default5s post-commit ACK,15s resource progress inactivity,32KiB chunks and3s input ACK gates unchanged; original network bulk90s whole-transfer gate. Local raw16MiB/ACK1.5s and200ms close are separateacceptedcontracts; cleanup removesimpairment anddoesnotclaimweaknetwork200ms close/fullN1. Adds exact-frameactualCPUWorker pixels/nativeTake-start/requiredresource sum-max-count andbefore-afterNode/native/Worker calibrationintervals/quantization/explicitaffinedriftassumption. Allsuccessfulcommitscovered,actual>=9MiBgreen subset reportedwithcount;pixelreadcostonly measured,nottotalobserveroverhead orphysicalscanout/GPU.';
try{
 for(const [rtt,loss,rate]of cases){
  progress={rtt,loss,rate,phase:'startup'};sourceErrors=[];pageErrors=[];nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};nativeReceipts=[];
  live=await startFrameAgeLive({port:0,url:`http://127.0.0.1:${fixture.address().port}`,points:[[22,102],[276,356],[528,608],[612,32]]});assert.equal(live.source.nativeAutopublish,true);lossObservation=observeFrameLoss(live.source,live.peers);
  live.source.on('captureError',e=>sourceErrors.push({message:e.message,code:e.code}));
  live.source.on('frame',f=>{if(nativeReceipts.length>=2048)throw new Error('Verifier native receipt bound');nativeReceipts.push({at:performance.now(),...f});});
  const request=live.source.broker.request.bind(live.source.broker);live.source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};
  const send=live.source.capture.cdp.send.bind(live.source.capture.cdp);live.source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
  context=await browser.newContext({viewport:{width:1100,height:900}});const page=await context.newPage();lastPage=page;page.on('pageerror',e=>pageErrors.push(e.message));const observerProvenance=await installFrameAgeObserver(page,live.observerProvenance);
  await page.addInitScript(()=>{window.bulkInputAcks=[];window.bulkInputAckBySeq=new Map();const Socket=WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(typeof data!=='string')return;const m=JSON.parse(data);if(m.type==='InputAck'){if(window.bulkInputAcks.length>=2048)throw new Error('Verifier input ACK bound');if(window.bulkInputAckBySeq.has(m.seq))throw new Error('Duplicate actual input ACK');const ack={seq:m.seq,accepted:m.accepted,stage:m.stage,at:performance.now(),beforeLargeCommit:(window.remotePaintResult?.resourceBytes??0)<9*1024*1024};window.bulkInputAcks.push(ack);window.bulkInputAckBySeq.set(m.seq,ack);}});}};});
  const origins=[];page.on('request',request=>{if(origins.length>=128)throw new Error('Verifier origin bound');origins.push(new URL(request.url()).origin);});
  const viewerUrl=new URL(live.url);viewerUrl.searchParams.set('cpu','1');await page.goto(viewerUrl.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);assert.equal(await page.evaluate(()=>window.remotePaintResult.worker&&window.remotePaintResult.presentation.mode==='cpu-2d'),true);
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
  const bounds=await page.locator('#viewport').boundingBox();await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);
  await live.source.page.waitForFunction(()=>document.activeElement.id==='name');await page.waitForFunction(seq=>window.remotePaintResult.lastProcessedInputSeq>=seq,live.source.inputSeq);
  const initialGeneration=await page.evaluate(()=>window.remotePaintResult.connectionGeneration);
  const peer=[...live.peers].find(p=>p.id===live.source.control.holder);assert.ok(peer);
  const port=Number(new URL(live.streamOrigin).port),ageWindow=await beginFrameAge(live.source,page),lossBefore=lossObservation.snapshot();impair(port,rtt,loss,rate);
  progress.phase='bulk';const bulkStarted=performance.now(),clock=live.source.frameDriver.stats.acked;
  await live.source.page.evaluate(()=>window.draw());live.source.requestFreshFrame();
  await until(()=>nativeReceipts.some(f=>f.rawResourceBytes>=minimum),'Genuine>=9MiB native capture receipt');
  await until(()=>(peer.stats.maxPendingBytes??0)>=minimum,'Genuine>=9MiB native Gateway pending frame');
  let heldAt,txPeak=0;await until(async()=>{const bytes=Math.max(0,...(await kernelTx(port)).map(q=>q.bytes));txPeak=Math.max(txPeak,bytes);if(bytes){heldAt??=performance.now();return performance.now()-heldAt>=50;}heldAt=undefined;return false;},'Real TCP transmit queue persists50ms');
  progress.phase='input';const tcpDuringBulk=tcpInfo(port);
  const inputBase=live.source.inputSeq;
  const inputExposure=await page.evaluate(async({base,count,interval,ackMs})=>{
   const inputs=[],starts=[],proxy=document.querySelector('#inputProxy');let maxOutstanding=0;
   const consume=()=>{
    while(inputs.length<starts.length){
     const index=inputs.length,seq=base+index+1,ack=window.bulkInputAckBySeq.get(seq);if(!ack)break;
     const ms=ack.at-starts[index];if(!ack.accepted||ack.stage!=='input-injected'||ms<0||ms>=ackMs)throw new Error('Actual input ACK rejected or exceeded3s');
     inputs.push({...ack,ms});
    }
    if(inputs.length<starts.length&&performance.now()-starts[inputs.length]>=ackMs)throw new Error('Actual input ACK blocked behind>=9MiB transfer');
   };
   for(let n=0;n<count;n++){
    starts.push(performance.now());proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));
    consume();maxOutstanding=Math.max(maxOutstanding,starts.length-inputs.length);await new Promise(resolve=>setTimeout(resolve,interval));consume();
   }
   while(inputs.length<count){consume();if(inputs.length<count)await new Promise(resolve=>setTimeout(resolve,5));}
   return {inputs,sent:starts.length,maxOutstanding,configuredIntervalMs:interval,dispatchSpanMs:starts.at(-1)-starts[0],first16:inputs.slice(0,16)};
  },{base:inputBase,count:inputCount,interval:inputIntervalMs,ackMs:inputAckMs});
  const {inputs}=inputExposure;
  assert.equal(inputs.length,inputCount);assert.equal(inputExposure.sent,inputCount);assert.equal(inputExposure.first16.length,16);
  assert.deepEqual(inputExposure.first16,inputs.slice(0,16));assert.ok(inputs.every((a,i)=>a.seq===inputBase+i+1&&a.accepted&&a.stage==='input-injected'&&a.ms<inputAckMs));assert.ok(inputExposure.first16.some(a=>a.beforeLargeCommit),'Originalfirst16 real input confirmations must precede large-image commit');
  assert.equal(await live.source.page.locator('input').inputValue(),'x'.repeat(inputCount));assert.equal(live.source.inputSeq,inputBase+inputCount);assert.ok(live.source.frameDriver.stats.acked>clock);
  progress.phase='pixels';const seq=live.source.inputSeq,remaining=90000-(performance.now()-bulkStarted);assert.ok(remaining>0,'Original90s bulk transfer bound');
  await page.waitForFunction(({seq,minimum,finalMarker})=>{
   const f=window.remotePaintResult;if(!f?.worker||f.resourceBytes<minimum||f.lastProcessedInputSeq<seq)return false;
   const canvas=document.querySelector('canvas'),s=document.createElement('canvas');s.width=s.height=1;const ctx=s.getContext('2d',{willReadFrequently:true});
   const pixel=(x,y)=>{ctx.drawImage(canvas,x,y,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
   return [[22,102],[276,356],[528,608]].every(([x,y])=>JSON.stringify(pixel(x,y))==='[43,161,89,255]')&&JSON.stringify(pixel(612,32))===JSON.stringify(finalMarker);
  },{seq,minimum,finalMarker},{timeout:remaining});
  const completedAt=performance.now(),viewer=await page.evaluate(()=>window.remotePaintResult),tcpAfterPixels=tcpInfo(port),network=JSON.parse(tc('-s','-j','qdisc','show','dev','lo')),lossAfterTransfer=lossObservation.snapshot();
  progress.phase='frame-age';const frameAge=await finishFrameAge(live.source,page,ageWindow,observerProvenance),lossAfter=lossObservation.snapshot();assert.equal(frameAge.provenance.diagnosticFaults,false);assert.equal(frameAge.protocol.counts.diagnosticFaults,0);
  const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
  for(const sample of frameAge.samples){
   const tag=colors.findIndex(c=>same(sample.pixels[0],c));assert.ok(tag>=0,'Every observed frame has a real blue or green texture');
   assert.ok(sample.pixels.slice(0,3).every(p=>same(p,colors[tag])),'Exact-frame three texture samples remain consistent');
   assert.ok(sample.pixels[3][0]*256+sample.pixels[3][1]<=inputCount&&sample.pixels[3][2]===42&&sample.pixels[3][3]===255,'Exact-frame input-counter pixel');
   assert.equal(sample.connectionGeneration,initialGeneration,'No hidden reconnect during observed bulk window');
  }
  const largeSamples=frameAge.samples.filter(s=>s.largestRequiredResourceBytes>=minimum&&same(s.pixels[0],colors[1]));assert.ok(largeSamples.length>0,'At leastone observedgreen frame actually requires a single>=9MiB resource');
  assert.ok(largeSamples.some(s=>s.inputSeq>=seq&&same(s.pixels[3],finalMarker)),'Actual>=9MiB required resource,threegreen texture pixels,input1000 watermark and marker belong to the same measured frame');
  const largeFrameAge={scope:'Subset of all covered commits whose actual required FrameGate payload includes one>=9MiB resource andwhose threeactualtexturepixels aregreen. Count reported;small samples do not establishanSLA. Timestamp is rootframe Take,not timeoflastchangeofeverycachedresource.',count:largeSamples.length,windowOrdinals:largeSamples.map(s=>s.windowOrdinal),age:frameAgeDistribution(largeSamples.map(s=>s.age.estimateMs)),ageLower:frameAgeDistribution(largeSamples.map(s=>s.age.lowerMs)),ageUpper:frameAgeDistribution(largeSamples.map(s=>s.age.upperMs)),largestRequiredResourceBytes:Math.max(...largeSamples.map(s=>s.largestRequiredResourceBytes)),minimumRequiredResourceBytes:Math.min(...largeSamples.map(s=>s.requiredResourceBytes)),finalInputFrames:largeSamples.filter(s=>s.inputSeq>=seq&&same(s.pixels[3],finalMarker)).length};
  const netem=network.find(q=>q.kind==='netem');assert.ok(netem?.bytes>=minimum);if(loss)assert.ok(netem.drops>0,'Actual kernel packet loss must occur');
  assert.ok(viewer.assetStats.receivedChunks>0&&viewer.resourceBytes>=minimum);assert.ok(viewer.requiredResources.length>0);assert.equal(viewer.connectionGeneration,initialGeneration,'Bulk transfer must not silently reconnect');assert.equal(live.source.control.holder,peer.id);
  assert.ok(viewer.native.captureOrdinal>0&&viewer.native.sourceFrame>0);assert.ok(peer.stats.maxInflight<=6&&peer.stats.maxInflightBytes<=16*1024*1024);
  assert.ok(origins.every(origin=>origin===live.origin),'Viewer must never fetch source resources');assert.deepEqual(sourceErrors,[]);assert.deepEqual(pageErrors,[]);assert.equal(live.source.stats.errors,0);
  assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});
  const result={configuredRttMs:rtt,lossPercent:loss,rateMbit:rate,originalPolicies:{postCommitAckMs:5000,resourceProgressInactivityMs:15000,inputAckMs:3000,wholeNetworkTransferMs:90000,chunkBytes:32768},genuineNativeBytes:Math.max(...nativeReceipts.map(f=>f.rawResourceBytes)),maxPendingBytes:peer.stats.maxPendingBytes,kernelTxPeak:txPeak,kernelTxHeldMs:50,inputCount,inputBase,inputExposure,inputs,inputAckMaxMs:Math.max(...inputs.map(a=>a.ms)),bulkThroughFinalPixelsMs:completedAt-bulkStarted,exactLargeImageSamples:3,exactInputMarker:finalMarker,viewer,sourceStats:structuredClone(live.source.stats),nodeCalls:{...nodeCalls},peerStats:structuredClone(peer.stats),sourceErrors:[...sourceErrors],pageErrors:[...pageErrors],sourceImageRefetches:0,network,tcpDuringBulk,tcpAfterPixels,nativeReceipts,frameAge,largeFrameAge,dropMetrics:{witnesses:{before:lossBefore,afterTransfer:lossAfterTransfer,afterCalibration:lossAfter},nativeRejections:structuredClone(lossObservation.rejections),worker:frameAge.protocol,kernelPacketDrops:netem.drops,scope:'NativeSourcecounter/actualNativeFrameRejectedtuple/GatewayasynchronousPeerStats/actualWorkerrecoverandWSqueuedkeyframerequest/kernelpacketdropseachdifferentboundariesandunits. Nodewitnesseslabeltimes;noinventedordinal-gapcauseoratomicend-to-enddropcount.'}};
  result.cleanup=await cleanup();assert.deepEqual(sourceErrors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(result.cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0,browserConnected:false,errors:[]});
  const casePath=`${output}/case-${rtt}-${loss}-${rate}.json`;await writeFile(casePath,JSON.stringify({at:new Date().toISOString(),status:'passed',versions,result},null,2));results.push(result);
  await writeFile(output+'/network.json',JSON.stringify({at:new Date().toISOString(),status:'passed-cases-so-far',scope,versions,configuredCases:cases,results},null,2));
  console.log(JSON.stringify({rtt,loss,rate,status:'passed',genuineBytes:result.genuineNativeBytes,maxInputAckMs:result.inputAckMaxMs,bulkMs:result.bulkThroughFinalPixelsMs,kernelDrops:netem.drops,coverage:frameAge.coverage,largeFrameAge,clockUncertainty:frameAge.clockUncertainty,pixelReadCost:frameAge.pixelObserverCost}));
 }
 const path=output+'/network.json',report=JSON.parse(await readFile(path,'utf8'));report.status='passed';await writeFile(path,JSON.stringify(report,null,2));
}catch(error){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',scope,versions,configuredCases:cases,progress,error:error.stack,viewer:await lastPage?.evaluate(()=>({error:document.querySelector('#error')?.textContent,status:document.querySelector('#status')?.textContent,observer:window.__rpAge?{errors:window.__rpAge.errors,samples:window.__rpAge.samples.length}:null})).catch(()=>({unavailable:true})),sourceErrors,pageErrors,nodeCalls,nativeReceipts,sourceStats:live?.source.stats,peerStats:[...(live?.peers??[])].map(p=>structuredClone(p.stats)),network:JSON.parse(tc('-s','-j','qdisc','show','dev','lo')),results},null,2));throw error;}
finally{await cleanup();await browser.close();await new Promise(resolve=>fixture.close(resolve));}
