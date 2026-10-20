import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {payload} from './live-helpers.mjs';

assert.equal(process.platform,'linux');
const broker=new NativeBroker({responseLimits:{dataBytes:1024*1024}}),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),resourceId=hash(payload),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}},output='artifacts/node-response-budget';
await mkdir(output,{recursive:true});
const capture=id=>({captureId:id,producer:'node-response-contract',resources:[{localId:1,quadScale:1,width:100,height:100,resourceId,skp:payload.toString('base64')}],viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}});
let progress,report;
try{
 const first=await broker.map(capture('first'),tags),oldScene=JSON.stringify(first.scene),pid=broker.child.pid;let lastDelivered=first.brokerSerial,lastPublished=first,lastPublishedScene=oldScene,denied,accepted=[];
 // Actual Source publishes its last successful frame. A JS result object is
 // not a server-side resource pin when resourceBudget reclaims old history.
 await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin:'http://127.0.0.1',key:'response-admission-local-only-key',renderer:{},producer:{}}});
 await broker.request('publish',{serial:first.brokerSerial});progress={step:'published successful baseline',serial:first.brokerSerial};
 for(const count of [64,128,256]){
  const wide=capture('wide-'+count);delete wide.resources[0].skp;wide.viz.passes[0].quads.push(...Array.from({length:count},(_,index)=>({kind:'solid',matrix:[1,0,0,0,1,0,0,0,1],rect:[index%100,0,1,100],visible:[index%100,0,1,100],color:[0.1,0.2,0.3,1],opacity:1})));
  try{const mapped=await broker.map(wide,tags);lastDelivered=mapped.brokerSerial;await broker.request('publish',{serial:mapped.brokerSerial});lastPublished=mapped;lastPublishedScene=JSON.stringify(mapped.scene);accepted.push({count,serial:mapped.brokerSerial,published:true});}
  catch(error){assert.equal(error.code,'INPUT_BUDGET_PRESSURE');assert.equal(error.budget,'node-response');denied={count,code:error.code,budget:error.budget,phase:error.phase};break;}
 }
 assert.ok(denied,'Explicit1MiB response quota did not exercise a valid larger scene');assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);
 const backend=await broker.request('mapperStats');assert.equal(backend.serial,lastDelivered+1,'Response rejection should not be mislabeled as remote Mapper rollback');progress={step:'local response denied after remote commit',acceptedBeforeDenial:accepted,denied,backend};
 assert.equal(JSON.stringify(first.scene),oldScene,'Caller retained successful snapshot was modified');
 assert.equal(JSON.stringify(lastPublished.scene),lastPublishedScene,'Last published result was modified');
 const status=await broker.request('resourceBudget');assert.equal(status.ready,true);assert.equal(status.nodeResponses.dataBytes,0);assert.ok(status.nodeResponses.deniedPackets>0);assert.ok(status.nodeResponses.peakDataBytes<=1024*1024);
 const reuse=capture('recovered');delete reuse.resources[0].skp;const recovered=await broker.map(reuse,tags);assert.equal(recovered.brokerSerial,backend.serial+1);assert.equal(recovered.scene.passes[0].quads[0].resourceId,resourceId);assert.equal(JSON.stringify(first.scene),oldScene);await turn();
 progress={acceptedBeforeDenial:accepted,denied,oldDeliveredSerial:first.brokerSerial,gatewayBaselinePublished:true,lastDeliveredSerial:lastDelivered,lastPublishedSerial:lastPublished.brokerSerial,backendAcceptedSerial:backend.serial,recoveredSerial:recovered.brokerSerial,processUnchanged:true,budgetStatus:status.nodeResponses,after:broker.responses.stats(),oldCallerSnapshotIntact:true};
 report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust Broker with explicit1MiB Node response transient quota. A small real SKP maps;larger valid full-scene results are rejected locally before JSON parse,while remote Mapper has already committed. This is response admission failure,not remote transaction rollback. Same process/control status remain usable,caller prior scene is intact,and old SKP hash-only reuse recovers a later serial. No denied-scene pixel or application graph budget claim;default native pixels/45MiB/57.8MB/423rollback gates are separate.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress};
}catch(error){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{await broker.close();assert.equal(broker.responses.stats().owners,0);assert.equal(broker.responses.stats().receivedBackingBytes,0);}
await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,denied:report.denied,backendAcceptedSerial:report.backendAcceptedSerial,recoveredSerial:report.recoveredSerial}));
