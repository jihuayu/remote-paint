import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readlink,writeFile} from 'node:fs/promises';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {payload} from './live-helpers.mjs';

assert.equal(process.platform,'linux');
const output='artifacts/rpc-output',hash=createHash('sha256').update(payload).digest('hex'),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
await mkdir(output,{recursive:true});
function capture(id,bytes=0,picture=true){return {captureId:id,producer:'rpc-output-contract',timing:{padding:'x'.repeat(bytes)},resources:picture?[{localId:1,quadScale:1,width:100,height:100,resourceId:hash,skp:payload.toString('base64')}]:[],viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:picture?'picture':'solid',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1,color:[0.1,0.2,0.3,1]}]}]}};}
function newBroker(bytes){const previous=process.env.REMOTE_PAINT_RPC_OUTPUT_BYTES;if(bytes!==undefined)process.env.REMOTE_PAINT_RPC_OUTPUT_BYTES=String(bytes);try{return new NativeBroker();}finally{if(previous===undefined)delete process.env.REMOTE_PAINT_RPC_OUTPUT_BYTES;else process.env.REMOTE_PAINT_RPC_OUTPUT_BYTES=previous;}}
async function until(check){const end=Date.now()+5000;for(;;){const value=await check();if(value)return value;assert.ok(Date.now()<end,'RPC output fixture deadline');await delay(5);}}
async function quota(){
 const broker=newBroker(1024*1024);let progress;
 try{
  const first=await broker.map(capture('published'),tags),oldScene=JSON.stringify(first.scene),pid=broker.child.pid;
  await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin:'http://127.0.0.1',key:'output-contract-local-only-key',renderer:{},producer:{}}});await broker.request('publish',{serial:first.brokerSerial});
  const before=await broker.request('resourceBudget'),large=capture('denied-delivery',2*1024*1024);delete large.resources[0].skp;let denied;
  await assert.rejects(broker.map(large,tags),error=>{denied={code:error.code,message:error.message};return error.code==='RESOURCE_BUDGET_PRESSURE'&&error.message==='RPC output allocation budget exceeded';});
  const backend=await broker.request('mapperStats'),after=await broker.request('resourceBudget');assert.equal(backend.serial,first.brokerSerial+1,'Delivery admission occurs after remote commit');assert.equal(after.output.data.bytes,0);assert.ok(after.output.data.denied>before.output.data.denied);assert.ok(after.output.data.peak<=after.output.data.limit);assert.equal(after.ready,true);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);assert.equal(JSON.stringify(first.scene),oldScene);
  progress={before,denied,backend,after};const reuse=capture('recovered');delete reuse.resources[0].skp;const recovered=await broker.map(reuse,tags);assert.equal(recovered.brokerSerial,backend.serial+1);assert.equal(recovered.scene.passes[0].quads[0].resourceId,hash);await broker.request('publish',{serial:recovered.brokerSerial});await broker.reset();const cleared=await broker.request('resourceBudget');assert.equal(cleared.output.data.bytes,0);assert.equal(cleared.snapshots.bytes,0);assert.equal(cleared.bytes,0);
  return {quotaBytes:1024*1024,before:before.output,denied,backendCommittedSerial:backend.serial,oldPublishedSerial:first.brokerSerial,recoveredSerial:recovered.brokerSerial,sameProcess:true,publishedBaselineIntact:true,after:after.output,cleared:cleared.output,remoteRollback:false};
 }catch(error){await writeFile(output+'/quota-failed.json',JSON.stringify({at:new Date().toISOString(),error:error.stack,progress},null,2));throw error;}finally{await broker.close();}
}
async function defaultReply(){
 const broker=newBroker();
 try{const mapped=await broker.map(capture('default',2*1024*1024),tags);assert.equal(mapped.native.timing.padding.length,2*1024*1024);assert.equal(mapped.scene.passes[0].quads[0].resourceId,hash);const status=await broker.request('resourceBudget');assert.equal(status.output.data.bytes,0);assert.ok(status.output.data.peak>2*1024*1024);assert.ok(status.output.data.peak<=status.output.data.limit);assert.equal(status.output.data.limit,128*1024*1024);assert.equal(status.output.control.limit,8*1024*1024);assert.equal(status.output.framingBytes,8192);return {metadataBytes:2*1024*1024,status:status.output};}finally{await broker.close();}
}
async function identity(pid){try{const value=await readFile(`/proc/${pid}/stat`,'utf8');return value.slice(value.lastIndexOf(')')+2).trim().split(/\s+/)[19];}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function blockedWrite(close){
 const broker=newBroker();let pending,control;const pid=broker.child.pid,original=await identity(pid);let progress;
 try{
  await broker.request('resourceBudget');await turn();await turn();broker.child.stdout.pause();let settled=false;
  pending=broker.map(capture(close?'blocked-close':'blocked-drain',4*1024*1024,false),tags).then(value=>{settled=true;return value;});pending.catch(()=>{});
  const transport=(await readlink(`/proc/${pid}/fd/1`)).startsWith('socket:')?'unix-socket':'pipe';
  const waitChannel=await until(async()=>{assert.equal(broker.closed,false);const name=(await readFile(`/proc/${pid}/wchan`,'utf8')).trim();const writing=name.includes('pipe_write')||['sock_alloc_send_pskb','unix_stream_sendmsg','unix_stream_sendmsg_locked'].includes(name);return writing&&broker.child.stdout.isPaused()&&broker.child.stdout.readableLength>=broker.child.stdout.readableHighWaterMark?name:false;});assert.equal(settled,false);progress={waitChannel,transport,settled,readableBytes:broker.child.stdout.readableLength};
  if(close){
   const rejected=assert.rejects(pending,/Native Broker closed/);await broker.close();await rejected;assert.equal(broker.child.exitCode,2);assert.equal(broker.exited,true);assert.notEqual(await identity(pid),original);assert.equal(broker.pending.size,0);assert.equal(broker.responses.stats().owners,0);assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.child.stdout.readableLength,0);assert.equal(broker.child.stderr.readableLength,0);
   return {mode:'close-blocked-stdout',waitChannel,transport,childExitCode:broker.child.exitCode,oldProcessIdentityExited:true,parentReadableBytesAfterClose:broker.child.stdout.readableLength,scope:'Actual blocked stdout loses its reader;child exits2 instead of continuing a partial frame. Logical Rust counters are not queried after process exit;OS/process cleanup and separate unit write-owner checks are distinct evidence.'};
  }
  let controlSettled=false;control=broker.request('resourceBudget').then(value=>{controlSettled=true;return value;});control.catch(()=>{});await delay(100);assert.equal(controlSettled,false,'One stdin/stdout RPC FIFO cannot bypass the blocked reply');assert.equal(settled,false);broker.child.stdout.resume();
  const [mapped,status]=await Promise.all([pending,control]);assert.equal(mapped.native.timing.padding.length,4*1024*1024);assert.equal(status.output.data.bytes,0);assert.ok(status.output.data.peak>4*1024*1024);assert.ok(status.output.data.peak<=status.output.data.limit);assert.equal(broker.closed,false);
  return {mode:'drain-blocked-stdout',waitChannel,transport,readableBytesAtBlock:progress.readableBytes,controlWaitsBehindData:true,returnedMetadataBytes:4*1024*1024,afterDrain:status.output,scope:'Actual Linux stdout write blocks while parent pauses reading. Main RPC control remains behind it;after drain,full reply and following control succeed,and output data credit is0. In-block credit ownership is independently checked with the blocking Rust writer unit.'};
 }catch(error){await writeFile(output+`/blocked-${close?'close':'drain'}-failed.json`,JSON.stringify({at:new Date().toISOString(),error:error.stack,progress},null,2));throw error;}
 finally{await broker.close();await Promise.allSettled([pending,control].filter(Boolean));}
}
const report={at:new Date().toISOString(),status:'passed',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),scope:'Actual Linux Rust borrowed RPC replies and shared serialized output packet owners. Explicit1MiB data quota rejects2MiB delivery after Mapper commit,with a small correlated reserved-control error;prior Gateway-published SKP hash recovers on the same process. Default reply,actual blocked stdout drain/FIFO and transport-close exit are separate variants. Not denied-scene pixels,RSS,Node returned graphs or prebuilt Gateway/control Values.',quota:await quota(),defaultReply:await defaultReply(),blockedDrain:await blockedWrite(false),blockedClose:await blockedWrite(true)};
await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,denied:report.quota.denied,backendCommittedSerial:report.quota.backendCommittedSerial,recoveredSerial:report.quota.recoveredSerial,blocked:report.blockedDrain.waitChannel,transportExit:report.blockedClose.childExitCode,parentReadableBytesAfterClose:report.blockedClose.parentReadableBytesAfterClose}));
