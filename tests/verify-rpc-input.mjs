import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setImmediate as turn} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {payload} from './live-helpers.mjs';

const MiB=1024*1024,binary=process.env.REMOTE_PAINT_BROKER,hash=bytes=>createHash('sha256').update(bytes).digest('hex'),output='artifacts/rpc-input';
assert.equal(process.platform,'linux');await mkdir(output,{recursive:true});
const u32=n=>{const bytes=Buffer.alloc(4);bytes.writeUInt32BE(n);return bytes;};
class RawClient {
 constructor(control=4*MiB,data=MiB){
  this.child=spawn(binary,[],{env:{...process.env,REMOTE_PAINT_RPC_INPUT_BYTES:String(data),REMOTE_PAINT_RPC_CONTROL_BYTES:String(control)},stdio:['pipe','pipe','pipe']});this.done=once(this.child,'close');this.pending=new Map();this.seq=0;this.buffer=Buffer.alloc(0);this.stderr='';
  this.child.stderr.on('data',bytes=>this.stderr=(this.stderr+bytes).slice(-4096));this.child.stdin.on('error',()=>{});
  this.child.stdout.on('data',bytes=>{this.buffer=Buffer.concat([this.buffer,bytes]);while(this.buffer.length>=4){const size=this.buffer.readUInt32BE();if(this.buffer.length<size+4)return;const message=JSON.parse(this.buffer.subarray(4,size+4));this.buffer=this.buffer.length===size+4?Buffer.alloc(0):this.buffer.subarray(size+4);const pending=this.pending.get(message.id);if(pending){this.pending.delete(message.id);clearTimeout(pending.timer);pending.resolve(message);}}});
  this.child.once('close',(code,signal)=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error(`Raw Broker exited ${code??signal}`));}this.pending.clear();});
 }
 expect(id){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`RPC response ${id} exceeded15s`));},15000);this.pending.set(id,{resolve,reject,timer});});}
 write(bytes){return new Promise((resolve,reject)=>this.child.stdin.write(bytes,error=>error?reject(error):resolve()));}
 async text(text,id){const response=this.expect(id),bytes=Buffer.isBuffer(text)?text:Buffer.from(text);response.catch(()=>{});await this.write(u32(bytes.length));await this.write(bytes);return response;}
 async call(op,fields={}){const id=++this.seq;const response=await this.text(JSON.stringify({id,op,...fields}),id);assert.equal(response.error,undefined);return response.result;}
 async oversized(){
  const id=++this.seq,front=Buffer.from('{"padding":"'),back=Buffer.from(`","id":${id},"op":"map"}`),size=90*MiB+1,count=size-front.length-back.length;
  const response=this.expect(id);response.catch(()=>{});await this.write(u32(size));await this.write(front);const chunk=Buffer.alloc(64*1024,120);let left=count;while(left){const n=Math.min(chunk.length,left);await this.write(chunk.subarray(0,n));left-=n;}await this.write(back);
  const following=this.call('mapperStats');const [reply,next]=await Promise.all([response,following]);return {reply,next};
 }
 async close(){this.child.stdin.end();let timer;try{const [code,signal]=await Promise.race([this.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Raw Broker exit exceeded5s')),5000);})]);assert.equal(code,0);assert.equal(signal,null);}finally{clearTimeout(timer);if(this.child.exitCode===null)this.child.kill('SIGKILL');}}
}
const raw=new RawClient(),minimal=new RawClient(256*1024),lateData=new RawClient(256*1024,4*MiB),original=process.env.REMOTE_PAINT_RPC_INPUT_BYTES;process.env.REMOTE_PAINT_RPC_INPUT_BYTES=String(MiB);const broker=new NativeBroker();if(original===undefined)delete process.env.REMOTE_PAINT_RPC_INPUT_BYTES;else process.env.REMOTE_PAINT_RPC_INPUT_BYTES=original;
let progress,report;const rejected=[];
try{
 const baseline=await raw.call('mapperStats'),rawPid=raw.child.pid;
 for(const [label,size]of [['parser-quota',250*1024],['packet-quota',1200*1024]]){
  const id=++raw.seq,text=`{"padding":"${'x'.repeat(size)}","id":${id},"op":"map"}`,reply=await raw.text(text,id);assert.equal(reply.code,'INPUT_BUDGET_PRESSURE');assert.equal(reply.budget,'rust-rpc-input');assert.equal(reply.id,id);rejected.push({label,bytes:Buffer.byteLength(text),code:reply.code});assert.deepEqual(await raw.call('mapperStats'),baseline);
 }
 for(const [label,make]of [
  ['JS-JSON.stringify-lone-high',id=>JSON.stringify({id,op:'send',message:{text:'\ud800'}})],
  ['JS-JSON.stringify-lone-low',id=>JSON.stringify({id,op:'send',message:{text:'\udc00'}})],
  ['malformed-json',id=>`{"id":${id},"op":"send","message":`],
  ['duplicate-op',id=>`{"id":${id},"op":"send","op":"map"}`],
  ['invalid-utf8',id=>Buffer.concat([Buffer.from(`{"id":${id},"op":"send","message":"`),Buffer.from([255]),Buffer.from('"}')])],
  ['depth-limit',id=>`{"id":${id},"op":"map","nested":${'['.repeat(130)}0${']'.repeat(130)}}`],
 ]){
  const id=++raw.seq,reply=await raw.text(make(id),id);assert.equal(reply.id,id);assert.equal(reply.code,'INVALID_REQUEST');rejected.push({label,code:reply.code});assert.deepEqual(await raw.call('mapperStats'),baseline);
 }
 // Real-pipe FIFO framing: a large denied frame with id at its end cannot
 // consume the following valid request, even after90MiB of streaming drain.
 const oversized=await raw.oversized();assert.equal(oversized.reply.code,'INVALID_REQUEST');assert.deepEqual(oversized.next,baseline);assert.deepEqual(await raw.call('mapperStats'),baseline);rejected.push({label:'90MiB+1-streamed-late-id',code:oversized.reply.code});
 const corpus=[];for(let n=0;n<300;n++){
  const id=++raw.seq,padding='x'.repeat(470+n%70),body={nested:[{id:999,op:'map',text:'中文😀\\"[,:]{}'},[n,null,true]],padding},text=n%2?`{"payload":${JSON.stringify(body)},"id":${id},"op":"mapperStats"}`:JSON.stringify({id,op:'mapperStats',payload:body});
  const reply=await raw.text(text,id);assert.equal(reply.error,undefined);assert.deepEqual(reply.result,baseline);corpus.push(Buffer.byteLength(text));
 }
 const deniedNodes=++minimal.seq,wide=JSON.stringify({id:deniedNodes,op:'send',message:{array:Array(3000).fill(0)}}),wideReply=await minimal.text(wide,deniedNodes);assert.equal(wideReply.code,'INPUT_BUDGET_PRESSURE');
 const minStatus=await minimal.call('resourceBudget');assert.equal(minStatus.ready,true);assert.equal(minStatus.rpcInput.control.limit,256*1024);assert.ok(minStatus.rpcInput.control.peak<=minStatus.rpcInput.control.limit);
 const lateId=++lateData.seq,lateReply=await lateData.text(`{"padding":"${'x'.repeat(200*1024)}","id":${lateId},"op":"unknown-data-probe"}`,lateId);assert.equal(lateReply.error,'Unknown broker command');assert.equal(lateReply.code,null);
 const lateStatus=await lateData.call('resourceBudget');assert.ok(lateStatus.rpcInput.control.denied>0,'Did not exercise provisional-control failure');assert.ok(lateStatus.rpcInput.data.peak>MiB&&lateStatus.rpcInput.data.peak<=4*MiB);assert.equal(lateStatus.rpcInput.data.bytes,0);
 const rpcStatus=await raw.call('resourceBudget');assert.equal(rpcStatus.rpcInput.data.bytes,0);assert.ok(rpcStatus.rpcInput.data.denied>=2);assert.ok(rpcStatus.rpcInput.data.peak<=MiB);assert.ok(rpcStatus.rpcInput.control.peak<=4*MiB);assert.equal(raw.child.pid,rawPid);assert.equal(raw.child.exitCode,null);
 const rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}},capture=(id,bytes)=>({captureId:id,producer:'rpc-input-contract',resources:[{localId:1,quadScale:1,width:100,height:100,resourceId:hash(bytes),skp:bytes.toString('base64')}],viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}});
 const first=await broker.map(capture('first',payload),tags),before=await broker.request('mapperStats'),pid=broker.child.pid;
 for(const bytes of [256*1024,2*MiB]){const enlarged=Buffer.concat([payload,Buffer.alloc(bytes,31)]);await assert.rejects(broker.map(capture(`denied-${bytes}`,enlarged),tags),{code:'INPUT_BUDGET_PRESSURE'});assert.deepEqual(await broker.request('mapperStats'),before);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);}
 await assert.rejects(broker.request('send',{message:{text:'\ud800'}}),{code:'INVALID_REQUEST'});assert.deepEqual(await broker.request('mapperStats'),before);assert.equal(broker.closed,false);
 const reuse=capture('reuse',payload);delete reuse.resources[0].skp;const second=await broker.map(reuse,tags);assert.equal(second.brokerSerial,2);assert.deepEqual(second.scene,first.scene);await turn();assert.equal(broker.requestMemory.stats().owners,0);
 progress={rejected,rawProcessUnchanged:true,corpus:{packets:corpus.length,minBytes:Math.min(...corpus),maxBytes:Math.max(...corpus)},rpcStatus:rpcStatus.rpcInput,minimalControlStatus:minStatus.rpcInput,lateDataFallbackStatus:lateStatus.rpcInput,before,after:await broker.request('mapperStats'),firstSerial:first.brokerSerial,reusedSerial:second.brokerSerial};
 report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust stdin RPC with explicit1MiB data quota. Packet/parser pressure,malformed UTF-8/JSON/UTF-16,duplicate envelope fields and depth errors preserve request correlation and exact Mapper state;valid next frames remain usable.90MiB+1 is streamed from fixed64KiB chunks with late id,not allocated as a whole in the verifier. Reserved minimal256KiB control status survives a rejected wide control graph.300 independent Node-generated nested/escaped header-order cases pass. A real small SKP maps,larger requests are denied before Mapper mutation,and old hash-only reuse maps serial2 on the same NativeBroker process. Denied enlarged fixture has no pixel claim;default45MiB/57.8MB and423rollback gates are separate.',brokerSha256:hash(await readFile(binary)),...progress};
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,rejected},null,2));throw error;}
finally{
 const settled=await Promise.allSettled([raw.close(),minimal.close(),lateData.close(),broker.close()]),errors=settled.filter(result=>result.status==='rejected').map(result=>result.reason);
 await writeFile(`${output}/cleanup.json`,JSON.stringify({errors:errors.map(error=>error.stack),rawExitCode:raw.child.exitCode,minimalExitCode:minimal.child.exitCode,lateDataExitCode:lateData.child.exitCode,brokerExited:broker.exited,nodeRequestOwners:broker.requestMemory.stats().owners},null,2));
 if(errors.length)throw new AggregateError(errors,'RPC contract cleanup failed');
 assert.equal(raw.child.exitCode,0);assert.equal(minimal.child.exitCode,0);assert.equal(lateData.child.exitCode,0);assert.equal(broker.exited,true);assert.equal(broker.requestMemory.stats().owners,0);
}
await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,rejections:rejected.length,corpusPackets:report.corpus.packets,firstSerial:report.firstSerial,reusedSerial:report.reusedSerial}));
