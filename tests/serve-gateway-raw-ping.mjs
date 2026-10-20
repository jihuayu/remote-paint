// Owned NET_ADMIN transport diagnostic. Synthetic SKP-header bytes exercise the
// real Rust Gateway; no website capture, CanvasKit or pixel claim is made.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {join,resolve} from 'node:path';
import {NativeBroker} from '../native/broker.mjs';
import {createSessionNetworkProfile} from './session-network-profile.mjs';
assert.equal(process.platform,'linux');
const directory=resolve(process.env.REMOTE_PAINT_RAW_PING_DIR),port=Number(process.env.REMOTE_PAINT_RAW_PING_PORT);assert.ok(Number.isInteger(port)&&port>=1024&&port<65536);await mkdir(directory,{recursive:true});
const exists=async name=>readFile(join(directory,name),'utf8').then(()=>true).catch(error=>{if(error.code==='ENOENT')return false;throw error;}),save=async(name,value)=>{assert.equal(await exists(name),false);const file=join(directory,name);await writeFile(file+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(file+'.tmp',file);};
const broker=new NativeBroker(),network=createSessionNetworkProfile(port),events=[],errors=[],origin='http://127.0.0.1',renderer={name:'actual-Rust-large-raw-ping'},payload=Buffer.alloc(8*1024*1024,37);payload.write('skiapict');const hash=bytes=>createHash('sha256').update(bytes).digest('hex');let failure,networkStart,networkEnd,ticketIssued=false;
broker.on('event',event=>{if(['PeerStats','PeerClosed','PeerReady'].includes(event.event))events.push(event);});broker.on('failure',error=>errors.push(error.message));
try{
 await broker.request('listen',{config:{origin,key:randomBytes(32).toString('hex'),renderer,producer:'raw-ping-fixture',sessionId:'raw-ping-fixture',host:'0.0.0.0',port,input:false,ackTimeout:3000}});
 const rect=[0,0,10,10],captureId='raw-ping-resource',capture={captureId,producer:'raw-ping-fixture',resources:[{localId:1,quadScale:1,width:10,height:10,skp:payload.toString('base64')}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}},metadata={epoch:1,viewportVersion:1,inputSeq:0,captureOrdinal:1,viewport:{cssWidth:10,cssHeight:10,deviceScaleFactor:1}},mapped=await broker.map(capture,metadata);
 await broker.request('publish',{serial:mapped.brokerSerial});networkStart=await network.start();await save('ready.json',{at:new Date().toISOString(),port,origin,renderer,payloadBytes:payload.length,payloadSha256:hash(payload),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER))});
 const until=performance.now()+45000;
 while(!await exists('stop.json')){
  assert.ok(performance.now()<until,'Owned raw-ping fixture exceeded45s');assert.deepEqual(errors,[]);
  if(!ticketIssued&&await exists('ticket-request.json')){ticketIssued=true;const grant=await broker.request('consumerTicket',{kind:'recording',captureOrdinal:1,pageEpoch:1,viewportVersion:1,inputSeq:0});await save('ticket-reply.json',grant);const fresh=await broker.map(capture,{...metadata,captureOrdinal:2});await broker.request('publish',{serial:fresh.brokerSerial});}
  await delay(10);
 }
}catch(error){failure=error.stack;}
finally{
 try{networkEnd=await network.close();}catch(error){failure??=error.stack;}
 try{await broker.close();}catch(error){failure??=error.stack;}
 const cleanup={brokerExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners};try{assert.deepEqual(cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0});}catch(error){failure??=error.stack;}
 await save('source-report.json',{at:new Date().toISOString(),status:failure?'failed':'closed',networkStart,networkEnd,events,errors,cleanup,...(failure?{error:failure}:{})});
}
console.log(JSON.stringify({status:failure?'failed':'closed',error:failure}));if(failure)throw new Error(failure);
