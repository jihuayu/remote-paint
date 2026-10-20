// Real renderer document identity and expected-document binding. This uses
// explicit lifecycle controls, not the still-pending default Source adapter.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_DOCUMENT_OUTPUT??'artifacts/native-document';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-document-'),endpoint=directory+'/viz.sock',token=randomBytes(32).toString('hex'),key=()=>randomBytes(16).toString('hex');
const colors={a:[197,53,113,255],b:[43,161,89,255],c:[31,79,191,255]};
const fixture=createServer((req,res)=>{const name=req.url.startsWith('/b')?'b':req.url.startsWith('/c')?'c':'a';res.end(`<!doctype html><style>html,body{margin:0;overflow:hidden;background:rgb(${colors[name].slice(0,3)})}p{margin:40px;font:24px Arial}</style><p>Document ${name}</p>`);});
const broker=new NativeBroker(),events=[],samples=[],documents=[],attempts=[],checks=[],errors=[],counts={evaluate:0,awaitPromise:0,map:0,publish:0};
const original=broker.request.bind(broker);broker.request=(op,args)=>{if(op==='map'||op==='publish')counts[op]++;return original(op,args);};
broker.on('event',e=>{if(e.event==='NativeFrame'||e.event==='NativeFrameRejected'){events.push(e);assert.ok(events.length<128);}});broker.on('failure',e=>errors.push(e.message));
const clean=s=>String(s).replaceAll(token,'[redacted]');
let browser,page,driver,cdp,world,socket,renderer,ck,phase='startup',current,failure,closing=false;
const until=async(fn,label)=>{const end=Date.now()+12000;while(!await fn()){assert.deepEqual(errors,[]);assert.equal(driver?.stats.errors??0,0);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(10);}};
async function worldFor(frameId){return (await cdp.send('Page.createIsolatedWorld',{frameId,worldName:'remote-paint-native-document-test'})).executionContextId;}
async function ensureWorld(){const{frameTree}=await cdp.send('Page.getFrameTree');world=await worldFor(frameTree.frame.id);}
async function evaluate(contextId,secret,op,id,...args){counts.evaluate++;return cdp.send('Runtime.evaluate',{contextId,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[secret,op,id,...args].map(JSON.stringify).join(',')})`,returnByValue:true});}
async function control(op,id,...args){const r=await evaluate(world,token,op,id,...args);if(r.exceptionDetails)throw new Error(clean(r.exceptionDetails.exception?.description??r.exceptionDetails.text));return r.result.value;}
async function describe(){const d=await control('describe',key());assert.equal(d.ok,true);assert.equal(d.subscriptionVersion,2);assert.equal(typeof d.ready,'boolean');assert.ok(typeof d.documentToken==='string'&&d.documentToken.length>0&&d.documentToken.length<=64);documents.push({phase,...d});return d;}
async function rejectStale(id,expected,epoch,base){const r=await control('bindDocument',id,expected,epoch,1,0,320,180,base);attempts.push({phase,stale:true,...r});assert.equal(r.ok,false);assert.equal(r.code,'NATIVE_DOCUMENT_CHANGED');assert.notEqual(r.documentToken,expected);assert.equal((await control('inspect',id)).ok,false);return r;}
async function bind(d,epoch,base){
 const id=key();await rejectStale(id,'invalid-document-token',epoch,base);let c;
 await until(async()=>{c=await control('bindDocument',id,d.documentToken,epoch,1,0,320,180,base);attempts.push({phase,...c});if(c.ok)return true;assert.equal(c.code,'NATIVE_NOT_READY',JSON.stringify(c));await driver.requestNow();return false;},'native root readiness');
 assert.equal(c.documentToken,d.documentToken);assert.equal(c.enabled,false);assert.equal(c.ordinalBase,base);current=c;
 const again=await control('bindDocument',id,d.documentToken,epoch,1,0,320,180,base);assert.equal(again.generation,c.generation);assert.equal(again.ordinalBase,c.ordinalBase);
 await broker.request('registerNative',{config:c});assert.equal((await control('enable',id,true)).ok,true);return c;
}
async function sample(c,name){await until(()=>samples.some(s=>s.scopeId===c.id&&s.pageEpoch===c.pageEpoch),'correct document scene pixels');const s=samples.find(s=>s.scopeId===c.id);assert.deepEqual(s.rgba,colors[name]);return s;}
async function cancel(c){await broker.request('cancelNative',{scopeId:c.id});const r=await control('inspect',c.id);if(r.ok&&!r.retiring)await control('cancel',c.id);await until(async()=>{const s=await control('inspect',c.id);return !s.ok||!s.inflight;},'native old binding drain');current=null;}
try{
 ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);
 await broker.request('listenViz',{path:endpoint});const origin='http://127.0.0.1',access=key(),rendererInfo={};const{port}=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key:access,renderer:rendererInfo,producer:'native-document-test',sessionId:'native-document-test'}});
 const gate=new LiveFrameGate();socket=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${access}`,{origin});socket.on('error',e=>errors.push(clean(e.message)));socket.on('close',(code,reason)=>{if(!closing)errors.push(`Gateway closed: ${code} ${reason}`);});
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);gate.put(item.id,item.payload);return;}const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);
  if(m.type==='FrameCommit'){const f=gate.commit(m.pageEpoch,m.frameId);assert.ok(f);const out=renderer.render(f.scene,gate.resources,ck.WHITE);try{const rgba=[...out.image.readPixels(8,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];samples.push({phase,scopeId:f.native.captureId.split(':')[0],ordinal:f.native.captureOrdinal,producer:f.native.producer,pageEpoch:f.pageEpoch,rgba});assert.ok(samples.length<128);}finally{out.image.delete();out.surface?.dispose();}socket.send(JSON.stringify({type:'FrameAck',pageEpoch:f.pageEpoch,frameId:f.frameId,stage:'scene-submitted'}));}
 }catch(e){errors.push(clean(e.stack));}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:rendererInfo}));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:process.env.REMOTE_PAINT_CHROMIUM,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:endpoint,REMOTE_PAINT_NATIVE_RESOURCES:'1'},args:nativeLaunchArgs(token,{beginFrames:true})});
 page=await browser.newPage({viewport:{width:320,height:180}});driver=await startBeginFrames(page);cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');await ensureWorld();
 phase='blank';const blank=await describe();assert.equal((await evaluate(world,'wrong-capability','describe',key())).exceptionDetails!==undefined,true);checks.push('actual opaque document identity available before capture;private capability enforced');
 const url=`http://127.0.0.1:${fixture.address().port}`;await page.goto(url+'/a',{waitUntil:'commit'});await ensureWorld();phase='a';const a=await describe();assert.notEqual(a.documentToken,blank.documentToken);
 const ca=await bind(a,1,0);assert.equal(ca.generation,1,'stale binds must not reserve generations');const sa=await sample(ca,'a');checks.push('stale expected-token bind allocates no ordinal/generation;valid idempotent bind publishes actual documentA pixels');
 await page.evaluate(()=>history.pushState({},'',location.pathname+'?same#document'));const same=await describe();assert.equal(same.documentToken,a.documentToken);await control('update',ca.id,0,false,true);await until(()=>samples.filter(s=>s.scopeId===ca.id).length>=2,'same-document fresh frame');checks.push('historypushState retains native document identity andexisting binding');
 phase='b';await page.goto(url+'/b',{waitUntil:'commit'});await ensureWorld();const b=await describe();assert.notEqual(b.documentToken,a.documentToken);const old=await control('inspect',ca.id);assert.ok(!old.ok||old.retiring||!old.enabled,'new document did not revoke old native binding');await broker.request('cancelNative',{scopeId:ca.id});await rejectStale(key(),a.documentToken,1,ca.ordinalLimit+1);
 const cb=await bind(b,2,ca.ordinalLimit+1);await sample(cb,'b');checks.push('newdocument rejects previous token evenwithlagging backendepoch;oldbinding revoked andnewpixels carryepoch2');
 await cancel(cb);phase='reload';await page.reload({waitUntil:'commit'});await ensureWorld();const reload=await describe();assert.notEqual(reload.documentToken,b.documentToken);await rejectStale(key(),b.documentToken,2,cb.ordinalLimit+1);const cr=await bind(reload,3,cb.ordinalLimit+1);await sample(cr,'b');checks.push('sameURL reload changes actualdocumenttoken andrejectsold handshake');
 await cancel(cr);phase='cross-site';await page.goto(`http://localhost:${fixture.address().port}/c`,{waitUntil:'commit'});await ensureWorld();const cross=await describe();assert.notEqual(cross.documentToken,reload.documentToken);await rejectStale(key(),reload.documentToken,3,cr.ordinalLimit+1);const cc=await bind(cross,4,cr.ordinalLimit+1),sc=await sample(cc,'c');checks.push('default-frame-control crosssite navigation usesnewtoken,disjointreservation anddocumentC pixels');
 // Headless frame control rejects --site-per-process. Replace the target in
 // an independent BrowserContext to prove a real renderer/process boundary
 // without changing those production launch flags or weakening that policy.
 await cancel(cc);await driver.close();await page.close();phase='replacement';const context=await browser.newContext({viewport:{width:320,height:180}});page=await context.newPage();driver=await startBeginFrames(page);cdp=await page.context().newCDPSession(page);await cdp.send('Page.enable');await page.goto(url+'/a',{waitUntil:'commit'});await ensureWorld();const replacement=await describe();assert.notEqual(replacement.documentToken,cross.documentToken);await rejectStale(key(),cross.documentToken,4,cc.ordinalLimit+1);const cp=await bind(replacement,5,cc.ordinalLimit+1),sp=await sample(cp,'a');assert.notEqual(sp.producer.split(':')[0],sc.producer.split(':')[0],'independent context must exerciseactualrendererreplacement');checks.push('actualindependent-context rendererreplacement preserves documenthandshake andreservedordinalfence');
 await cancel(cp);let previous=cp,previousDocument=replacement;
 for(let n=0;n<24;n++){
  phase=`rapid-${n}`;const host=n%2?'localhost':'127.0.0.1',name=n%2?'b':'a';
  await page.goto(`http://${host}:${fixture.address().port}/${name}?iteration=${n}`,{waitUntil:'commit'});await ensureWorld();const d=await describe();assert.notEqual(d.documentToken,previousDocument.documentToken);
  await rejectStale(key(),previousDocument.documentToken,previous.pageEpoch,previous.ordinalLimit+1);
  const c=await bind(d,6+n,previous.ordinalLimit+1);await sample(c,name);await cancel(c);previous=c;previousDocument=d;
 }
 checks.push('24serializedcrosssite navigations preserve actualtokens/ordinalranges/pixels andfourUnixrouteadmission');
 assert.equal(counts.awaitPromise,0);assert.equal(counts.map,0);assert.equal(counts.publish,0);assert.deepEqual(errors,[]);
}catch(e){failure=clean(e.stack);}
finally{closing=true;await driver?.close().catch(()=>{});await browser?.close().catch(()=>{});socket?.terminate();renderer?.clear();await broker.close();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Linux Chromium WebDocumentToken/privateisolated API/expected-documentbind/productionBroker/Gateway/CanvasKit actualpixels;blank,newdocument,same-documenthistory,reload,defaultcrosssitenavigation andindependent-context rendererreplacement. Explicit backend lifecycle controls;defaultSource delayed-event reconciliation/idle/demand/fullB1 remainpending.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),phase,checks,counts,documents,attempts,samples,events,errors,clock:driver?.stats,cleanup:{exited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners},...(failure?{error:failure}:{})};await writeFile(output+'/document.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,samples:samples.length,counts,error:failure}));if(failure)throw new Error(failure);
