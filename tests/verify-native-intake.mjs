// Conformance for the production native intake's denial/retirement paths.
// Positive autonomous capture/Mapper publication is verified separately.
import assert from 'node:assert/strict';
import net from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
const output=process.env.REMOTE_PAINT_INTAKE_OUTPUT??'artifacts/native-intake';
await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-intake-');await chmod(directory,0o700);
const brokers=[],sockets=[],checks=[],events=[];let failure;
const scope=()=>randomBytes(16).toString('hex');
const config=(id,ordinalBase)=>({id,ordinalBase,ordinalLimit:ordinalBase+7,generation:1,pageEpoch:1,viewportVersion:1,inputSeq:0,cssWidth:100,cssHeight:100,host:2,minimumSourceFrame:0});
const metadata=(c,n)=>({captureId:`${c.id}:${n}`,producer:'7:2',frameToken:1,sourceFrame:0,resources:[],resourcesComplete:true,nativeResources:true,subscription:{version:1,id:c.id,generation:1,captureOrdinal:n,pageEpoch:1,viewportVersion:1,inputSeq:0,cssWidth:100,cssHeight:100}});
const rpa=m=>{const parts=[Buffer.from('RPA2\x01\x01')];for(const s of [m.captureId,JSON.stringify(m)]){const b=Buffer.from(s),h=Buffer.alloc(4);h.writeUInt32BE(b.length);parts.push(h,b);}parts.push(Buffer.alloc(4));return Buffer.concat(parts);};
function rvb(id,width){const out=[];const u8=n=>out.push(Buffer.from([n]));const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);out.push(b);};const f64=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);out.push(b);};const text=s=>{const b=Buffer.from(s);u32(b.length);out.push(b);};out.push(Buffer.from('RVB2\x01\x01'));text(id);u32(1);u32(2);u32(1);text('root');[0,0,width,100].forEach(f64);u32(0);u8(0);return Buffer.concat(out);}
const credit=(c,n,outcome=3)=>{const b=Buffer.alloc(56);b.write('RPC3');b[4]=1;b[5]=outcome;Buffer.from(c.id).copy(b,8);b.writeBigUInt64BE(BigInt(n),40);b.writeBigUInt64BE(1n,48);return b;};
const until=async(check,label)=>{const end=Date.now()+4000;while(!await check()){assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(5);}};
async function listen(label){const broker=new NativeBroker();brokers.push(broker);broker.on('event',event=>{events.push({label,...event});assert.ok(events.length<128);});const path=`${directory}/${label}.sock`;await broker.request('listenViz',{path});return {broker,path,label};}
async function connect(path){const socket=net.createConnection(path);sockets.push(socket);socket.on('error',()=>{});await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});let bytes=Buffer.alloc(0);socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);assert.ok(bytes.length<=56*8);});return {socket,get bytes(){return bytes;},async send(p){const h=Buffer.alloc(4);h.writeUInt32BE(p.length);await new Promise((resolve,reject)=>socket.write(Buffer.concat([h,p]),e=>e?reject(e):resolve()));},async expect(c,n){await until(()=>bytes.length>=56,'exact native credit');assert.deepEqual(bytes.subarray(0,56),credit(c,n));bytes=bytes.subarray(56);}};}
try{
 const first=await listen('first'),second=await listen('second'),raw=await connect(first.path),other=await connect(second.path);
 const c=config(scope(),0),unauthorized=metadata(c,1);unauthorized.padding='x'.repeat(512*1024);
 await raw.send(rpa(unauthorized));await other.send(rpa(unauthorized));
 await until(()=>events.filter(e=>e.event==='VizRejected'&&e.captureId===unauthorized.captureId).length===2,'cross-source unknown rejection');
 for(const x of [first,second]){const input=await x.broker.request('inputBudget');assert.equal(input.peak,0);assert.equal(input.bytes,0);}
 assert.equal(raw.bytes.length,0);assert.equal(other.bytes.length,0);checks.push('unknown/cross-source512KiB packets denied before payload/JSON admission');
 const configs=[c,...[8,16,24].map(base=>config(scope(),base))];
 for(const c of configs)assert.equal((await first.broker.request('registerNative',{config:c})).enabled,true);
 await assert.rejects(()=>first.broker.request('registerNative',{config:config(scope(),32)}),/admission limit/);
 for(const c of configs)await first.broker.request('cancelNative',{scopeId:c.id});
 assert.equal((await first.broker.request('nativeState')).registered,0);checks.push('four fixed scopes,full-capacity denial,explicit cancellation');
 const current=config(scope(),32);await first.broker.request('registerNative',{config:current});
 const malformed=metadata(current,33);malformed.subscription.inputSeq=1;
 await raw.send(rpa(malformed));await raw.expect(current,33);
 await until(()=>events.some(e=>e.event==='NativeFrameRejected'&&e.captureId===malformed.captureId&&e.outcome==='pause'),'unacknowledged input rejection');
 assert.equal((await first.broker.request('nativeState')).lastPublishedOrdinal,0);
 await first.broker.request('cancelNative',{scopeId:current.id});checks.push('unacknowledged input cannot receive successful native credit');
 const geometry=config(scope(),40);await first.broker.request('registerNative',{config:geometry});
 const scene=await connect(first.path);await scene.send(rvb(`${geometry.id}:41`,101));await raw.send(rpa(metadata(geometry,41)));await raw.expect(geometry,41);
 await until(()=>events.some(e=>e.event==='NativeFrameRejected'&&e.captureId===`${geometry.id}:41`&&e.code==='NATIVE_SUBSCRIPTION_TARGET_CHANGED'),'independent aggregate root fence');
 assert.equal((await first.broker.request('nativeState')).lastPublishedOrdinal,0);
 await first.broker.request('cancelNative',{scopeId:geometry.id});checks.push('aggregate101px root rejected for100px native context in either packet order');
 const encodedError=config(scope(),48);await first.broker.request('registerNative',{config:encodedError});
 const error=metadata(encodedError,49);delete error.resources;error.error='Native canvas pixel pool pressure';error.code='RESOURCE_BUDGET_PRESSURE';
 await raw.send(rpa(error));await raw.expect(encodedError,49);
 await until(()=>events.some(e=>e.event==='NativeFrameRejected'&&e.captureId===error.captureId&&e.code==='RESOURCE_BUDGET_PRESSURE'),'typed native encoding pressure');
 await first.broker.request('cancelNative',{scopeId:encodedError.id});checks.push('typed native encoding failure without descriptors is retired with Pause');
 const canceled=config(scope(),56);await first.broker.request('registerNative',{config:canceled});await first.broker.request('cancelNative',{scopeId:canceled.id});
 const before=await first.broker.request('inputBudget'),late=metadata(canceled,57);late.padding='x'.repeat(512*1024);
 await raw.send(rpa(late));await raw.expect(canceled,57);const after=await first.broker.request('inputBudget');
 assert.equal(after.peak,before.peak);assert.equal(after.bytes,32768);assert.equal((await first.broker.request('nativeState')).inflight,0);
 checks.push('late canceled512KiB frame gets exact Pause without new parser/resource owners');
 assert.ok(!events.some(e=>e.event==='NativeFrame'));assert.equal((await first.broker.request('nativeState')).lastPublishedOrdinal,0);
}catch(e){failure=e.stack;}
finally{for(const socket of sockets)socket.destroy();for(const broker of brokers)await broker.close().catch(e=>{failure??=e.stack;});await rm(directory,{recursive:true,force:true});}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual private Broker process/RPC/Unix socket native authorization,context/root andretirement conformance;synthetic payloads,not Chromium pixel/autonomousSource acceptance.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),checks,events,cleanup:brokers.map(b=>({exited:b.exited,pending:b.pending.size,request:b.requestMemory.stats(),response:b.responses.memory.stats()})),...(failure?{error:failure}:{})};
await writeFile(`${output}/${failure?'failed':'contract'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,error:failure}));if(failure)process.exitCode=1;
