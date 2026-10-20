import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';

const output='artifacts/command-queue',previous=process.env.REMOTE_PAINT_COMMAND_QUEUE_BYTES,variants=[],cleanup=[];
let progress;
await mkdir(output,{recursive:true});
async function run(mode){
 const small=mode!=='paired-count',paired=mode!=='fallback-byte';if(small)process.env.REMOTE_PAINT_COMMAND_QUEUE_BYTES=String(64*1024);else delete process.env.REMOTE_PAINT_COMMAND_QUEUE_BYTES;
 const fixtureText='x'.repeat(small?32000:100);const broker=new NativeBroker(),pid=broker.child.pid,events=[],errors=[],sockets=[],origin='http://127.0.0.1',key=randomBytes(32).toString('hex'),renderer={name:'command-queue-fixture'},sessionId='command-queue-fixture';let port;
 broker.on('event',event=>events.push(event));broker.on('failure',error=>errors.push(error.message));
 const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,'Command queue contract deadline');await delay(2);}};
 try{
  ({port}=await broker.request('listen',{config:{renderer,producer:'command-queue-fixture',origin,key,host:'127.0.0.1',port:0,input:true,sessionId}}));
  const data=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${key}`,{origin}),messages=[],sequences=[];let closeCode=null,closeReason=null;sockets.push(data);data.on('error',error=>errors.push(error.message));data.on('close',(code,reason)=>{closeCode=code;closeReason=reason.toString();});data.on('message',(bytes,binary)=>{if(binary)return;const message=JSON.parse(bytes);if(message.type==='Fixture'){assert.equal(message.text,fixtureText);sequences.push(message.seq);}else messages.push(message);});
  await once(data,'open');data.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:paired?['control-channel-v1']:[]}));await until(()=>messages.some(message=>message.type==='Welcome'));
  const welcome=messages.find(message=>message.type==='Welcome');if(paired)assert.ok(welcome.control.ticket);const message={type:'Fixture',text:fixtureText,seq:0};let accepted=0,transportPressure=null;
  progress={mode,stage:'enqueue',accepted,paired,normalBytes:null};
  if(mode==='paired-byte'){
   await broker.request('send',{peerId:welcome.peerId,message});accepted++;progress.accepted=accepted;progress.stage='expect-byte-pressure';
   await assert.rejects(broker.request('send',{peerId:welcome.peerId,message:{...message,seq:1}}),error=>error.code==='RESOURCE_BUDGET_PRESSURE');
  }else if(mode==='paired-count'){
   for(let n=0;n<64;n++){await broker.request('send',{peerId:welcome.peerId,message:{...message,seq:n}});accepted++;}progress.accepted=accepted;progress.stage='expect-count-pressure';
   await assert.rejects(broker.request('send',{peerId:welcome.peerId,message:{...message,seq:64}}),/Native control queue full/);
  }else{
   data._socket.pause();let denied=false;const fixed=2*8192,end=Date.now()+5000;
   const socketQueue=async()=>{
    const rows=(await readFile(`/proc/${pid}/net/tcp`,'utf8')).trim().split('\n').slice(1);
    for(const row of rows){const fields=row.trim().split(/\s+/);if(parseInt(fields[1].split(':')[1],16)===port&&parseInt(fields[2].split(':')[1],16)===data._socket.localPort)return {sendBytes:parseInt(fields[4].split(':')[0],16),state:fields[3]};}
    throw new Error('Native TCP peer disappeared during pressure probe');
   };
   for(let attempt=0;attempt<256;attempt++){
    assert.ok(Date.now()<end,'Native command backpressure deadline');
    try{await broker.request('send',{peerId:welcome.peerId,message:{...message,seq:accepted}});accepted++;progress.accepted=accepted;await delay(3);}
    catch(error){
     assert.equal(error.code,'RESOURCE_BUDGET_PRESSURE');const before=await socketQueue();
     if(accepted>=2&&before.sendBytes>0){
      await delay(50);const after=await socketQueue(),stats=await broker.request('resourceBudget');
      if(after.sendBytes>0&&stats.commands.normal.bytes>fixed){transportPressure={before,after,observationMs:50,queuedCommandBytes:stats.commands.normal.bytes-fixed,parentPaused:data._socket.isPaused(),parentReadableBytes:data._socket.readableLength};denied=true;break;}
     }
     await delay(3);
    }
   }
   assert.equal(denied,true,'Paused real socket did not retain a command while native TX stayed queued');
  }
  const held=await broker.request('resourceBudget');assert.ok(held.commands,'Missing outgoing command ledger');assert.ok(held.commands.normal.bytes>0);assert.ok(held.commands.normal.peak<=held.commands.normal.limit);assert.equal(held.commands.close.bytes,0);if(small)assert.ok(held.commands.normal.denied>0);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);progress.normalBytes=held.commands.normal.bytes;progress.stage='close-full-queue';
  await broker.request('send',{peerId:welcome.peerId,message:{type:'$close',code:1001,reason:'queue contract close'}});if(!paired)data._socket.resume();await until(()=>closeCode!==null);assert.equal(closeCode,1001);assert.equal(closeReason,'queue contract close');
  await until(()=>events.some(event=>event.event==='PeerClosed'&&event.peerId===welcome.peerId));let released;const end=Date.now()+5000;
  do{released=await broker.request('resourceBudget');if(released.commands.normal.bytes===0&&released.commands.close.bytes===0)break;assert.ok(Date.now()<end,'Closed peer retained command owners');await delay(2);}while(true);
  assert.equal(released.ready,true);assert.equal(released.commands.normal.allocations,0);assert.equal(released.commands.close.allocations,0);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);
  // Missing peers keep the existing no-op success,including a now oversized
  // message;there is no queue or packet allocation for this stale recipient.
  assert.equal(await broker.request('send',{peerId:welcome.peerId,message:{text:'x'.repeat(40*1024)}}),true);
  assert.deepEqual(sequences,sequences.map((_,i)=>i));assert.deepEqual(errors,[]);variants.push({mode,paired,accepted,receivedBeforeClose:sequences.length,closeCode,closeReason,closeDeliveredAfterNormalPressure:true,transportPressure,held:held.commands,released:released.commands,brokerPidUnchanged:true,stalePeerNoop:true});await broker.request('stop');
 }finally{
  for(const socket of sockets)socket.terminate();await broker.close();const released={mode,childExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners,stdoutBytes:broker.child.stdout.readableLength,stderrBytes:broker.child.stderr.readableLength};cleanup.push(released);assert.deepEqual(released,{mode,childExited:true,pending:0,requestOwners:0,responseOwners:0,stdoutBytes:0,stderrBytes:0});
 }
}
try{
 for(const mode of ['paired-byte','fallback-byte','paired-count'])await run(mode);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust outgoing command packet/mailbox ownership. Unattached paired control under explicit64KiB quota retains exactly owned text and rejects another body;paused real fallback socket eventually fills byte credit;64-slot paired queue rejects its65th normal packet. Independent priority close succeeds in every case,data receives requested1001/reason,all packet/close/mailbox owners release and same Broker control remains usable. Missing peer remains a no-op. No CDP/pixel,OS buffer/Tungstenite copy or RSS claim.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants,cleanup};
 await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,variants,cleanup},null,2));throw error;}
finally{if(previous===undefined)delete process.env.REMOTE_PAINT_COMMAND_QUEUE_BYTES;else process.env.REMOTE_PAINT_COMMAND_QUEUE_BYTES=previous;}
