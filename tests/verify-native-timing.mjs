import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import CanvasKitInit from 'canvaskit-wasm/full';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

const baseline=process.env.REMOTE_PAINT_TIMING_BASELINE==='1',output='artifacts/native-timing';
const broker=new NativeBroker(),viz=await startVizIPC({broker,nativeResources:true}),socket=net.createConnection(viz.endpoint);socket.on('error',()=>{});await once(socket,'connect');
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')}),recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,100,100]),paint=new ck.Paint();paint.setColor([31/255,79/255,191/255,1]);canvas.drawRect([0,0,100,100],paint);const picture=recorder.finishRecordingAsPicture(),bytes=Buffer.from(picture.serialize());picture.delete();paint.delete();recorder.delete();
const hash=b=>createHash('sha256').update(b).digest('hex'),resourceId=hash(bytes),renderer=new SceneRenderer(ck),u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},string=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);},rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const scene=id=>({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]});
const send=body=>socket.write(Buffer.concat([u32(body.length),body]));
async function paired(id,nativeTiming,cdpTiming){
 const ready=viz.waitFor(id);ready.catch(()=>{});await ready.registered;
 const metadata={captureId:id,producer:'native-timing-contract',nativeResources:true,resources:[{localId:1,quadScale:1,width:100,height:100,resourceId}],...(nativeTiming===undefined?{}:{timing:nativeTiming})};
 send(Buffer.concat([Buffer.from('RPA2\x01\x01'),string(id),string(JSON.stringify(metadata)),u32(1),string(resourceId),u32(bytes.length),bytes]));send(Buffer.from(JSON.stringify(scene(id))));await ready;
 return broker.map({captureId:id,viz:{native:true},nativeResources:true,timing:cdpTiming},tags);
}
let progress;const pid=broker.child.pid;
try{
 const initial=await broker.request('resourceBudget'),before=await broker.request('mapperStats'),rejections=[];
 for(let n=0;n<(baseline?1:16);n++){
  const timing=[false,19,'bad',[1,2]][n%4];let error;try{await paired(`invalid-${n}`,timing,{captureRoundTripMs:17});}catch(e){error=e;}assert.ok(error,'Invalid native timing must not commit a frame');
  if(baseline){await broker.childDone;assert.equal(broker.child.exitCode,101);assert.match(error.message,/panicked|cannot access key/);const report={at:new Date().toISOString(),status:'baseline-reproduced',scope:'Old48dc actual private RPA2→Viz→map with non-object native timing and nonempty CDP timing panics the Broker. Only this disposable fixture process exits;no current Source process is stopped.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),exitCode:broker.child.exitCode,error:error.message,before};await mkdir(output,{recursive:true});await writeFile(`${output}/baseline-panic.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));break;}
  assert.equal(error.message,'Native timing metadata is not an object');assert.equal(broker.child.pid,pid);assert.equal(broker.exited,false);assert.deepEqual(await broker.request('mapperStats'),before);
  const deadline=Date.now()+2000;let budget;do{budget=await broker.request('resourceBudget');if(budget.input.bytes===0&&budget.bytes===0&&budget.rpcInput.data.bytes===0)break;assert.ok(Date.now()<deadline,'Failed merge did not return actual input/resource owners');await delay(5);}while(true);
  assert.equal(budget.snapshots.bytes,0);assert.equal(budget.captureExpansion.bytes,0);rejections.push({nativeKind:typeof timing,message:error.message,inputBytes:budget.input.bytes,resourceBytes:budget.bytes,rpcDataBytes:budget.rpcInput.data.bytes,serial:before.serial});
 }
 if(!baseline){
  const variants=[{name:'override',native:{nativeOnly:17,stage:{old:1,shared:2},nativeText:'n'.repeat(256*1024)},cdp:{captureRoundTripMs:17,stage:{new:3},cdpText:'c'.repeat(512*1024),['long-key-'+('k'.repeat(4096))]:[1,true,null]}},{name:'missing-native-timing',native:undefined,cdp:{captureRoundTripMs:19}},{name:'null-native-timing',native:null,cdp:{captureRoundTripMs:23}},{name:'empty-native-timing',native:{},cdp:{captureRoundTripMs:29}},{name:'ignored-cdp-scalar',native:{nativeOnly:31},cdp:'ignored'},{name:'empty-cdp-preserves-native-shape',native:'native-shape',cdp:{}}],mapped=[];
  for(const [n,v]of variants.entries()){
   const result=await paired(v.name,v.native,v.cdp),expected=v.cdp&&typeof v.cdp==='object'&&!Array.isArray(v.cdp)&&Object.keys(v.cdp).length?{...(v.native??{}),...v.cdp}:v.native;
   assert.deepEqual(result.native.timing,expected);assert.equal(result.brokerSerial,n+1);assert.equal(result.payloads.size,1);assert.ok(result.payloads.has(resourceId));
   // RPC map payloads carry length descriptors. Replay known fixture bytes only
   // after checking the exact required hash;actual browser/Gateway pixels are
   // covered separately by native live contracts.
   const out=renderer.render(result.scene,new Map([[resourceId,bytes]]),ck.WHITE);let pixel;try{pixel=[...out.image.readPixels(10,10,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];}finally{out.image.delete();out.surface?.dispose();}assert.deepEqual(pixel,[31,79,191,255]);mapped.push({name:v.name,serial:result.brokerSerial,timingBytes:Buffer.byteLength(JSON.stringify(result.native.timing)),pixel});
  }
  assert.equal(broker.child.pid,pid);assert.equal(broker.exited,false);progress={rejections,mapped,pidUnchanged:true,initial,final:await broker.request('resourceBudget')};const report={at:new Date().toISOString(),status:'passed',scope:'Actual private Unix RPA2/native resource admission+Viz pairing+RPC Mapper.16 malformed native timing shapes return explicit error without Mapper commit,process exit or retained resource/input/expansion/Snapshot credit;6 valid/ignored merge variants recover in the same Broker with native fields,shallow CDP overrides and known-hash fixture pixels. RPC replay uses known fixture bytes after required-hash check;it is not an actual website pixel proof. Original input quotas are unchanged;not total memory or end-to-end latency acceptance.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress};await mkdir(output,{recursive:true});await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{renderer.clear();socket.destroy();await viz.close();await broker.close();}
