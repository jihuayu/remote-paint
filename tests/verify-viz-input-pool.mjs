import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {payload} from './live-helpers.mjs';

const previous=process.env.REMOTE_PAINT_INPUT_POOL_BYTES;process.env.REMOTE_PAINT_INPUT_POOL_BYTES=String(16*1024*1024);
const broker=new NativeBroker(),viz=await startVizIPC({broker,nativeResources:true}),sockets=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),resourceId=hash(payload),u32=n=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(n);return bytes;},str=s=>{const bytes=Buffer.from(s);return Buffer.concat([u32(bytes.length),bytes]);};
const prefix=id=>Buffer.concat([Buffer.from('RPA2\x01\x01'),str(id)]),tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}},rect=[0,0,100,100];
const metadata=id=>({captureId:id,producer:'viz-input-contract',nativeResources:true,resources:[{localId:1,quadScale:1,width:100,height:100,resourceId}]});
const raw=id=>Buffer.concat([prefix(id),str(JSON.stringify(metadata(id))),u32(1),str(resourceId),u32(payload.length),payload]);
const scene=id=>({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]});
const capture=id=>({captureId:id,viz:{native:true},nativeResources:true});
const send=(socket,packet)=>socket.write(Buffer.concat([u32(packet.length),packet]));
async function connect(){const socket=net.createConnection(viz.endpoint);socket.on('error',()=>{});sockets.push(socket);await once(socket,'connect');return socket;}
async function waitBudget(predicate){const end=Date.now()+5000;do{const stats=await broker.request('inputBudget');assert.ok(stats.bytes<=stats.limit&&stats.peak<=stats.limit);if(predicate(stats))return stats;assert.ok(Date.now()<end,'Viz input budget deadline');await delay(5);}while(true);}
let progress;
try{
 const complete=await connect(),ready=viz.waitFor('completed');ready.catch(()=>{});await ready.registered;send(complete,raw('completed'));send(complete,Buffer.from(JSON.stringify(scene('completed'))));await ready;
 const baseline=await broker.request('mapperStats');
 const holds=[];for(const id of ['held-a','held-b']){const pending=viz.waitFor(id);pending.catch(()=>{});await pending.registered;const socket=await connect();socket.write(Buffer.concat([u32(7*1024*1024),prefix(id)]));holds.push({id,socket});}
 const held=await waitBudget(stats=>stats.bytes>=14*1024*1024),over=viz.waitFor('over');over.catch(()=>{});await over.registered;
 const rejectedBody=Buffer.alloc(3*1024*1024);prefix('over').copy(rejectedBody);send(complete,rejectedBody);
 await assert.rejects(over,{code:'INPUT_BUDGET_PRESSURE'});viz.cancel('over');
 const denied=await waitBudget(stats=>stats.denied>0);assert.equal(denied.bytes,held.bytes);assert.deepEqual(await broker.request('mapperStats'),baseline);
 // A completed scene/resource pair must survive rejection on the same stream.
 const first=await broker.map(capture('completed'),tags);assert.equal(first.brokerSerial,1);
 const retry=viz.waitFor('retry');retry.catch(()=>{});await retry.registered;send(complete,raw('retry'));send(complete,Buffer.from(JSON.stringify(scene('retry'))));await retry;
 const second=await broker.map(capture('retry'),tags);assert.equal(second.brokerSerial,2);
 for(const {id,socket} of holds){socket.destroy();viz.cancel(id);}
 const released=await waitBudget(stats=>stats.bytes===0);
 // Scene ready can precede raw resources. A subsequent metadata-admission
 // failure must wake an already waiting map with the precise pressure code.
 const late=viz.waitFor('late');late.catch(()=>{});await late.registered;send(complete,Buffer.from(JSON.stringify(scene('late'))));await late;
 const waiting=broker.map(capture('late'),tags);waiting.catch(()=>{});await delay(25);const beforeLate=performance.now();
 const oversizedMetadata=JSON.stringify({...metadata('late'),padding:Array(30000).fill(0)}),lateBody=Buffer.concat([prefix('late'),str(oversizedMetadata),u32(0)]);send(complete,lateBody);
 await assert.rejects(waiting,{code:'INPUT_BUDGET_PRESSURE'});const lateFailureMs=performance.now()-beforeLate;assert.ok(lateFailureMs<2000,'Map waited for the3s pairing timeout');viz.cancel('late');
 const final=await waitBudget(stats=>stats.bytes===0),last=await broker.request('mapperStats');assert.equal(last.serial,2);assert.equal(last.revision,first.scene.passes[0].quads[0].revision);
 progress={held,denied,released,final,lateFailureMs,firstSerial:first.brokerSerial,retrySerial:second.brokerSerial,lateMapCode:'INPUT_BUDGET_PRESSURE'};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Rust private Unix RPA2/Viz protocol with16MiB input quota: two7MiB declared partial packets are charged before reads,third3MiB packet is drained with fixed scratch and rejected by exact capture ID. Completed pair survives on that stream and both maps succeed. Closing partial streams returns all input credits. A later metadata preflight failure wakes a scene-first waiting map with typed pressure rather than pairing timeout. Packet capacities are exact; JSON/index headroom is a conservative estimate. No process-memory or Viewer pixel claim.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress};
 await mkdir('artifacts/viz-input-pool',{recursive:true});await writeFile('artifacts/viz-input-pool/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/viz-input-pool',{recursive:true});await writeFile('artifacts/viz-input-pool/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{for(const socket of sockets)socket.destroy();await viz.close();await broker.close();if(previous===undefined)delete process.env.REMOTE_PAINT_INPUT_POOL_BYTES;else process.env.REMOTE_PAINT_INPUT_POOL_BYTES=previous;}
