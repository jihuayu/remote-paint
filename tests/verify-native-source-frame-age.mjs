// Run ONLY inside a disposable Linux container with CAP_NET_ADMIN. The tc
// filters impair this test's Gateway port, never Chromium's internal CDP.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {WebSocket} from 'ws';
import {startFrameAgeLive,installFrameAgeObserver,beginFrameAge,finishFrameAge,observeFrameLoss} from './frame-age-observer.mjs';

assert.equal(process.platform,'linux');assert.equal(process.env.REMOTE_PAINT_NETEM,'1','Use a disposable test network namespace');
const samples=Number(process.env.REMOTE_PAINT_NETWORK_SAMPLES??1000),interval=25;
assert.ok(Number.isSafeInteger(samples)&&samples>=1000&&samples<=2000,'Keep at least1000 inputs/profile andbounded observer retention');
const cases=JSON.parse(process.env.REMOTE_PAINT_FRAME_AGE_CASES??JSON.stringify([[0,0],...[20,40,80,150].flatMap(r=>[.5,1,2].map(l=>[r,l]))]));
const output=process.env.REMOTE_PAINT_FRAME_AGE_OUTPUT??'artifacts/native-source-frame-age';await mkdir(output,{recursive:true});
const tc=(...args)=>execFileSync(process.env.REMOTE_PAINT_TC??'tc',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const clear=()=>{try{tc('qdisc','del','dev','lo','root');}catch{}};
function impair(port,rtt,loss){
 tc('qdisc','add','dev','lo','root','handle','1:','prio','bands','3','priomap',...Array(16).fill('0'));
 tc('qdisc','add','dev','lo','parent','1:3','handle','30:','netem','limit','1000','delay',`${rtt/2}ms`,`${rtt/20}ms`,'loss',`${loss}%`,'rate','20mbit');
 for(const direction of ['sport','dport'])tc('filter','add','dev','lo','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol','6','0xff','match','ip',direction,String(port),'0xffff','flowid','1:3');
}
const html=`<!doctype html><style>body{margin:0;background:#fff}input{position:absolute;left:20px;top:20px;width:300px;height:40px}#marker{position:absolute;left:400px;top:60px;width:24px;height:24px;background:rgb(0,0,42)}#drag{position:absolute;left:100px;top:180px;width:40px;height:40px;background:#0066cc;touch-action:none}#animation{position:absolute;left:600px;top:180px;width:24px;height:24px;background:rgb(255,128,0);will-change:transform;animation:move1 1.2s linear infinite alternate}@keyframes move1{to{transform:translateX(80px)}}</style><input id="name" data-remote-paint-preview="plain-text"><div id="marker"></div><div id="drag"></div><div id="animation"></div><script>document.querySelector('input').addEventListener('input',e=>{const n=e.target.value.length;document.querySelector('#marker').style.background='rgb('+((n>>8)&255)+','+(n&255)+',42)';});const d=document.querySelector('#drag');d.onpointerdown=e=>d.setPointerCapture(e.pointerId);d.onpointermove=e=>{if(e.buttons&1)d.style.left=(e.clientX-20)+'px';};</script>`;
const fixture=createServer((req,res)=>res.end(html));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,args:['--no-sandbox']});
const results=[];let live,echo,progress,context,lastPage,lossObservation;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const versions={browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))};
try{
 for(const [rtt,loss] of cases){
  progress={rtt,loss,phase:'startup'};
  live=await startFrameAgeLive({port:0,url:`http://127.0.0.1:${fixture.address().port}`});
  assert.equal(live.source.nativeAutopublish,true,'This matrix verifies the default autonomous native Source');
  const nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0},captureErrors=[],pageErrors=[];lossObservation=observeFrameLoss(live.source,live.peers);const nativeRejections=lossObservation.rejections;
  live.source.on('captureError',error=>captureErrors.push(error.message));
  const request=live.source.broker.request.bind(live.source.broker);live.source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};const send=live.source.capture.cdp.send.bind(live.source.capture.cdp);live.source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
  context=await browser.newContext({viewport:{width:1100,height:900}});const page=await context.newPage();lastPage=page;page.on('pageerror',e=>pageErrors.push(e.message));const observerProvenance=await installFrameAgeObserver(page,live.observerProvenance);
  await page.addInitScript(()=>{window.publicFeedbackCount=0;const Socket=WebSocket;window.WebSocket=class extends Socket {constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(typeof data!=='string')return;const m=JSON.parse(data);if(m.type==='FeedbackState'&&m.editor?.preview==='plain-text')window.publicFeedbackCount++;});}};});
  const viewerUrl=new URL(live.url);viewerUrl.searchParams.set('cpu','1');await page.goto(viewerUrl.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);assert.equal(await page.evaluate(()=>window.remotePaintResult.worker&&window.remotePaintResult.presentation.mode==='cpu-2d'),true);
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
  const bounds=await page.locator('#viewport').boundingBox();await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);
  await live.source.page.waitForFunction(()=>document.activeElement.id==='name');
  const base=live.source.inputSeq;await page.waitForFunction(seq=>window.remotePaintResult.lastProcessedInputSeq>=seq,base);
  const url=new URL(live.streamOrigin);echo=new WebSocket(`${live.streamOrigin.replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin});
  echo.on('message',(bytes,binary)=>{if(!binary){const m=JSON.parse(bytes);if(m.type==='FrameCommit')echo.send(JSON.stringify({type:'FrameAck',pageEpoch:m.pageEpoch,frameId:m.frameId}));}});
  await once(echo,'open');echo.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer}));
  await new Promise(resolve=>setTimeout(resolve,100));
  const ageWindow=await beginFrameAge(live.source,page),lossBefore=lossObservation.snapshot();
  if(rtt||loss)impair(url.port,rtt,loss);
  progress.phase='input';
  const feedbackBefore=await page.evaluate(()=>window.publicFeedbackCount);
  const actualRtt=[];for(let i=0;i<10;i++){const start=performance.now(),pong=once(echo,'pong');echo.ping(String(i));await pong;actualRtt.push(performance.now()-start);}
  const measured=await page.evaluate(async({samples,interval,base})=>{
   const starts=[],durations=[],frames=[],animationPatterns=new Set(),proxy=document.querySelector('#inputProxy'),canvas=document.querySelector('canvas');
   const sample=document.createElement('canvas');sample.width=sample.height=1;const ctx=sample.getContext('2d',{willReadFrequently:true});
   let finished=false,seen=0,maxOutstanding=0,previousFrame=0,lastProgress=performance.now(),maxGap=0;
   const observe=()=>{
    if(finished)return;const now=performance.now(),frame=window.remotePaintResult;
    if(frame?.frameId!==previousFrame){
     previousFrame=frame.frameId;ctx.drawImage(canvas,412,72,1,1,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;
     const painted=p[0]*256+p[1],included=Math.min(painted,(frame.lastProcessedInputSeq??0)-base,starts.length);
     if(p[2]===42&&included>seen){maxGap=Math.max(maxGap,now-lastProgress);lastProgress=now;for(let n=seen;n<included;n++)durations.push(now-starts[n]);seen=included;}
     let animation=0;for(const [bit,x]of [[1,610],[2,690]]){ctx.drawImage(canvas,x,190,1,1,0,0,1,1);const color=ctx.getImageData(0,0,1,1).data;if(color[0]===255&&color[1]===128&&color[2]===0)animation|=bit;}animationPatterns.add(animation);
     if(frames.length>=4096)throw new Error('Network verifier frame-retention bound');
     frames.push({id:frame.frameId,at:now,watermark:frame.lastProcessedInputSeq,painted,animation,renderMs:frame.renderMs,resourceBytes:frame.resourceBytes,native:frame.native?{captureOrdinal:frame.native.captureOrdinal,sourceFrame:frame.native.sourceFrame}:null});
    }
    requestAnimationFrame(observe);
   };requestAnimationFrame(observe);
   for(let i=0;i<samples;i++){
    starts.push(performance.now());proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true}));
    maxOutstanding=Math.max(maxOutstanding,starts.length-seen);await new Promise(resolve=>setTimeout(resolve,interval));
   }
   const deadline=performance.now()+15000;while(seen<samples&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));finished=true;
   return {seen,sent:starts.length,durations,frames,animationPatterns:[...animationPatterns],maxOutstanding,maxGap,control:document.querySelector('#controlState').textContent,error:document.querySelector('#error').textContent};
  },{samples,interval,base});
  assert.equal(measured.seen,samples,JSON.stringify({rtt,loss,...measured,durations:undefined,frames:measured.frames.slice(-3)}));
  assert.equal((await live.source.page.locator('#name').inputValue()).length,samples,'All text inputs arrived once and in order');
  assert.ok(measured.animationPatterns.length>=2,'Actual compositor animation pixels must change under this network profile');
  await page.waitForFunction(before=>window.publicFeedbackCount>before,feedbackBefore);const publicFeedbackCount=await page.evaluate(()=>window.publicFeedbackCount);
  const inputNetwork=JSON.parse(tc('-s','-j','qdisc','show','dev','lo'));
  const inputPeers=[...live.peers].map(p=>({id:p.id,stats:structuredClone(p.stats)})),lossAfterInput=lossObservation.snapshot();
  let lifecycle=null;
  {
   progress.phase='lifecycle';
   const point=(x,y)=>({x:bounds.x+x*bounds.width/960,y:bounds.y+y*bounds.height/640});
   const start=point(120,200);await page.mouse.move(start.x,start.y);await page.mouse.down();
   for(let i=1;i<=22;i++){const p=point(120+i*10,200);await page.mouse.move(p.x,p.y);await page.waitForTimeout(15);}
   await page.mouse.up();await live.source.page.waitForFunction(()=>document.querySelector('#drag').style.left==='320px');
   await page.waitForFunction(()=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('canvas'),340,200,1,1,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return p[0]===0&&p[1]===102&&p[2]===204;});
   // A short real blackhole exercises TCP retransmission without dropping
   // application dependencies. Internal CDP remains outside the tc filter.
   // The unshaped0/0 input baseline did not install the profile earlier.
   // Give its separate blackhole/reconnect phase a scoped Gateway class.
   if(!rtt&&!loss)impair(url.port,0,0);
   tc('qdisc','change','dev','lo','parent','1:3','handle','30:','netem','loss','100%');
   await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);
   await page.locator('#inputProxy').evaluate(proxy=>proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'y',bubbles:true,cancelable:true})));
   await new Promise(resolve=>setTimeout(resolve,300));const resumed=performance.now();
   tc('qdisc','change','dev','lo','parent','1:3','handle','30:','netem','delay',`${rtt/2}ms`,`${rtt/20}ms`,'loss',`${loss}%`,'rate','20mbit');
   // The click positions the caret inside the horizontally scrolled editor;
   // verify one insertion at that caret, rather than assuming an append.
   await live.source.page.waitForFunction(expected=>{const value=document.querySelector('input').value;return value.length===expected+1&&value.replaceAll('x','')==='y';},samples);
   await page.waitForFunction(expected=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('canvas'),412,72,1,1,0,0,1,1);const p=ctx.getImageData(0,0,1,1).data;return p[0]*256+p[1]===expected&&p[2]===42;},samples+1);
   const blackholeRecoveryMs=performance.now()-resumed;
   const generation=await page.evaluate(()=>window.remotePaintResult.connectionGeneration),reconnectStarted=performance.now();
   [...live.peers].find(p=>p.id===live.source.control.holder).close(1012,'Network recovery probe');
   await page.waitForFunction(old=>window.remotePaintResult.connectionGeneration>old&&window.remotePaintResult.fullFrames===1,generation);
   assert.equal(live.source.control.mode,'agent');
   lifecycle={dragMoves:22,dragFinalLeft:320,dragPixelsCorrect:true,blackholeMs:300,blackholeRecoveryMs,reconnectMs:performance.now()-reconnectStarted,reconnectFullBaseline:true,leaseRevoked:true};
  }
  progress.phase='frame-age';const frameAge=await finishFrameAge(live.source,page,ageWindow,observerProvenance),lossAfter=lossObservation.snapshot();assert.equal(frameAge.provenance.diagnosticFaults,false);assert.equal(frameAge.protocol.counts.diagnosticFaults,0);
  assert.ok(frameAge.samples.every(s=>s.pixels[0][2]===42&&s.pixels[0][3]===255&&s.pixels[0][0]*256+s.pixels[0][1]<=samples+1),'Every frame-age sample has the real source input-marker pixels');
  assert.ok(frameAge.samples.some(s=>s.pixels[0][0]*256+s.pixels[0][1]===samples),'Observed actual input1000 marker in paired Worker');
  if(lifecycle){assert.ok(frameAge.samples.some(s=>s.pixels[0][0]*256+s.pixels[0][1]===samples+1));assert.ok(new Set(frameAge.samples.map(s=>s.connectionGeneration)).size>=2,'Frame-age coverage includes actual automatic reconnection');}
  const network=JSON.parse(tc('-s','-j','qdisc','show','dev','lo'));clear();
  const sorted=measured.durations.slice().sort((a,b)=>a-b),percentile=p=>sorted[Math.ceil(sorted.length*p)-1];
  assert.deepEqual(captureErrors,[]);assert.deepEqual(pageErrors,[]);assert.equal(live.source.stats.errors,0);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});
  const result={publicTextFeedback:true,publicFeedbackCount,configuredRttMs:rtt,lossPercent:loss,inputRateMbit:rtt||loss?20:null,baselineInputUnshaped:!rtt&&!loss,measuredRttMs:actualRtt,samples,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:sorted.at(-1),maxProgressGapMs:measured.maxGap,maxOutstanding:measured.maxOutstanding,frames:measured.frames.length,animationPatterns:measured.animationPatterns,lifecycle,inputNetwork,network,peers:[...live.peers].map(p=>structuredClone(p.stats)),sourceErrors:live.source.stats.errors,captureErrors:[...captureErrors],pageErrors:[...pageErrors],nodeCalls:{...nodeCalls},frameAge,dropMetrics:{witnesses:{before:lossBefore,afterInput:lossAfterInput,afterCalibration:lossAfter},worker:frameAge.protocol,sourcePublished:live.source.stats.captures,sourceSupersessions:live.source.stats.captureSupersessions,sourceResourceRecoveries:live.source.stats.resourceRecoveries,nativeRejections:structuredClone(nativeRejections),inputPeers,finalPeers:[...live.peers].map(p=>({id:p.id,stats:structuredClone(p.stats)})),inputKernelPacketDrops:inputNetwork.filter(q=>q.kind==='netem').reduce((n,q)=>n+q.drops,0),scope:'Source counters,Gateway snapshot coalescing andkernel packet loss have different sampling boundaries andsemantics. Native rejected outcomes areexplicit;ordinal gaps are notassigned invented dropcauses. Viewer successfulcommits/100%pairedpixel samples are recorded bytheobserver.'}};
  lossObservation.close();lossObservation=null;echo.terminate();echo=null;await context.close();context=null;const heldSource=live.source;await live.close();live=null;result.cleanup={brokerExited:heldSource.broker.exited,pending:heldSource.broker.pending.size,requestOwners:heldSource.broker.requestMemory.stats().owners,responseOwners:heldSource.broker.responses.stats().owners,browserConnected:heldSource.browser.isConnected()};assert.deepEqual(result.cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0,browserConnected:false});
  await writeFile(`${output}/case-${rtt}-${loss}.json`,JSON.stringify({at:new Date().toISOString(),status:'passed',versions,result,measurements:measured},null,2));
  results.push(result);console.log(JSON.stringify({rtt,loss,samples,status:'passed',inputP95Ms:result.p95Ms,frameAge:frameAge.age,ageUpper:frameAge.ageUpper,uncertainty:frameAge.clockUncertainty,pixelReadCost:frameAge.pixelObserverCost,coverage:frameAge.coverage,nativeRejections:nativeRejections.length}));
  await writeFile(output+'/loss.json',JSON.stringify({at:new Date().toISOString(),status:'passed-cases-so-far',scope:'Actual default autonomous NativeSource/c5d native Take-start timestamp/Linux kernel netem GatewayTCP only/realCDP text inputs andactualCPUViewerWorker pixels withanimation/22movedrag/300msblackhole/reconnect. Tests-onlyinstrumentedproductionWorker takesexact-framepairedactualpixel samples for100%successfulcommitsatthemeasurementpoint;Node↔native/Worker before-aftercalibrationintervals+explicitaffinedriftassumption/uncertainty/coverage/observercost,notphysicalscanout. Inputclosedloop/progressgapsremainseparate;no actual9MiBframe-age/fullN1/all41/8hclaim.',versions,samplesPerCase:samples,results},null,2));
 }
 const path=output+'/loss.json',report=JSON.parse(await readFile(path,'utf8'));report.status='passed';await writeFile(path,JSON.stringify(report,null,2));
}catch(error){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',versions,progress,error:error.stack,viewer:await lastPage?.evaluate(()=>({error:document.querySelector('#error')?.textContent,status:document.querySelector('#status')?.textContent,observer:window.__rpAge?{workerCount:window.__rpAge.workerCount,errors:window.__rpAge.errors,socketCloses:window.__rpAge.socketCloses,samples:window.__rpAge.samples.length}:null,startup:window.remotePaintStartup})).catch(()=>({unavailable:true})),results,sourceStats:live?.source.stats},null,2));throw error;}
finally{lossObservation?.close();clear();echo?.terminate();await context?.close();await live?.close();await browser.close();await new Promise(resolve=>fixture.close(resolve));}
